#!/bin/zsh
# 双击：把参谋电报机的主箱固件烧进主箱那块 XIAO（数据线插在这台 Mac 上）
cd "$(dirname "$0")/firmware"
./flash.sh base && echo "\n主箱烧好了。打开「参谋电报机」App，菜单栏里会显示「电报机：已接入」。" || echo "\n没烧成。在主箱那块板子上按住 B 键、点一下 R 键、松开 B 键，再双击一次本文件。"
read -k1 "?按任意键关闭…"
