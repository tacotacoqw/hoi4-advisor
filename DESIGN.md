# Design

参谋电报机的界面 = 《钢铁雄心4》游戏里的一扇窗。贴图在运行时从玩家本机游戏目录转出（`lib/gfx.js`，ffmpeg 把 .dds/.tga 转 png，经 `gfx://` 协议给窗口），仓库不存任何游戏素材；转不出时 `body.no-gfx` 用纯 CSS 近似。

## 材质（全部来自本机游戏）
| 变量 | 游戏贴图 | 用在 |
|---|---|---|
| `--tex-frame` | `gfx/interface/tiles/tiled_window_2b_border.dds` | 窗口与设置面板的铆钉钢框（border-image 九宫格 16/14px） |
| `--tex-tile` | `gfx/interface/tiles/tiled_window.dds` | 碳纹底（96px 平铺） |
| `--tex-topbar` | `gfx/interface/topbar/background.dds` | 顶栏：左侧方框放国旗，上沿标题、下沿状态条 |
| `--tex-plate` | `gfx/interface/focus_popup_bg.dds` | 月桂铭牌，写路线结论 |
| `--tex-button` | `gfx/interface/button_type_1.dds` | 次要按钮（暗铜） |
| `--tex-button-small` | `gfx/interface/button_type_2.dds` | 主操作「发报」「保存」（金色+深字） |
| 国旗 | `gfx/flags/<TAG>_<意识形态>.tga` | 顶栏国旗方框 |
| 国策图标 | focus `icon` → `interface/*.gfx` spriteType → `.dds` | 国策链节点 |

## 颜色
金字 `--gold #e2c47c` / 高光 `#f4dc9c` / 暗金 `#9c8550`；正文 `#e4dccb`，次要 `#a39c88`；底 `#161714`；完成绿 `#8dbb62`；锁死红 `#d0634c`（锁死、互斥、报错同时用 135° 斜纹，不只靠颜色）；电报纸 `#e6dcc0` + 墨 `#2a2419`；电台字幕青绿 `#9ec7a4`。

## 字
界面 PingFang SC；标题与铭牌 Songti SC 900（印刷公文感）；电报条、输入框、电传记录用打字机字体（American Typewriter / Courier）——它们本来就是打字机/电传输出。（试过换成游戏 52 汉化位图字体，用户不喜欢，已删。）

## 组件
- **去电**：用户问题 = 羊皮电报条，左侧红色竖排「去电」章。
- **电传记录**：查询步骤，小号打字机绿灰字，左侧细线。
- **国策树推演**（签名组件）：月桂铭牌（结论 · 目标国策 + 步数/天数/进度）→ 竖向国策链（真图标 60px + 深色名牌 + 天数 + 标签），终点金框放大，已完成绿牌，锁死灰图标+红斜纹；超过 7 步折叠中间、铜按钮展开；下接「来电」播报条和可展开的「参谋详述」。
- **钢板公文**：没有路线时的普通回答。
- **电台**：GPT Live 说的话，深绿底青绿字，前缀「电台」。
- **报错**：红斜纹板。提示 toast：黑底暗金边。
- **按钮**：游戏铜按钮九宫格；hover 提亮、按下下沉 1px、focus 金色描边。

## 动效
只有三处：回答（国策链）上浮淡入 0.5s、电传记录逐行打入、状态灯闪烁；`prefers-reduced-motion` 全部关闭。
