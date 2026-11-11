#!/bin/bash
# Builds the macOS (Apple silicon) portable package.
#   scripts/build-portable-mac.sh --version 1.9.0 [--repository owner/repo] [--output dir] [--archive-dir dir] [--skip-build]
# Output: <archive-dir>/pi-web-portable-mac-arm64.zip (+ .sha256). Inside the zip is one
# folder "Pi-Web-Portable" with "Pi Web.command" (double-click to start), app/, runtime/node.
# Must run on macOS arm64: the bundled Node.js and the speech-recognition native module
# are taken from the machine that builds.
set -euo pipefail

SRC="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=""
REPOSITORY="oNa2O2o/Pi-Web-Portable"
OUT="$SRC/portable/dist/mac/Pi-Web-Portable"
ARCHIVE_DIR="$SRC/portable/dist"
SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --repository) REPOSITORY="$2"; shift 2 ;;
    --output) OUT="$2"; shift 2 ;;
    --archive-dir) ARCHIVE_DIR="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "--version x.y.z is required" >&2; exit 2; }
[ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ] || { echo "Build on macOS arm64." >&2; exit 2; }

ASSET="pi-web-portable-mac-arm64.zip"
NODE_BIN="$(command -v node)"
NODE_REAL="$(cd "$(dirname "$NODE_BIN")" && pwd -P)/$(basename "$NODE_BIN")"
STAGE="$SRC/portable/.build-stage-mac"
APP="$STAGE/app"
export NEXT_TELEMETRY_DISABLED=1

need="$(node -p "require('$SRC/package.json').engines.node.replace(/^>=\s*/, '')")"
have="$(node -p 'process.versions.node')"
node -e "const [a,b]=process.argv.slice(1).map(v=>v.split('.').map(Number));for(let i=0;i<3;i++){if(a[i]>b[i])process.exit(0);if(a[i]<b[i])process.exit(1)}" "$have" "$need" \
  || { echo "Node.js $have does not satisfy engines.node >=$need" >&2; exit 2; }

cd "$SRC"
if [ "$SKIP_BUILD" = 1 ]; then
  npm run test:models
else
  NODE_OPTIONS="--max-old-space-size=6144" npm run build:portable
fi
[ -f "$SRC/.next/BUILD_ID" ] || { echo "Production build marker missing" >&2; exit 1; }

rm -rf "$STAGE"
mkdir -p "$APP"
cp package.json package-lock.json next.config.ts "$APP/"
for d in bin scripts public; do rsync -a "$SRC/$d/" "$APP/$d/"; done
# Skip the hashed externals links in .next/node_modules; link-next-externals.mjs
# replaces them with re-export stubs that resolve from app/node_modules.
rsync -a --no-links --exclude /cache --exclude /dev "$SRC/.next/" "$APP/.next/"
(cd "$APP" && npm ci --omit=dev --no-audit --no-fund)
node "$SRC/scripts/link-next-externals.mjs" "$APP" "$SRC/.next/node_modules"

# Browser plugins: voice input (local sherpa-onnx speech recognition) and model quick-add/health.
rsync -a --exclude node_modules --exclude models "$SRC/portable/plugins/" "$APP/plugins/"
(cd "$APP/plugins/server/voice-asr" && npm install --omit=dev --no-audit --no-fund)
[ -d "$APP/plugins/server/voice-asr/node_modules/sherpa-onnx-darwin-arm64" ] || { echo "sherpa-onnx-darwin-arm64 was not installed" >&2; exit 1; }
rm -f "$APP/plugins/server/voice-asr/package-lock.json"

MODEL="sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$MODEL.tar.bz2"
CACHE="$SRC/portable/.voice-cache"
MODEL_FILES="encoder.int8.onnx:908596dcc137a73b95be908ca55e88caa1b3dbbe8027c171615f4b0609c5eb1e
decoder.onnx:a1cbc9eac2d5e3fb6617a218c67ad6daaa7f4e0fd225f08b2c22ab0413c8c257
joiner.int8.onnx:aedb7fa697b2ab43f20499826fff7c997eea7d67db77be97769aeeeb726e63b3
tokens.txt:b818a60878b9aae978cbb8ad594acbd403d76d1af2e31ef4197c84e2dbdba27c
bpe.model:f87a38025a5fdd1e4e9591f6a44bb81295097ce0b80df6f4ab9f44e52c64ca5f
README.md:"
model_ok() {
  local dir="$1" name hash
  while IFS=: read -r name hash; do
    [ -f "$dir/$name" ] || return 1
    if [ -n "$hash" ] && [ "$(shasum -a 256 "$dir/$name" | cut -d' ' -f1)" != "$hash" ]; then return 1; fi
  done <<< "$MODEL_FILES"
}
if ! model_ok "$CACHE/$MODEL"; then
  mkdir -p "$CACHE"
  curl -sSfL --retry 5 -o "$CACHE/$MODEL.tar.bz2" "$MODEL_URL"
  rm -rf "$CACHE/extract" && mkdir -p "$CACHE/extract"
  tar -xjf "$CACHE/$MODEL.tar.bz2" -C "$CACHE/extract"
  model_ok "$CACHE/extract/$MODEL" || { echo "Voice model failed SHA256 verification" >&2; exit 1; }
  rm -rf "$CACHE/$MODEL" && mkdir -p "$CACHE/$MODEL"
  while IFS=: read -r name _; do cp "$CACHE/extract/$MODEL/$name" "$CACHE/$MODEL/"; done <<< "$MODEL_FILES"
  rm -rf "$CACHE/extract" "$CACHE/$MODEL.tar.bz2"
fi
mkdir -p "$APP/plugins/server/voice-asr/models"
cp -R "$CACHE/$MODEL" "$APP/plugins/server/voice-asr/models/"

mkdir -p "$STAGE/runtime"
cp "$NODE_REAL" "$STAGE/runtime/node"
chmod 755 "$STAGE/runtime/node"
cp "$SRC/portable/mac/Pi Web.command" "$STAGE/Pi Web.command"
chmod 755 "$STAGE/Pi Web.command"

APP_VERSION="$(node -p "require('$SRC/package.json').version")"
cat > "$STAGE/portable-manifest.json" <<EOF
{
  "portableVersion": "$VERSION",
  "appVersion": "$APP_VERSION",
  "repository": "$REPOSITORY",
  "assetName": "$ASSET",
  "autoUpdate": true,
  "updateCheckHours": 6
}
EOF
cat > "$STAGE/README.txt" <<EOF
Pi Web Portable $VERSION for macOS (Apple silicon)
Pi Web $APP_VERSION, Node.js $(node -p 'process.versions.node')

启动：双击「Pi Web.command」。第一次打开如果提示“无法验证开发者”，
在 Finder 里右键「Pi Web.command」→ 打开 → 打开；或者到 系统设置 → 隐私与安全性 里点「仍要打开」。
启动后浏览器打开 http://127.0.0.1:30141/ ，关闭终端窗口不影响运行。

停止：在终端执行  "./Pi Web.command" --stop
重启：Pi Web 左上角的「重启」按钮，或  "./Pi Web.command" --restart
换端口：PI_WEB_PORT=30142 "./Pi Web.command"

数据（会话、模型、设置）在 ~/.pi/agent，和本文件夹无关；更新时下载新版替换本文件夹即可。
日志在 logs/。
EOF

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")" "$ARCHIVE_DIR"
mv "$STAGE" "$OUT"
ZIP="$ARCHIVE_DIR/$ASSET"
rm -f "$ZIP" "$ZIP.sha256"
(cd "$(dirname "$OUT")" && /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$(basename "$OUT")" "$ZIP")
echo "$(shasum -a 256 "$ZIP" | cut -d' ' -f1)  $ASSET" > "$ZIP.sha256"
echo "Built $ZIP ($(du -h "$ZIP" | cut -f1))"
