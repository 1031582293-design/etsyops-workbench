@echo off
chcp 65001 >nul
REM ★ 延迟展开：配置预检的 for 循环内要用 !VAR! 读当前迭代的值。
REM   没有这行时 !K! 会被当字面量，循环里的判断全部静默失效。
setlocal enabledelayedexpansion
REM ============================================================
REM  EtsyOps backend one-click launcher for Windows
REM  Requires: Node.js + cloudflared + .env + tunnel-token.txt
REM ============================================================
cd /d %~dp0

echo [1/4] 检查并更新代码（git pull 最新）...
if not exist .git goto nonGit
git pull 2>nul
if errorlevel 1 (
  echo   [提示] origin 拉取失败，尝试镜像 gitee…
  git pull https://gitee.com/fu-po-fa-cai/etsyops-workbench.git main 2>nul
  if errorlevel 1 goto pullFail
  echo   [ok] 已从 gitee 镜像更新
)
echo   [ok] 代码已是最新
goto step2

:nonGit
echo   [提示] 非 git 仓库，如需更新请重新下载 ZIP 覆盖
goto step2

:pullFail
echo   [警告] 自动更新失败 —— 本次运行的是本地已有代码，不是最新版！
echo          若你刚改过代码并以为已生效，并没有生效。
echo   [提示] 可能是离线或无权限。可手动执行 git pull查看真实原因。

:step2
echo [2/4] 检查配置（.env）...
REM ============================================================
REM  配置预检：在启动 Node **之前**检查 .env。
REM  为什么必须前置：配置写错时后端直接崩（外部表现为 502），
REM  而崩溃原因只在 backend.log 里 —— 不预检的话排查链路是
REM  「外部 502 → 扒日志 → 猜是哪行配置错了」，绕一大圈。
REM  （2026-10-07 加：当时加错一行 ETSY_PROXY 导致后端起不来，
REM    现象是 502，启动窗口里什么都看不到。）
REM ============================================================
if not exist .env goto noEnv
set "CFG_WARN="
REM ★ 逐行扫 .env 做格式预检。
REM
REM 【为什么要预检】配置写错时后端直接崩（外部表现为 502），
REM 而崩溃原因只在 backend.log 里，启动窗口什么都看不到。
REM
REM 【三个必须避开的坑 —— 2026-10-07 全部踩过】
REM   坑1「echo 与变量之间必须有空格」：
REM        写 `echo !V!` 会被 cmd 拆成「echo」+「!V!」两截，
REM        后半截被当成命令执行 → 窗口刷出一堆
REM        「xxx is not recognized as an internal or external command」。
REM        正确写法：`echo(!V!` —— 用括号而非空格，值以任意字符开头都安全。
REM   坑 2「不要用 call :trim 子程序」：
REM        call 会另开作用域，delayed expansion 不会回传；
REM        且 %~1 收到的参数仍带引号。这里改为**完全不修改变量**，
REM        只做「有值就必须能通过格式检查」的判断 —— 留空是合法的。
REM   坑 3「格式判定要精确」：
REM        只判前缀 http:// 会把 https://、http://abc 之类一起放行。
REM        用 findstr /R 精确匹配 ^http://数字.数字:数字$。
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
  set "K=%%A"
  if not "!K!"=="" (
    if not "!K:~0,1!"=="#" (
      if "!K!"=="ETSY_PROXY" (
        set "V=%%B"
        if "!V!"=="" (
          echo   [提示] ETSY_PROXY 留空 = Etsy 请求直连
        ) else (
          echo(!V!| findstr /R /X "^http://[0-9][0-9.]*:[0-9][0-9]*$" >nul
          if errorlevel 1 (
            echo   [错误] .env 里 ETSY_PROXY 格式不对，实际读到：!V!
            echo           必须形如^http://127.0.0.1:10080
            echo           注意三点：开头是 http 不是 https；冒号后是端口数字；末尾不要加引号或分号。
            set "CFG_WARN=1"
          ) else (
            echo   [ok] ETSY_PROXY = !V!
          )
        )
      )
    )
  )
)
if defined CFG_WARN goto cfgBad
echo   [ok] 配置格式检查通过
echo [3/4] 启动 Node 后端（server.js :3000）...
where node >nul 2>nul
if errorlevel 1 goto noNode
REM /t 连子进程一起杀干净，否则旧的 node 会残留占着 3000 端口
taskkill /fi "WINDOWTITLE eq EtsyOps-Backend" /f /t >nul 2>nul
REM 输出重定向到 backend.log：进程崩溃的真实原因（uncaughtException 等）会落盘，
REM 不用守着窗口截图。窗口标题仍是 EtsyOps-Backend，taskkill 与 /min 均照旧生效。
echo.>> backend.log
echo ==== 启动 %date% %time% ====>> backend.log
start "EtsyOps-Backend" /min cmd /c "node server.js >> backend.log 2>&1"
echo   [ok] 日志已写入 backend.log，崩溃原因看这个文件

:step3
echo [4/4] Cloudflare Tunnel 检查...
REM ============================================================
REM  设计原则：直接起隧道优先，系统服务只作回退。
REM
REM  为什么不用服务当首选（2026-10-07 凌晨的实际教训）：
REM    服务这条路会静默失败 —— sc query 只要服务已注册就返回 0，
REM    不管它是 RUNNING 还是 STOPPED；net start 的错误又被吞掉。
REM    结果是「启动窗口显示一切正常，外部访问全是 Error 1033」。
REM    实测操作者电脑上服务处于「已禁用」状态（sc start 返回 1058），
REM    而服务化在这里带来的复杂度远大于收益。
REM    直接起隧道只要一个 token + 一个 exe，状态一目了然。
REM ============================================================

REM ---- 第1 步：找到可用的 cloudflared 可执行文件 ----
set "CF_EXE="
where cloudflared >nul 2>nul && set "CF_EXE=cloudflared"
if not defined CF_EXE if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF_EXE=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CF_EXE if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF_EXE=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF_EXE goto noCloudflared

REM ---- 第 2 步：拿 token ----
if not exist tunnel-token.txt goto noToken
set /p TUNNEL_TOKEN=<tunnel-token.txt
REM 去掉可能存在的首尾空格与 CRLF —— token 末尾多一个换行就会鉴权失败，
REM 这是「明明复制对了却提示 token 无效」最常见的原因。
for /f "tokens=* delims= " %%A in ("%TUNNEL_TOKEN%") do set "TUNNEL_TOKEN=%%A"
set "TUNNEL_TOKEN=%TUNNEL_TOKEN: =%"
if not defined TUNNEL_TOKEN goto noToken

REM ---- 第 3 步：杀掉所有残留的 cloudflared，不只是本脚本起的那个 ----
REM 2026-10-13 实战教训：原先只按窗口标题杀（WINDOWTITLE eq EtsyOps-Tunnel），
REM 杀不掉计划任务/服务/手工启动/launchd 拉起的实例。残留实例会「假活」——
REM 进程在、日志里一直重试、但 QUIC 连不上边缘，新起的实例也抢不回域名，
REM 结果就是「重启后端隧道还是不通」。所以这里按映像名全杀，本次启动保证干净。
taskkill /fi "IMAGENAME eq cloudflared.exe" /f >nul 2>nul
timeout /t 2 >nul

REM ---- 第 4 步：启动隧道，最多 3 次，第 3 次降级到 http2 ----
REM 日志先轮转一份再启动：后面验证只看本次的 tunnel.log。
REM 老代码直接 findstr 整个 tunnel.log，会匹配到上一次留下的
REM 「Registered tunnel connection」→ 本次明明没连上却判定成功，这条验证形同虚设。
set "TUNNEL_TRY=0"
set "TUNNEL_OK=0"

:tunnelStart
set /a TUNNEL_TRY+=1
if exist tunnel.log move /y tunnel.log tunnel.log.prev >nul 2>nul
echo.>> tunnel.log
echo ==== 启动尝试 %TUNNEL_TRY% %date% %time% ====>> tunnel.log

if "%TUNNEL_TRY%"=="3" goto tunnelStartHttp2
start "EtsyOps-Tunnel" /min cmd /c ""%CF_EXE%" tunnel --no-autoupdate run --token %TUNNEL_TOKEN% --url http://localhost:3000 >> tunnel.log 2>&1"
goto tunnelAfterStart

:tunnelStartHttp2
echo   [提示] 前两次未连上，第 3 次改用 http2 协议走 TCP 443，穿透性更好...
start "EtsyOps-Tunnel" /min cmd /c ""%CF_EXE%" tunnel --no-autoupdate --protocol http2 run --token %TUNNEL_TOKEN% --url http://localhost:3000 >> tunnel.log 2>&1"

:tunnelAfterStart
echo   [提示] 正在启动隧道（窗口标题：EtsyOps-Tunnel），最多等待 20 秒...

REM ---- 第 5 步：轮询验证本次真的注册成功了 ----
REM 只看本次的 tunnel.log（上一份已轮转走），每 2 秒查一次，最多 10 轮。
REM 不能信「命令返回 0」——start 几乎总是返回 0，那不代表连上了边缘。
set "TUNNEL_WAIT=0"

:tunnelWait
timeout /t 2 >nul
set /a TUNNEL_WAIT+=1
findstr /C:"Registered tunnel connection" tunnel.log >nul 2>nul
if errorlevel 1 goto tunnelNotYet
goto tunnelReady

:tunnelNotYet
if %TUNNEL_WAIT% GEQ 10 goto tunnelKill
goto tunnelWait

:tunnelKill
echo   [警告] 第 %TUNNEL_TRY% 次尝试 20 秒内未连上，杀掉重来...
taskkill /fi "IMAGENAME eq cloudflared.exe" /f >nul 2>nul
timeout /t 2 >nul
if %TUNNEL_TRY% LSS 3 goto tunnelStart
goto tunnelFail

:tunnelReady

REM 多实例检查：启动前已按映像名全杀 cloudflared，正常情况下不会再残留。
REM 若你曾用别的方式手工起过隧道，多 connector 同挂一个域名时 Cloudflare 会轮询转发，
REM 表现为「同一 URL 有时新代码有时旧代码」，即「刚修好的问题又复现」。
echo   [提示] 以后若出现「改完不生效」，打开 /api/etsy/whoami 多刷几次：
echo          hostname 一致 = 单实例；不一致 = 有多个后端在抢这个域名。
echo          手动清残留：taskkill /fi "IMAGENAME eq cloudflared.exe" /f
echo   [ok] 隧道已启动，外部访问地址 https://api.mailili-agency.com
goto tunnelDone

:tunnelDone

echo.
echo 后端已启动。团队访问 https://etsyops-workbench.pages.dev 即可真实发布。
echo 关闭这两个最小化窗口会停止服务。
echo [tip] IP whitelist: open tunnel-url/api/wechat/ip, add that IP to WeChat MP whitelist.
pause
exit /b 0

:tunnelFail
echo.
echo [错误] 隧道启动失败，外部访问会报 Error 1033。
echo        已自动重试 3 次（第 3 次已降级为 http2 协议），仍未注册成功。
echo        后端本身已启动，但无法被外部访问。
echo.
echo        真正的原因在 tunnel.log 最后几行，请打开看：
echo          notepad tunnel.log
echo.
echo        常见原因：
echo          Invalid tunnel token = tunnel-token.txt 内容不对（多了换行/空格）
echo          failed to dial        = 网络不通，或 UDP/QUIC 被拦截（http2 也已试过）
echo          cannot find exe        = cloudflared 不在 PATH，请装或用完整路径
echo.
echo        若需手动起（在此目录下打开 PowerShell 窗口）：
echo          $T = (Get-Content .\tunnel-token.txt -Raw).Trim()
echo          cloudflared tunnel --no-autoupdate run --token $T --url http://localhost:3000
pause
exit /b 1

:cfgBad
echo.
echo 请修改后重新双击本文件。
pause
exit /b 1

:noEnv
echo [错误] 找不到 .env，无法启动。
echo.
echo 这个文件必须在当前目录下，内容至少包含：
echo   WECHAT_APPID / WECHAT_APPSECRET
echo   AI_API_KEY / AI_BASE_URL / AI_MODEL
echo   ETSY_KEYSTRING / ETSY_SHARED_SECRET / ETSY_REDIRECT_URI
echo 它含密钥，不要发给别人。
pause
exit /b 1

:noNode
echo [错误] 未找到 node，请先安装 Node.js 并加入 PATH
pause
exit /b 1

:noCloudflared
echo [错误] 未找到 cloudflared，请先安装后重试
pause
exit /b 1

:noToken
echo [错误] 未找到 tunnel-token.txt
echo 请在 Cloudflare Zero Trust 创建 Tunnel，复制命令里的 token 整串，
echo 单独存入本目录 tunnel-token.txt，然后重跑本脚本。
pause
exit /b 1
