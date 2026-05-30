#!/bin/bash
# ============================================================
# 餐厅仪表板 — 一键启动脚本
# 用法: bash start.sh
# ============================================================

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo ""
echo "🍜  PROSPERITY XH 仪表板启动中..."
echo ""

# 检查 Node.js
if ! command -v node &>/dev/null; then
  echo "❌ 未找到 Node.js，请先安装: https://nodejs.org"
  exit 1
fi

# 读取本地环境变量（不会提交到 Git）
if [ -f ".env.local" ]; then
  set -a
  . ./.env.local
  set +a
fi

# 检查依赖
if [ ! -d "node_modules/express" ]; then
  echo "📦 安装依赖中..."
  npm install express cors puppeteer 2>&1 | tail -3
fi

# 停止旧进程
pkill -f "node server.js" 2>/dev/null
sleep 1

# 后台启动服务器 (尽量与当前 shell 脱离，避免关闭窗口后被回收)
nohup node server.js > server.log 2>&1 < /dev/null &
SERVER_PID=$!
disown "$SERVER_PID" 2>/dev/null || true
echo "   Server PID: $SERVER_PID"

# 等待启动
sleep 2

# 检查是否成功
if curl -s http://localhost:3001/api/status | grep -q '"ok":true'; then
  echo ""
  echo "✅ 服务器已启动！"
  echo ""
  echo "   📊 仪表板: http://localhost:3001"
  echo "   📋 服务器日志: $DIR/server.log"
  echo ""
  echo "   ⏹  停止服务器: pkill -f 'node server.js'"
  echo ""
  # 自动在浏览器中打开
  open http://localhost:3001
else
  echo "❌ 启动失败，查看日志:"
  tail -20 server.log
fi
