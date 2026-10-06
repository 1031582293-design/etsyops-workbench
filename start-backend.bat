@echo off
chcp 65001 >nul
REM ============================================================
REM  EtsyOps backend one-click launcher for Windows
REM  Requires: Node.js + cloudflared + .env + tunnel-token.txt
REM ============================================================
cd /d %~dp0

echo [1/3] 检查并更新代码（git pull 最新）...
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
echo [2/3] 启动 Node 后端（server.js :3000）...
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
echo [3/3] Cloudflare Tunnel 检查...
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

REM ---- 第 3 步：先杀掉残留的旧隧道，避免多实例抢同一域名 ----
REM 同一个 Cloudflare 域名挂了多个 connector 时，Cloudflare 会轮询转发，
REM 于是同一个 URL 有时是新代码有时是旧代码，表现为「刚修好的问题又复现」。
taskkill /fi "WINDOWTITLE eq EtsyOps-Tunnel" /f /t >nul 2>nul

REM ---- 第 4 步：启动隧道 ----
echo   [提示] 正在启动隧道（窗口标题：EtsyOps-Tunnel）...
REM 输出重定向到 tunnel.log：连接失败的真实原因（token 无效/网络不通）会落盘，
REM 不用守着窗口截图。窗口标题保持 EtsyOps-Tunnel，taskkill 与 /min 才有效。
echo.>> tunnel.log
echo ==== 启动 %date% %time% ====>> tunnel.log
start "EtsyOps-Tunnel" /min cmd /c ""%CF_EXE%" tunnel --no-autoupdate run --token %TUNNEL_TOKEN% --url http://localhost:3000 >> tunnel.log 2>&1"

REM ---- 第 5 步：验证它真的起来了 ----
REM 相信「命令返回 0」是没用的（今晚就栽在这）：必须回读 tunnel.log 确认，
REM 只有看到成功注册的痕迹才算就绪。
timeout /t 6 >nul
findstr /C:"Registered tunnel connection" tunnel.log >nul 2>nul
if errorlevel 1 goto tunnelFail

REM 多实例提醒：上面的 taskkill 只杀窗口标题为 EtsyOps-Tunnel 的（即本脚本启动的）。
REM 此刻手动启动过的隧道窗口标题不同会残留 —— 多个 connector 同挂一个域名时，
REM Cloudflare 会轮询转发 → 同一 URL 有时新代码有时旧代码，表现为「刚修好的问题又复现」。
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
echo        后端本身已启动，但无法被外部访问。
echo.
echo        真正的原因在 tunnel.log 最后几行，请打开看：
echo          notepad tunnel.log
echo.
echo        常见原因：
echo          Invalid tunnel token = tunnel-token.txt 内容不对（多了换行/空格）
echo          Unable to establish  = 网络不通（如需代理才能访问并非 Cloudflare）
echo          cannot find exe        = cloudflared 不在 PATH，请装或用完整路径
echo.
echo        若需手动起（在此目录下打开 PowerShell 窗口）：
echo          $T = (Get-Content .\tunnel-token.txt -Raw).Trim()
echo          cloudflared tunnel --no-autoupdate run --token $T --url http://localhost:3000
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
