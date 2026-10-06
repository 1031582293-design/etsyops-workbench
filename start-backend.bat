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
REM ★ sc query 只要「服务已注册」就返回 0，不管它当前是 RUNNING 还是 STOPPED。
REM   原代码据此直接打印「[ok] 隧道已就绪」并跳走，但服务若是 STOPPED/FAILED，
REM   隧道其实压根没跑 —— 外部表现是 Cloudflare Error 1033（Tunnel 无法解析主机），
REM   而启动窗口里却显示一切正常，排查时完全看不出问题（2026-10-07 凌晨实际踩到）。
REM   改为：先看 STATE，只有 RUNNING 才算就绪；否则显式启动并复查。
sc query cloudflared 2>nul | findstr /C:"STATE" >nul 2>nul
if errorlevel 1 goto noSvc

sc query cloudflared 2>nul | findstr /C:"RUNNING" >nul 2>nul
if not errorlevel 1 (
  echo   [ok] cloudflared 服务正在运行，隧道就绪
  goto tunnelDone
)

echo   [提示] cloudflared 服务已安装但未运行，正在尝试启动...
net start cloudflared
if errorlevel 1 (
  echo   [错误] 启动 cloudflared 服务失败。
  echo          这个错误会导致外部访问报 Cloudflare Error 1033。
  echo          请手动检查：服务管理器 - cloudflared - 查看错误信息，
  echo          或在新的命令行窗口手动跑：sc start cloudflared
  goto tunnelFail
)
REM 启动后再确认一次，不信「命令返回码为 0」
timeout /t 2 >nul
sc query cloudflared 2>nul | findstr /C:"RUNNING" >nul 2>nul
if errorlevel 1 (
  echo   [错误] 启动命令返回成功但服务仍未运行
  goto tunnelFail
)
echo   [ok] cloudflared 服务已启动，隧道就绪
goto tunnelDone

:noSvc
where cloudflared >nul 2>nul
if errorlevel 1 goto noCloudflared
if not exist tunnel-token.txt goto noToken
set /p TUNNEL_TOKEN=<tunnel-token.txt
:tunnelDone

echo.
echo 后端已启动。团队访问 https://etsyops-workbench.pages.dev 即可真实发布。
echo 关闭这两个最小化窗口会停止服务。
echo [tip] IP whitelist: open tunnel-url/api/wechat/ip, add that IP to WeChat MP whitelist.
pause
exit /b 0

:tunnelFail
echo.
echo [错误] 隧道未运行，外部访问会报 Error 1033。
echo        后端本身已启动，但无法被外部访问。
echo.
echo        请在新的命令行窗口手动跑这两条，把输出截图发我：
echo          sc query cloudflared
echo          sc start cloudflared
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
