#!/bin/zsh
# 生成可以双击打开的「参谋电报机.app」（默认放进 /应用程序）。
# App 里只有一个小入口，实际跑的是本项目文件夹里的代码：改了代码不用重新生成；
# 只有项目文件夹搬了位置、或升级了 Electron 才需要重跑 `npm run app`。
# 注意：每次重新生成签名都会变，麦克风/屏幕录制权限要重新允许一次。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NAME="参谋电报机"
DEST="${1:-/Applications/$NAME.app}"
# 下面会 rm -rf 旧版本，只接受 .app 路径，防止传错把别的目录删了
[[ "$DEST" == *.app && "$ROOT" != "${DEST%/}"* ]] || { echo "目标必须是 xxx.app：$DEST" >&2; exit 1; }
cd "$ROOT"
unset ELECTRON_RUN_AS_NODE
[ -d node_modules/electron/dist/Electron.app ] || npm install

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/$NAME.app"
ditto node_modules/electron/dist/Electron.app "$APP"

# 图标：优先用 scripts/icon.png（1024 透明底，底板按系统规格占中间 824），没有就把 icon.svg 渲染出来
if [ -f scripts/icon.png ]; then cp scripts/icon.png "$WORK/icon.png"
else ./node_modules/.bin/electron scripts/render-icon.js "$WORK/icon.png" >/dev/null 2>&1; fi
SET="$WORK/icon.iconset"; mkdir "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$WORK/icon.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/app.icns"

PL="$APP/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "$1" "$PL"; }
pb "Set :CFBundleName $NAME"
pb "Set :CFBundleDisplayName $NAME"
pb "Set :CFBundleIdentifier local.hoi4-advisor"
pb "Set :CFBundleIconFile app.icns"
pb "Set :LSApplicationCategoryType public.app-category.games"
pb "Set :NSMicrophoneUsageDescription 参谋要用麦克风听你的语音提问。"
pb "Set :NSAudioCaptureUsageDescription 参谋要用麦克风听你的语音提问。"
pb "Delete :LSUIElement" 2>/dev/null || true
pb "Add :LSUIElement bool true"   # 只在菜单栏，不占 Dock

# 入口：名字沿用 hoi4-advisor，数据目录（日志、贴图缓存、语音缓存）和终端启动的共用
mkdir -p "$APP/Contents/Resources/app"
cat > "$APP/Contents/Resources/app/package.json" <<JSON
{ "name": "hoi4-advisor", "version": "$(node -p 'require("./package.json").version')", "main": "index.js" }
JSON
cat > "$APP/Contents/Resources/app/index.js" <<JS
const ROOT = $(node -p 'JSON.stringify(process.argv[1])' "$ROOT");
const fs = require('fs');
if (fs.existsSync(ROOT + '/main.js')) {
  require(ROOT + '/main.js');
} else {
  const { app, dialog } = require('electron');
  app.whenReady().then(() => {
    dialog.showErrorBox('找不到参谋', '项目文件夹不在原来的位置：\n' + ROOT + '\n\n在新位置运行 npm run app 重新生成即可。');
    app.quit();
  });
}
JS

xattr -cr "$APP"
codesign --force --deep --sign - "$APP" 2>/dev/null
codesign --verify --deep "$APP"

pkill -f "$DEST/Contents/MacOS/" 2>/dev/null || true
rm -rf "$DEST"
ditto "$APP" "$DEST"
touch "$DEST"
echo "已生成：$DEST"
