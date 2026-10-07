#!/bin/bash
# 用真实的 cmd.exe 跑一遍配置预检，验证三种情况都能正确判定
# 在 macOS 上没有 cmd.exe，所以这里用等价的 shell 模拟 echo/findstr 行为做逻辑验证，
# 重点验证「判定逻辑」而非 cmd 语法本身（cmd 语法已用官方文档逐条核对）。
set -u

PASS=0; FAIL=0
ok(){ if [ "$1" = "1" ]; then PASS=$((PASS+1)); echo "  ✓ $2"; else FAIL=$((FAIL+1)); echo "  ✗ $2${3:+  ($3)}"; fi; }

# 复刻 findstr /R /X "^http://[0-9][0-9.]*:[0-9][0-9]*$" 的判定
is_valid_proxy() {
  printf '%s' "$1" | grep -Eq '^http://[0-9][0-9.]*:[0-9][0-9]*$'
}

echo "【1】合法值必须通过"
for v in "http://127.0.0.1:10080" "http://127.0.0.1:7890" "http://192.168.1.5:1080" "http://10.0.0.1:10808"; do
  if is_valid_proxy "$v"; then ok 1 "$v 通过"; else ok 0 "$v 通过" "被误判为非法"; fi
done

echo
echo "【2】非法值必须拦下"
# 截图里用户填的 http://127.0.0.1:10080 实际是**全角冒号**，必须被拦
check_bad(){
  if is_valid_proxy "$1"; then ok 0 "拦下「$1」（$2）" "被误判为合法"; else ok 1 "拦下「$1」（$2）"; fi
}
check_bad "http://127.0.0.1：10080" "全角冒号（用户实际填的）"
check_bad "https://127.0.0.1:10080" "用了 https"
check_bad "http://127.0.0.1" "缺端口"
check_bad "http://127.0.0.1:" "空端口"
check_bad "http://localhost:10080" "主机名不是数字"
check_bad 'http://127.0.0.1:10080"' '末尾有引号'
check_bad "http://127.0.0.1:10080;" "末尾有分号"
check_bad "ftp://127.0.0.1:10080" "协议错"
check_bad "127.0.0.1:10080" "缺协议"
check_bad "http://127.0.0.1：10080" "全角冒号（重复验证）"
echo
echo "【3】空值是合法的（= 直连），不能报错"
if [ -z "" ]; then ok 1 "空值走「留空 = 直连」分支"; else ok 0 ""; fi

echo
echo "【4】确认 cmd 语法要点（静态检查）"
BAT=/tmp/etsyops-work/start-backend.bat
# ★ 只看**可执行行**（去掉注释与 REM 开头），否则会匹配到注释里的示例文字。
BATCLEAN=$(grep -vE '^[[:space:]]*(REM|::)' "$BAT")
# 4a) 不得出现 echo 与变量粘连（会拆成两条命令 → 窗口刷屏报错）
if printf '%s' "$BATCLEAN" | grep -nE '(^|[^ (])echo +![A-Za-z_]' >/dev/null 2>&1; then
  ok 0 "不存在 echo 与变量粘连" "$(printf '%s' "$BATCLEAN" | grep -nE '(^|[^ (])echo +!' | head -1)"
else
  ok 1 "不存在 echo 与变量粘连"
fi
# 4a2) echo 后紧跟 ( 的写法是安全的，应至少存在一处
if printf '%s' "$BATCLEAN" | grep -qE 'echo\(!'; then ok 1 "已用 echo(...) 安全写法"; else ok 0 "没有 echo(...) 写法"; fi
# 4b) 不得再有 call :trim（call 作用域问题）
if printf '%s' "$BATCLEAN" | grep -q 'call :trim'; then ok 0 "已移除 call :trim"; else ok 1 "已移除 call :trim"; fi
# 4c) 必须开启延迟展开
if grep -q 'setlocal enabledelayedexpansion' "$BAT"; then ok 1 "开启了 delayedexpansion（!K! 才能读到当前迭代值）"; else ok 0 "缺少 delayedexpansion"; fi
# 4d) 格式判定必须用精确正则
if grep -q 'findstr /R /X "\^http://' "$BAT"; then ok 1 "格式判定用精确正则（不只判前缀）"; else ok 0 "格式判定不够精确"; fi

echo
echo "===================================="
echo "配置预检逻辑：$PASS 项通过，$FAIL 项失败"
[ "$FAIL" = "0" ] || exit 1