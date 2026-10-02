@echo off
REM ============================================================
REM  EtsyOps 后端一键启动（Windows · 团队操作人电脑）
REM  前提：已安装 Node.js 与 cloudflared，并 clone 本仓库到本地
REM  用法：双击本文件即可（先确保同目录有 .env 与 tunnel-token.txt）
REM ============================================================
cd /d %~dp0

echo [1/3] 检查并更新代码 (git pull 最新, 仅在 git 仓库时执行) ...
if exist .git (
  git pull 2>nul && echo   [ok] 代码已是最新 || echo   [提示] 自动更新失败(可能离线/无权限), 使用本地已有代码继续
) else (
  echo   [提示] 非 git 仓库(用 ZIP 下载的), 如需更新请重新下载 ZIP 覆盖(见操作手册第 12 步)
)

echo [2/3] 启动 Node 后端 (server.js :3000) ...
where node >nul 2>nul || (echo [错误] 未找到 node，请先安装 Node.js 并加入 PATH & pause & exit /b 1)
start "EtsyOps-Backend" /min node server.js

echo [3/3] 启动 Cloudflare Tunnel ...
where cloudflared >nul 2>nul || (echo [错误] 未找到 cloudflared，请先安装(见文档 9.6) & pause & exit /b 1)
if not exist tunnel-token.txt (
  echo [错误] 未找到 tunnel-token.txt
  echo   请在 Cloudflare Zero Trust 创建 Tunnel，复制命令里的 token 整串，
  echo   单独存入本目录 tunnel-token.txt，然后重跑本脚本。
  pause & exit /b 1
)
set /p TUNNEL_TOKEN=<tunnel-token.txt
start "Cloudflare-Tunnel" /min cloudflared tunnel --no-autoupdate --token %TUNNEL_TOKEN% --url http://localhost:3000

echo.
echo 后端已启动。团队访问 https://etsyops-workbench.pages.dev 即可真实发布。
echo （关闭这两个最小化窗口会停止服务）
echo 出口 IP 白名单：浏览器打开 https://^<你的隧道地址^>/api/wechat/ip 拿到 IP，加进公众号后台 IP 白名单。
pause
