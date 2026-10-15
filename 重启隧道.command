#!/bin/bash
# ============================================================
#  重启 Cloudflare 隧道（macOS，双击运行）
#
#  隧道由 launchd 托管（com.etsyops.tunnel），这个文件做两件事：
#    1. 重新注册任务 —— 不只是重启进程，还会重新读取 plist，
#       所以改了 --protocol 之类的参数也不用记命令
#    2. 等一会儿并确认真的连上了 Cloudflare
#
#  用法：双击本文件；或者在终端里 ./重启隧道.command
# ============================================================
cd "$(dirname "$0")"

PLIST="$HOME/Library/LaunchAgents/com.etsyops.tunnel.plist"
LABEL="com.etsyops.tunnel"

printf '\n========================================\n'
printf ' 重启 Cloudflare 隧道  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
printf '========================================\n\n'

if [ ! -f "$PLIST" ]; then
  printf '  [错误] 找不到 %s\n' "$PLIST"
  printf '         说明这台 Mac 还没装 launchd 守护，请先按 SETUP-SUMMARY.md 装一次。\n'
  printf '\n按任意键关闭...'
  read -n 1 -s -r
  exit 1
fi

# 用 bootout + bootstrap 而不是 kickstart：
#   kickstart -k 用的是「已加载的旧配置」，改了 plist 不生效；
#   bootout + bootstrap 会重新读 plist 文件，改什么都不会漏。
#
# ⚠️ UID_NUM 用 $(id -u) 而不是 $UID：$UID 是 bash 的内置变量，
#    万一脚本被 /bin/sh（dash）执行它就是空的，于是 "gui/" 变成非法域、
#    bootstrap 静默失败 —— 2026-10-15 双击后隧道没起来就是这么发生的。
UID_NUM=$(id -u)
printf '  [1/2] 重新注册 launchd 任务...\n'
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null
sleep 2

# 不再用 2>/dev/null 吞掉报错：注册失败时必须让用户看到 launchctl 的真实原因
if launchctl bootstrap "gui/$UID_NUM" "$PLIST"; then
  ok_launchd=1
else
  ok_launchd=0
  printf '  [提示] launchd 注册失败（上面是 launchctl 的真实报错）\n'
  printf '         自动改用「直接启动」兜底，保证服务不中断...\n'
  TOKEN=$(tr -d ' \t\n\r' < tunnel-token.txt 2>/dev/null || true)
  if [ -n "$TOKEN" ]; then
    nohup cloudflared tunnel --no-autoupdate --protocol http2 run \
      --token "$TOKEN" --url http://localhost:3000 >> tunnel.log 2>&1 &
    printf '         已直接启动 cloudflared（PID %s），日志同样写 tunnel.log\n' "$!"
  else
    printf '  [错误] 连 tunnel-token.txt 也读不到，无法兜底。\n'
    printf '\n按任意键关闭...'
    read -n 1 -s -r
    exit 1
  fi
fi

# 记住当前日志行数，之后只检查新增部分 ——
# 否则会匹配到上一次留下的 "Registered tunnel connection"，明明没连上却显示成功。
sleep 2
BASE_LINE=$(wc -l < tunnel.log 2>/dev/null | tr -d ' ')
[ -z "$BASE_LINE" ] && BASE_LINE=0

printf '  [2/2] 等待连上 Cloudflare（最多 90 秒；端口 7844 间歇可用，要多试）...\n'
OK=0
i=0
while [ "$i" -lt 45 ]; do
  i=$((i + 1))
  sleep 2
  if tail -n +"$((BASE_LINE + 1))" tunnel.log 2>/dev/null | grep -q "Registered tunnel connection"; then
    OK=1
    break
  fi
  printf '.'
done
printf '\n\n'

if [ "$OK" = "1" ]; then
  printf '  [ok] 隧道已连上，外部访问 https://api.mailili-agency.com\n'
else
  printf '  [提示] 90 秒内还没连上。进程会自己持续重试，通常再等一会儿就通。\n'
  printf '         想看进展：终端里跑  tail -f tunnel.log\n'
fi

printf '\n  最后 5 行日志：\n'
tail -n 5 tunnel.log 2>/dev/null | sed 's/^/     /'
printf '\n按任意键关闭...'
read -n 1 -s -r
printf '\n'
