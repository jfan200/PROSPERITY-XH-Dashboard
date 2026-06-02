#!/bin/bash
# ============================================================
# 餐厅仪表板 — 一键启动脚本
# 用法: bash start.sh
# ============================================================

set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

PORT="${PORT:-3001}"

has_real_taptouch_creds() {
  [ -n "${TAPTOUCH_EMAIL:-}" ] \
    && [ -n "${TAPTOUCH_PASSWORD:-}" ] \
    && [ "${TAPTOUCH_EMAIL}" != "your-email@example.com" ] \
    && [ "${TAPTOUCH_PASSWORD}" != "your-password" ]
}

echo ""
echo "🍜  PROSPERITY XH 仪表板启动中..."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 Node.js，请先安装: https://nodejs.org"
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ 未找到 npm，请重新安装 Node.js LTS"
  exit 1
fi

# 读取本地环境变量（不会提交到 Git）
for env_file in .env .env.local; do
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "./$env_file"
    set +a
  fi
done

PORT="${PORT:-3001}"

# Dashboard 本身不再依赖 npm 包；TapTouch 爬虫才需要 puppeteer-core。
# 如果配置了账号但还没有安装爬虫依赖，尝试安装；失败也不阻止 Dashboard 先跑起来。
if has_real_taptouch_creds && [ ! -d "node_modules/puppeteer-core" ]; then
  echo "📦 安装 TapTouch 爬虫依赖中（不会下载内置 Chromium）..."
  if ! npm install; then
    echo "⚠️  npm install 失败。Dashboard 会继续启动；TapTouch 同步需稍后手动执行 npm install 修复。"
  fi
fi

# 给爬虫一个清晰的 Chrome 提示；不阻止只看 Dashboard。
if [ -z "${TAPTOUCH_BROWSER_EXECUTABLE:-}" ] && [ -z "${PUPPETEER_EXECUTABLE_PATH:-}" ]; then
  if ! command -v google-chrome-stable >/dev/null 2>&1 \
    && ! command -v google-chrome >/dev/null 2>&1 \
    && ! command -v chromium-browser >/dev/null 2>&1 \
    && ! command -v chromium >/dev/null 2>&1 \
    && [ ! -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    echo "⚠️  未检测到 Chrome/Chromium。Dashboard 仍可启动；如需 TapTouch 同步，请安装 Chrome 或设置 TAPTOUCH_BROWSER_EXECUTABLE。"
  fi
fi

# 停止当前项目旧进程，避免占用端口。
pkill -f "[n]ode server.js" 2>/dev/null || true
sleep 1

nohup node server.js > server.log 2>&1 < /dev/null &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true
echo "   Server PID: $SERVER_PID"

# 等待启动
for i in {1..20}; do
  if curl -s "http://localhost:${PORT}/api/status" | grep -q '"ok":true'; then
    echo ""
    echo "✅ 服务器已启动！"
    echo ""
    echo "   📊 仪表板: http://localhost:${PORT}"
    echo "   📋 服务器日志: $DIR/server.log"
    echo ""
    echo "   ⏹  停止服务器: pkill -f '[n]ode server.js'"
    echo ""
    if command -v open >/dev/null 2>&1; then
      open "http://localhost:${PORT}"
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "http://localhost:${PORT}" >/dev/null 2>&1 || true
    fi
    exit 0
  fi
  sleep 0.5
done

echo "❌ 启动失败，查看日志:"
tail -40 server.log
exit 1
