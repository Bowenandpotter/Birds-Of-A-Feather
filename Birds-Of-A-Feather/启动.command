#!/bin/bash

# ==========================================================================
# Birds Of A Feather —— 一键启动
# --------------------------------------------------------------------------
# 双击这个文件就会：
#   1. 启动本地服务器（带"禁止缓存"的响应头，改完代码刷新就是最新版）
#   2. 自动用 Safari 打开 http://localhost:8000
#
# 停止服务器：在这个窗口里按 Control + C
#
# 如果 macOS 第一次拦住它（提示"无法验证开发者"）：
#   在文件上点右键 →「打开」→ 再点一次「打开」即可，只需一次。
# ==========================================================================

cd "$(dirname "$0")" || exit 1

PORT=8000

# 清屏（在没有 TERM 的环境里不报错）
clear 2>/dev/null || true
echo "=================================================="
echo "   Birds Of A Feather · 本地服务器"
echo "=================================================="
echo

# 端口被占用时先说清楚怎么办，不擅自结束别人的进程
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "⚠️  端口 $PORT 已经被占用了。"
  echo
  echo "通常是上一次的服务器还在运行。两种情况："
  echo
  echo "  1) Safari 里网站还能正常打开"
  echo "     → 什么都不用做，直接用就行。"
  echo
  echo "  2) 打不开，或者你想重新启动"
  echo "     → 把下面这一行复制粘到终端里回车（结束旧的服务器）："
  echo
  echo "         lsof -ti:$PORT | xargs kill"
  echo
  echo "     然后再双击一次这个文件。"
  echo
  read -n 1 -s -r -p "按任意键关闭这个窗口…"
  exit 1
fi

# 1.5 秒后自动打开 Safari（放在后台，不挡住服务器启动）
( sleep 1.5; open -a Safari "http://localhost:$PORT" ) &

# 前台运行服务器：这样按 Control + C 就能停
PORT="$PORT" exec python3 - <<'PY'
import http.server
import os

PORT = int(os.environ.get('PORT', '8000'))


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # 禁止缓存：避免浏览器拿着旧的 JS/CSS 不放，改了代码却看不到效果
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass    # 不打印每个请求，窗口保持干净


print('服务器已启动： http://localhost:' + str(PORT))
print('Safari 应该已经自动打开了。')
print()
print('  · 停止服务器：在这个窗口按 Control + C')
print('  · 改完代码后：回 Safari 按 Command + R 刷新即可（本服务器不缓存，一定是新版）')
print('  · 想关掉这个窗口：先按 Control + C 停止服务器，再关窗口')
print()

http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
PY
