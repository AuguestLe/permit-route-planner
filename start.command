###
 # @Author: wangle
 # @Date: 2026-10-30 20:38:20
 # @LastEditors: error: git config user.name & please set dead value or install git
### 
#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -x "$ROOT/.tools/node-v24.22.2-darwin-arm64/bin/node" ]; then
  PATH="$ROOT/.tools/node-v24.22.2-darwin-arm64/bin:$PATH"
  export PATH
fi
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  printf '%s\n' '需要 Node.js 24 和 npm，请安装后重试。'
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" != '24' ]; then
  printf '%s\n' '此应用需要 Node.js 24。'
  exit 1
fi
if [ ! -d "$ROOT/node_modules" ]; then
  printf '%s\n' '请先在项目目录执行 npm install 安装依赖和本地语言模型。'
  exit 1
fi
# Finder 启动时 PATH 可能不含 Homebrew。
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH
TESSERACT_BIN="${TESSERACT_BIN:-tesseract}"
export TESSERACT_BIN
if ! command -v "$TESSERACT_BIN" >/dev/null 2>&1 || ! "$TESSERACT_BIN" --version >/dev/null 2>&1; then
  printf '%s\n' '需要原生 Tesseract 5。macOS 请先执行 brew install tesseract。' '自定义安装位置可通过 TESSERACT_BIN 指定可执行文件。'
  exit 1
fi
exec npm --prefix "$ROOT" run dev
