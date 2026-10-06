#!/bin/bash
# ============================================================
#  EtsyOps 后端 + Cloudflare Tunnel 一键启动（macOS）
#  用法：在终端里 cd 到本目录，然后执行  ./start-mac.sh
#  说明：本脚本零依赖，只需 Node.js 与 cloudflared
# ============================================================
set -u
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
LOG="backend.log"
ENV_FILE=".env"

say(){ printf '%s\n' "$*"; }
ok(){ printf '  [ok] %s\n' "$*"; }
warn(){ printf '  [提示] %s\n' "$*"; }
die(){ printf '  [错误] %s\n' "$*"; printf '\n启动中止。\n'; exit 1; }

printf '\n========================================\n'
printf ' EtsyOps 后端启动  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
printf '========================================\n'

# ---------- [1/5] 检查 node ----------
say ""
say "[1/5] 检查 Node.js…"
if ! command -v node >/dev/null 2>&1; then
  die "没找到 node。
  安装方法（推荐用 Homebrew）：打开终端执行
    /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"
  装完再重新打开终端，跑本脚本。"
fi
ok "node $(node -v)"

# ---------- [2/5] 拉取最新代码 ----------
say ""
say "[2/5] 更新代码（git pull）…"
if [ -d .git ]; then
  # ★ 三个改动，缺一不可（2026-10-06 夜里踩过）：
  #   1) 不再用 2>/dev/null 吞错误 —— 原脚本无论 pull 成没成功都打印「代码已是最新」，
  #      失败时只有一句「可能是离线」，导致以为更新成功了、实际跑的是旧代码，
  #      表现为「刚修好的问题又复现」「报的 not_found 一直不变」，白排查半小时。
  #   2) 记录 pull 前后的 commit，落后就明确警告「本次跑的是旧代码」。
  #   3) pull 失败时把真实原因（存到临时文件再读出来）打出来，便于判断是网络还是鉴权。
  BEFORE=$(git rev-parse --short HEAD 2>/dev/null || echo "?")
  PULL_ERR=""
  GIT_SSH_COMMAND="ssh -i $HOME/.ssh/etsyops_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes" \
    git pull > /tmp/etsyops_pull.log 2>&1 \
  || GIT_SSH_COMMAND="ssh -i $HOME/.ssh/etsyops_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes" \
    git pull https://gitee.com/fu-po-fa-cai/etsyops-workbench.git main >> /tmp/etsyops_pull.log 2>&1 \
  || PULL_ERR=$(tail -3 /tmp/etsyops_pull.log | tr '\n' ' ')

  AFTER=$(git rev-parse --short HEAD 2>/dev/null || echo "?")

  if [ -n "$PULL_ERR" ]; then
    warn "⚠️自动更新失败，本次运行的是本地已有代码（$BEFORE）"
    warn "   原因：$PULL_ERR"
    warn "   若你刚改了代码并以为已生效——并没有，请检查网络后重跑本脚本。"
  elif [ "$BEFORE" != "$AFTER" ]; then
    ok "代码已更新 $BEFORE → $AFTER"
  else
    ok "代码已是最新（$AFTER）"
  fi
  rm -f /tmp/etsyops_pull.log 2>/dev/null || true
else
  warn "非 git 目录，跳过更新"
fi

# ---------- [3/5] 检查配置 ----------
say ""
say "[3/5] 检查配置…"
if [ ! -f "$ENV_FILE" ]; then
  die "没找到 $ENV_FILE 。
  它是存微信/AI 凭证的纯文本文件。
  最省事的做法：让操作者把 Windows 上 etsyops 目录里的 .env 复制到 Mac 的这个目录。
  格式大致如下（把等号后面换成真实值）：
    WECHAT_APPID=wx1234567890abcdef
    WECHAT_APPSECRET=你的AppSecret
    WECHAT_AUTHOR=梦琦Mengqi
    AI_API_KEY=智谱或DeepSeek的key
    AI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
    AI_MODEL=glm-4-flash-250414
    AI_IMAGE_MODEL=cogview-3-flash
  注意：这文件含密钥，不要发到聊天或提交进git（.gitignore 已忽略它）。"
fi
MISS=""
for k in WECHAT_APPID WECHAT_APPSECRET AI_API_KEY AI_BASE_URL AI_MODEL; do
  grep -qE "^${k}=" "$ENV_FILE" || MISS="$MISS $k"
done
if [ -n "$MISS" ]; then
  warn "$ENV_FILE 里缺少这些配置：$MISS"
  warn "缺少 AI_* 会导致生稿/生图不可用；缺少 WECHAT_* 会导致无法写入公众号草稿箱。"
else
  ok "配置齐全（凭证内容不回显）"
fi

# ---------- [4/5] 停掉旧进程 + 启动后端 ----------
say ""
say "[4/5] 启动后端（端口 ${PORT}）…"
# 结束本目录上旧的 server.js（先试 lsof，失败再用 pkill 兜底）
if command -v lsof >/dev/null 2>&1; then
  OLD=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
  if [ -n "$OLD" ]; then
    kill $OLD 2>/dev/null || true
    sleep 1
    kill -9 $OLD 2>/dev/null || true
    ok "已关闭占用 $PORT 端口的旧进程"
  else
    ok "${PORT} 端口干净，无需清理"
  fi
fi
# ⚠️ 不要再用 pkill -f 匹配绝对路径来杀旧后端：
#   模式 "node .*/abs/path/server.js" 会把**刚启动的新进程**也匹配上（命令行同样含该路径），
#   容易把新后端误杀 → 表现为「日志显示启动成功，几秒后进程消失、隧道 connection refused」。
# 只按端口清理，安全可靠。

printf '\n==== 启动 %s ====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
PORT="$PORT" nohup node server.js >> "$LOG" 2>&1 &
NEWPID=$!
# 等 3 秒再确认存活：有些失败是「起来后立刻退出」，只等 2 秒可能漏判
sleep 3

if ! kill -0 "$NEWPID" 2>/dev/null; then
  say ""
  say "—— $LOG 最后 15 行 ——"
  tail -n 15 "$LOG"
  die "后端启动失败，进程已退出。上面是日志内容。"
fi
ok "后端已启动（PID ${NEWPID}），日志写入 $LOG"

# 探活确认真的起来了
for i in 1 2 3 4 5; do
  if curl -s -m 3 "http://127.0.0.1:$PORT/api/ping" >/dev/null 2>&1; then
    ok "自检通过：/api/ping 有响应"
    break
  fi
  sleep 1
  if [ "$i" = "5" ]; then
    warn "5 秒内 /api/ping 没响应。后端可能仍在启动，请稍后开浏览器看右上角状态。"
  fi
done

# ---------- [5/5] Cloudflare 隧道 ----------
say ""
say "[5/5] Cloudflare 隧道…"
if ! command -v cloudflared >/dev/null 2>&1; then
  warn "没找到 cloudflared（跳过隧道）。后端已在本机 $PORT 端口可用。"
  warn "安装：brew install cloudflared"
  printf '\n后端已启动。日志：%s\n按 Ctrl+C 不会停止后端；要停就执行：kill %s\n\n' "$LOG" "$NEWPID"
  exit 0
fi
ok "cloudflared $(cloudflared --version 2>&1 | head -1)"

if [ ! -f tunnel-token.txt ]; then
  warn "没找到 tunnel-token.txt（跳过隧道）。"
  warn "后端已在本机 $PORT 端口可用，可用 http://localhost:$PORT 本地调试。"
  warn "要让公网 api.mailili-agency.com 指向这台Mac，需要这个 token 文件。"
  printf '\n后端已启动。日志：%s\n要停掉后端：kill %s\n\n' "$LOG" "$NEWPID"
  exit 0
fi

TOKEN=$(tr -d ' \t\n\r' < tunnel-token.txt)
if [ -z "$TOKEN" ]; then
  warn "tunnel-token.txt 是空的（跳过隧道）。"
else
  # 先清掉旧隧道，避免越积越多（实测会同时跑两三个，白占连接、日志互相污染）
  if pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    pkill -f "cloudflared tunnel" 2>/dev/null || true
    sleep 2
    ok "已关闭旧隧道进程"
  fi
  # 隧道同样放后台，日志写 tunnel.log
  printf '\n==== 启动 %s ====\n' "$(date '+%Y-%m-%d %H:%M:%S')" >> tunnel.log
  nohup cloudflared tunnel --no-autoupdate run --token "$TOKEN" --url "http://localhost:$PORT" >> tunnel.log 2>&1 &
  TUNPID=$!
  sleep 4
  if kill -0 "$TUNPID" 2>/dev/null; then
    ok "隧道已启动（PID ${TUNPID}），日志 tunnel.log"
  else
    warn "隧道进程已退出，请看 tunnel.log 最后几行。"
    tail -n 10 tunnel.log 2>/dev/null | sed 's/^/    /'
  fi
fi

printf '\n========================================\n'
printf '全部完成。\n'
printf '  后端 PID : %s\n' "$NEWPID"
printf '  本机地址 : http://localhost:%s\n' "$PORT"
printf '  后端日志 : %s\n' "$LOG"
printf '\n  停止后端 : kill %s\n' "$NEWPID"
printf '  查看日志 : tail -f %s\n' "$LOG"
printf '========================================\n\n'
