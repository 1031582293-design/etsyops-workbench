#!/bin/bash
# EtsyOps 后端 + Cloudflare Tunnel 一键启动（Mac / Linux）
# 用法：./start-mac.sh
set -e
cd "$(dirname "$0")"

# 1) 后台启动 Node 后端（server.js 读 .env 的 WECHAT_APPID/SECRET/API_KEY）
echo "[1/2] 启动 Node 后端 (server.js) …"
nohup node server.js > /tmp/etsyops-backend.log 2>&1 &
echo "     后端 PID: $!  日志: /tmp/etsyops-backend.log"

# 2) 启动 Cloudflare Tunnel（把本地 3000 暴露为公网地址）
#    tunnel-token.txt 由你自己从 Cloudflare Zero Trust 控制台复制而来（已被 .gitignore 忽略）
if [ ! -f tunnel-token.txt ]; then
  echo "❌ 未找到 tunnel-token.txt"
  echo "   请先到 Cloudflare Zero Trust → Networks → Tunnels 创建 tunnel，"
  echo "   把 --token 后面的长串存进本目录的 tunnel-token.txt，再重跑。"
  kill "$!" 2>/dev/null || true
  exit 1
fi
echo "[2/2] 启动 Cloudflare Tunnel …"
echo "     隧道起来后，Zero Trust 控制台会显示稳定地址（即 WECHAT_API_BASE）"
cloudflared tunnel run --no-autoupdate --token "$(cat tunnel-token.txt)" --url http://localhost:3000
