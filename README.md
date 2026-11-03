# 参谋电报机（HoI4 攻略助手 · 软件部分）

菜单栏常驻，后台检测《钢铁雄心4》进程。按快捷键说一句「我要变成俄罗斯帝国」，GPT 会翻**本机**的游戏和模组文件（国策树、决议、事件、本地化），结合你的存档告诉你该怎么走。回答时先「滴滴滴」，再用电报员的声音念出一句总结。

## 跑起来

```bash
cd ~/Documents/项目/网页与软件/hoi4-advisor
npm install        # 第一次
npm start
```

### 做成双击就能开的 App

```bash
npm run app        # 生成 /Applications/参谋电报机.app
```

之后在启动台、聚焦搜索或「应用程序」里点「参谋电报机」就能打开，也可以拖进 Dock。参谋已经开着时再点一次，会把收起的窗口叫出来。App 里只有一个入口，实际跑的是本项目文件夹里的代码，所以改了代码不用重新生成；只有项目文件夹搬了位置、或者升级了 Electron，才需要重跑。每次重新生成，签名都会变，麦克风和屏幕录制权限要重新允许一次（系统设置 → 隐私与安全性 → 屏幕与系统录音 → 打开「参谋电报机」）。

菜单栏会出现「○ 参谋」，检测到游戏后变成「● 参谋」，同时弹通知。第一次打开会弹出设置：

- **OpenAI API Key**：必填。
- **接口地址**：直连官方填 `https://api.openai.com/v1`；用中转就填中转地址（要带 `/v1`）。
- **接口类型**：默认 Responses。如果中转报 404 或不支持，就改成 Chat Completions。
- 网络请求走系统代理（Clash 等开了「系统代理」就行）。

## 怎么用

| 操作 | 效果 |
|---|---|
| `⌘⇧K` | 开始录音，再按一次发出（游戏全屏时也能用） |
| 窗口里按住「话筒」 | 按住说话，松开发出 |
| 直接打字回车 | 文字提问 |
| 点菜单栏图标 | 显示/收起窗口 |

## 让参谋读到你的国策进度（强烈建议）

现在的存档是二进制格式，参谋只能看到国家和日期，看不到你点了哪些国策。改成文本存档的步骤：

1. 退出游戏；
2. 打开 `~/Documents/Paradox Interactive/Hearts of Iron IV/settings.txt`，把 `save_as_binary=yes` 改成 `save_as_binary=no`；
3. 进游戏，手动存一次档（铁人模式不行）。

之后每次想让它按最新局面判断，就先手动存一次档。

## 结构

```
main.js            托盘、进程检测（pgrep -x hoi4，3 秒一次）、全局快捷键、IPC
lib/gamedata.js    读游戏/模组文件：模组覆盖、中文本地化、国策树索引、决议、存档局面
lib/pdx.js         Paradox 脚本解析
lib/agent.js       GPT 工具循环（Responses / Chat 两种）、语音转写、TTS
renderer/          窗口界面、录音、电报声（WebAudio 摩尔斯）
test/              npm test：离线工具测试 + 假 OpenAI 服务器测试
```

GPT 能用的工具：`get_game_state`、`search_localisation`（中文名 → 脚本 id）、`get_focus`、`focus_path`（整条前置链 + 互斥 + 是否锁死）、`get_decision`、`search_scripts`、`read_file`。

## 自检

```bash
npm test
ADVISOR_SNAPSHOT=/tmp/shot.png npm start   # 7 秒后截窗口图、打印状态并退出
```

## 以后接电报机

硬件（电报键 + OLED + 蜂鸣器，ESP32 走 USB 串口）接进来后，只需要在 `main.js` 里读串口：键按下 → `send('hotkey')` 开始录音，松开 → 再发一次停止。到那时就能真正按住说话，不需要再"按两下"了。
