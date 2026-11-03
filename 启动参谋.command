#!/bin/zsh
# 双击启动参谋电报机（启动后可以关掉这个终端窗口，参谋会留在菜单栏）
cd "$(dirname "$0")"
unset ELECTRON_RUN_AS_NODE
[ -d node_modules/electron/dist ] || npm install
(nohup ./node_modules/.bin/electron . >/dev/null 2>&1 &)
echo "参谋已启动，看屏幕右上角菜单栏的「参谋」。"
