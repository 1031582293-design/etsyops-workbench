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
if errorlevel 1 goto pullFail
echo   [ok] 代码已是最新
goto step2

:nonGit
echo   [提示] 非 git 仓库，如需更新请重新下载 ZIP 覆盖
goto step2

:pullFail
echo   [提示] 自动更新失败，可能是离线或无权限，使用本地已有代码继续

:step2
echo [2/3] 启动 Node 后端（server.js :3000）...
where node >nul 2>nul
if errorlevel 1 goto noNode
start "EtsyOps-Backend" /min node server.js

:step3
echo [3/3] 启动 Cloudflare Tunnel...
where cloudflared >nul 2>nul
if errorlevel 1 goto noCloudflared
if not exist tunnel-token.txt goto noToken
set /p TUNNEL_TOKEN=<tunnel-token.txt
start "Cloudflare-Tunnel" /min cloudflared tunnel --no-autoupdate --token %TUNNEL_TOKEN% --url http://localhost:3000

echo.
echo 后端已启动。团队访问 https://etsyops-workbench.pages.dev 即可真实发布。
echo 关闭这两个最小化窗口会停止服务。
echo 出口 IP 白名单：浏览器打开隧道地址下的 /api/wechat/ip 拿到 IP，加进公众号后台白名单。
pause
exit /b 0

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
