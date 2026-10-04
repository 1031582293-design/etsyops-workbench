@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ============================================================
echo  EtsyOps 常驻启动器（server.js + cloudflared 崩溃自动重启）
echo  关闭本窗口 = 停止全部；平时让它一直开着即可
echo ============================================================
echo.

REM ---------- 可选：接电源时禁止系统睡眠（需管理员权限，失败不影响主功能）----------
powercfg -change -standby-timeout-ac 0 >nul 2>&1
powercfg -change -monitor-timeout-ac 0 >nul 2>&1

REM ---------- 1) 拉取最新代码（自动拿到后端每次更新）----------
echo [1/3] 拉取最新代码 git pull ...
git pull
echo.

REM ---------- 2) cloudflared 隧道：独立窗口运行，崩溃自动重连 ----------
REM === 若你平时用的隧道命令不是下面这行，请改成你实际用的（例如带 --url 的临时隧道）===
set "TUNNEL_CMD=cloudflared tunnel run mailili-agency"
echo [2/3] 启动 cloudflared 隧道（独立窗口，崩溃 3 秒后自动重连）...
start "cloudflared-tunnel" cmd /k "echo cloudflared 隧道窗口（勿关） & :tunnelloop & %TUNNEL_CMD% & echo [隧道退出，3 秒后重连...] & timeout /t 3 /nobreak ^>nul & goto tunnelloop"

REM ---------- 3) server.js：崩溃自动重启 ----------
echo [3/3] 启动 server.js（崩溃 3 秒后自动重启）...
:backendloop
echo [%time%] 启动 server.js ...
node server.js
echo [%time%] server.js 已退出，3 秒后自动重启...
timeout /t 3 /nobreak >nul
goto backendloop
