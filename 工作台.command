#!/bin/bash
# ============================================================
#  EtsyOps 工作台总控（macOS，双击运行）
#
#  一个入口做四件事：
#    1) 启动后端 + 隧道
#    2) 只重启隧道
#    3) 只重启后端
#    4) 查看当前状态
#
#  这是 Mac 上唯一的双击入口，原来的「启动后端.command」和
#  「重启隧道.command」已合并进这里（那两个文件已删除）。
#
#  ⚠️ 装了 launchd 守护后，关闭本窗口不会停止服务 ——
#     服务由系统托管，开机自启、崩了自动拉起。
#     想真正停掉：launchctl bootout gui/$(id -u)/com.etsyops.tunnel
# ============================================================
cd "$(dirname "$0")" || exit 1

# 不用 $UID：它是 bash 内置变量，脚本若被 /bin/sh 执行就是空的
UID_NUM=$(id -u)
BACKEND="com.etsyops.backend"
TUNNEL="com.etsyops.tunnel"
PLIST_T="$HOME/Library/LaunchAgents/com.etsyops.tunnel.plist"
PUBLIC="https://api.mailili-agency.com"

hr(){ printf -- '----------------------------------------\n'; }
pause(){ printf '\n按回车键返回菜单…'; read -r; }

has_job(){ launchctl print "gui/$UID_NUM/$1" >/dev/null 2>&1; }

# 等最多 90 秒确认隧道真的注册成功。
# 用「日志行数偏移」只检查本次新增部分，避免匹配到上一次的记录而误判成功。
wait_tunnel(){
  sleep 2
  local base; base=$(wc -l < tunnel.log 2>/dev/null | tr -d ' ')
  [ -z "$base" ] && base=0
  printf '  等待连上 Cloudflare（7844 端口间歇可用，最多等 90 秒）…\n'
  local i=0
  while [ "$i" -lt 45 ]; do
    i=$((i + 1))
    sleep 2
    if tail -n +"$((base + 1))" tunnel.log 2>/dev/null | grep -q "Registered tunnel connection"; then
      printf '\n  [ok] 隧道已连上\n'
      return 0
    fi
    printf '.'
  done
  printf '\n  [提示] 90 秒内还没连上。进程会自己持续重试，稍后用菜单 4 再看。\n'
  return 1
}

# 重新注册隧道：bootout + bootstrap（会重读 plist，改了参数才生效）。
# 注册失败时用直接启动兜底，保证服务不中断 —— 不能再出现「拆了不装」。
reregister_tunnel(){
  launchctl bootout "gui/$UID_NUM/$TUNNEL" 2>/dev/null
  sleep 2
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST_T"; then
    printf '  [ok] 已重新注册 %s\n' "$TUNNEL"
    return 0
  fi
  printf '  [提示] launchd 注册失败（上面是真实报错），改用直接启动兜底…\n'
  local token; token=$(tr -d ' \t\n\r' < tunnel-token.txt 2>/dev/null || true)
  if [ -n "$token" ]; then
    nohup cloudflared tunnel --no-autoupdate --protocol http2 run \
      --token "$token" --url http://localhost:3000 >> tunnel.log 2>&1 &
    printf '  [ok] 已直接启动 cloudflared（PID %s）\n' "$!"
    return 0
  fi
  printf '  [错误] tunnel-token.txt 读不到，无法启动隧道\n'
  return 1
}

show_status(){
  hr
  printf ' 后端  %s\n' "$BACKEND"
  if has_job "$BACKEND"; then
    launchctl print "gui/$UID_NUM/$BACKEND" 2>/dev/null \
      | grep -E "state =|pid =" | sed 's/^/   /'
  else
    printf '   未安装守护（本机无 launchd 任务）\n'
  fi
  printf '   本机探活： %s\n' "$(curl -s -m 3 http://127.0.0.1:3000/api/ping || echo '无响应')"

  hr
  printf ' 隧道  %s\n' "$TUNNEL"
  if has_job "$TUNNEL"; then
    launchctl print "gui/$UID_NUM/$TUNNEL" 2>/dev/null \
      | grep -E "state =|pid =" | sed 's/^/   /'
  else
    printf '   未安装守护（本机无 launchd 任务）\n'
  fi
  printf '   cloudflared 进程： %s\n' "$(pgrep -x cloudflared | tr '\n' ' ' || echo '无')"

  hr
  printf ' 公网  %s\n' "$PUBLIC"
  printf '   /api/ping → HTTP %s\n' "$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$PUBLIC/api/ping")"
  printf '   （200 = 正常；530 = 隧道没连上；000 = 完全没响应）\n'
  hr
}

while true; do
  printf '\n========================================\n'
  printf ' EtsyOps 工作台   %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
  printf '========================================\n'
  printf '  1) 启动后端 + 隧道\n'
  printf '  2) 只重启隧道\n'
  printf '  3) 只重启后端\n'
  printf '  4) 查看当前状态\n'
  printf '  0) 退出\n'
  printf '\n请选择 [0-4]：'
  read -r choice

  case "$choice" in
    1)
      hr; printf ' [1/2] 后端\n'
      if has_job "$BACKEND"; then
        launchctl kickstart -k "gui/$UID_NUM/$BACKEND"
        sleep 3
        if curl -s -m 3 http://127.0.0.1:3000/api/ping >/dev/null 2>&1; then
          printf '  [ok] 后端已启动并响应\n'
        else
          printf '  [提示] 后端刚拉起，稍后用菜单 4 确认\n'
        fi
      else
        printf '  没装守护，改用 start-mac.sh 启动…\n'
        ./start-mac.sh
      fi
      printf ' [2/2] 隧道\n'
      if [ -f "$PLIST_T" ]; then
        reregister_tunnel && wait_tunnel
      else
        printf '  没找到 %s，改用 start-mac.sh 启动…\n' "$PLIST_T"
        ./start-mac.sh
      fi
      ;;
    2)
      hr; printf ' 重启隧道\n'
      if [ -f "$PLIST_T" ]; then
        reregister_tunnel && wait_tunnel
      else
        printf '  [错误] 没找到 %s\n' "$PLIST_T"
      fi
      ;;
    3)
      hr; printf ' 重启后端\n'
      if has_job "$BACKEND"; then
        launchctl kickstart -k "gui/$UID_NUM/$BACKEND"
        sleep 3
        if curl -s -m 3 http://127.0.0.1:3000/api/ping >/dev/null 2>&1; then
          printf '  [ok] 后端已重启并响应\n'
        else
          printf '  [提示] 没响应，看 backend.log 最后 15 行：\n'
          tail -n 15 backend.log 2>/dev/null | sed 's/^/     /'
        fi
      else
        printf '  [错误] 没有 %s 这个守护任务\n' "$BACKEND"
      fi
      ;;
    4)
      show_status
      ;;
    0)
      printf '\n已退出。关闭窗口不会影响服务（服务由系统托管）。\n'
      exit 0
      ;;
    *)
      printf '\n请输入 0 到 4\n'
      ;;
  esac
  pause
done
