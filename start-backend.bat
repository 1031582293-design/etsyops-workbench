@echo off
chcp 65001 >nul
REM * delayed expansion: the config precheck for-loop needs !VAR! to read the current iteration value.
REM   Without it, !K! is treated literally and every check inside the loop silently stops working.
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
REM Config precheck: check .env BEFORE starting Node.
REM Why it must come first: a bad config crashes the backend (shows up as 502 from outside),
REM and the crash reason only lands in backend.log. Without precheck the debugging path is
REM "external 502 -> dig through logs -> guess which line is wrong", a big detour.
REM (added 2026-10-07: one wrong ETSY_PROXY line stopped the backend from starting;
REM  symptom was 502 with nothing visible in the launch window.)
REM ============================================================
if not exist .env goto noEnv
set "CFG_WARN="
REM * Scan .env line by line for format validation.
REM
REM [why precheck] A bad config crashes the backend (502 externally) and the reason is only
REM in backend.log - the launch window shows nothing.
REM
REM [three pitfalls - all hit on 2026-10-07]
REM   Pit 1 "a space is required between echo and the variable":
REM     `echo !V!` gets split by cmd into "echo" + "!V!"; the second half runs as a command,
REM     flooding the window with "xxx is not recognized as an internal or external command".
REM     Correct form: `echo(!V!` - use a paren instead of a space, safe for any leading char.
REM
REM   Pit 2 "do not use a call :trim sub-routine":
REM     call opens a separate scope and delayed expansion does not propagate back;
REM     and %~1 still arrives quoted. So we never modify the variable here - we only check
REM     "if it has a value it must pass the format check". Leaving it empty is legal.
REM   Pit 3 "format checks must be exact":
REM     Checking only the http:// prefix lets https:// and http://abc through.
REM     Use findstr /R with ^http://digits.digits:digits$ instead.
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
REM /t kills child processes too, otherwise the old node lingers holding port 3000.
taskkill /fi "WINDOWTITLE eq EtsyOps-Backend" /f /t >nul 2>nul
REM Redirect output to backend.log so crash reasons (uncaughtException etc.) are captured;
REM no need to watch the window. Title stays EtsyOps-Backend so taskkill and /min still work.
echo.>> backend.log
echo ==== 启动 %date% %time% ====>> backend.log
start "EtsyOps-Backend" /min cmd /c "node server.js >> backend.log 2>&1"
echo   [ok] 日志已写入 backend.log，崩溃原因看这个文件

:step3
echo [4/4] Cloudflare Tunnel 检查...
REM ============================================================
REM  Design: run the tunnel directly; the system service is only a fallback.
REM
REM  Why the service is not the first choice (real lesson, early 2026-10-07):
REM    The service path fails silently - sc query returns 0 as long as the service exists,
REM    whether it is RUNNING or STOPPED, and net start errors get swallowed.
REM    Result: launch window looks fine while external access returns Error 1033.
REM    On the operator machine the service was DISABLED (sc start returned 1058).
REM    A direct tunnel needs only a token + one exe and its state is obvious.
REM (comment translated to English; the full lesson log lives in the knowledge base, not in this repo)
REM ============================================================

REM ---- Step 1: find a usable cloudflared executable ----
set "CF_EXE="
where cloudflared >nul 2>nul && set "CF_EXE=cloudflared"
if not defined CF_EXE if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF_EXE=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CF_EXE if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF_EXE=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF_EXE goto noCloudflared

REM ---- Step 2: read the token ----
if not exist tunnel-token.txt goto noToken
set /p TUNNEL_TOKEN=<tunnel-token.txt
REM Strip leading/trailing spaces and CRLF - a trailing newline in the token fails auth;
REM this is the most common cause of "token looks right but is rejected".
for /f "tokens=* delims= " %%A in ("%TUNNEL_TOKEN%") do set "TUNNEL_TOKEN=%%A"
set "TUNNEL_TOKEN=%TUNNEL_TOKEN: =%"
if not defined TUNNEL_TOKEN goto noToken

REM ---- Step 3: kill ALL leftover cloudflared, not just the one this script started ----
REM 2026-10-13 real failure: the old code only killed by window title, which left instances
REM started by launchd / Task Scheduler / by hand running. Those go "zombie": the process
REM is alive, keeps retrying in the log, but QUIC never reaches the edge, and the new
REM instance cannot win the domain back. So we kill by image name - a clean start every time.
taskkill /fi "IMAGENAME eq cloudflared.exe" /f >nul 2>nul
timeout /t 2 >nul

REM ---- Step 4: start the tunnel, up to 3 tries, 3rd falls back to http2 ----
REM Rotate the log first so verification only ever sees THIS run.
REM The old code ran findstr over the whole tunnel.log and matched the "Registered tunnel
REM connection" line left over from the previous run -> it declared success even when this
set "TUNNEL_TRY=0"
set "TUNNEL_OK=0"

:tunnelStart
set /a TUNNEL_TRY+=1
if exist tunnel.log move /y tunnel.log tunnel.log.prev >nul 2>nul
echo.>> tunnel.log
echo ==== 启动尝试 %TUNNEL_TRY% %date% %time% ====>> tunnel.log

REM 2026-10-13 evidence (operator machine + this Mac): the tunnel's dedicated port 7844 is
REM unreliable on mainland networks. QUIC (UDP 7844) times out completely; http2 (TCP 7844)
REM only connects intermittently - logs show both "dial tcp 198.41.x.x:7844: i/o timeout"
REM and occasional "Registered tunnel connection ... protocol=http2". So go http2 from the
REM first try and wait longer: the window opens at random, patience beats switching protocols.
start "EtsyOps-Tunnel" /min cmd /c ""%CF_EXE%" tunnel --no-autoupdate --protocol http2 run --token %TUNNEL_TOKEN% --url http://localhost:3000 >> tunnel.log 2>&1"

:tunnelAfterStart
echo   [提示] 正在启动隧道（http2 协议），最多等待 60 秒...

REM run never connected, so that check was effectively dead.
REM ---- Step 5: poll until this run is really registered ----
REM Only the rotated-in tunnel.log counts; check every 2s for up to 30 rounds (60s).
REM The window opens at random, so 60s per try and 3 tries gives it a real chance.
set "TUNNEL_WAIT=0"

:tunnelWait
timeout /t 2 >nul
set /a TUNNEL_WAIT+=1
findstr /C:"Registered tunnel connection" tunnel.log >nul 2>nul
if errorlevel 1 goto tunnelNotYet
goto tunnelReady

:tunnelNotYet
if %TUNNEL_WAIT% GEQ 30 goto tunnelKill
goto tunnelWait

:tunnelKill
echo   [警告] 第 %TUNNEL_TRY% 次尝试 60 秒内未连上，杀掉重来...
taskkill /fi "IMAGENAME eq cloudflared.exe" /f >nul 2>nul
timeout /t 2 >nul
if %TUNNEL_TRY% LSS 3 goto tunnelStart
goto tunnelFail

:tunnelReady

REM Multi-instance check: we killed every cloudflared by image name before starting, so
REM normally nothing lingers. If you started a tunnel by other means, several connectors on
REM one domain make Cloudflare round-robin, which looks like "my fix did not take effect".
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
echo        已用 http2 协议自动重试 3 次（每次等 60 秒），仍未注册成功。
echo        后端本身已启动，但无法被外部访问。
echo.
echo        真正的原因在 tunnel.log 最后几行，请打开看：
echo          notepad tunnel.log
echo.
echo        常见原因：
echo          Invalid tunnel token = tunnel-token.txt 内容不对（多了换行/空格）
echo          dial tcp ...:7844: i/o timeout = 到 Cloudflare 边缘的隧道端口不通
echo             （大陆网络常见，TCP 7844 间歇可用，多试几次或换网络）
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
