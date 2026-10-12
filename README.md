# Fritia 桌宠（DSH Web 插件）

右下角的小人。左键互动、右键看余额、长按/拖动可以抓起，Harness 干活时它会左右走。

## 目录

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半：把 `sprites/` 里的立绘以 HTTP 提供给浏览器，并把 `agent/status` 的忙碌状态暴露成 JSON |
| `client.js` | 浏览器半：状态机 + 渲染，注册到 `shell.overlay` |
| `sprites/` | 20 张 256×256 透明立绘 + 2 张市场截图（`../img` 的处理产物） |
| `screenshots.json` | 市场展示用截图清单（相对路径，1–8 张） |
| `cordis.patch.yml` | 装载入口行 |
| `tools/` | 本地自检脚本（`verify-pose` / `verify-host` / `verify-client`，不随插件运行） |

## 交互

| 操作 | 行为 |
|---|---|
| 待机 | 随机在 `待机1` / `待机2` 之间切换 |
| 待机超过 10 秒 | 50% / 50% 进入 `困` 或 `钓鱼`，几秒后回到待机（下次再触发需重新计时） |
| Agent 工作期间 | 播放 `左走` / `右走` 四帧动画，在右下角区域内来回移动，每次到边自动换向 |
| 左键点击 | 50% / 50% 触发 `高兴` 或 `困惑` |
| 连续点击（1 秒内累计 3 次） | 触发 `生气`，每次连击只触发一次 |
| 每次左键点击 | 10% 概率触发 `彩蛋` 或 `彩蛋2` |
| 右键点击 | 切换到 `余额`，并自动读取 DeepSeek 账户余额，显示在它举起的板子上；再次右键收起 |
| 长按（260ms 不动） | `抓起` |
| 按住并拖动 | `抓起颤抖`，小人跟随鼠标移动，松手停在原地 |
| 工作结束 / 点击后 | 回到 `待机`（最后一只 agent 停止后约 **3 秒**缓冲） |

小人默认贴在**视口右下角**（间距 12px、尺寸 168×168），窗口缩放会重新校正位置；拖动过之后就停在你放下的位置。

## 走路节奏与空闲判定

- 走动是"从右停靠点滑到左停靠点"，一个来回腿长由单点常量 `WALK_LEG_MS`（4800ms）同时控制
  过渡时长与换向间隔；改这一个值就能整体调速。
- Host 只跟踪**正在运行**的 agent id，并监听 `agent/disposed`、每 5 秒与 `ctx.agents.list()`
  对账，所以丢失一条 `idle` 通知不会让小人一直走。
- 客户端另有一道保险：`/state` 的 `since` 超过 90 秒未刷新就按空闲处理。
- `walkingWindowMs`（默认 3000）与 `reconcileMs`（默认 5000）可以在 `cordis.patch.yml` 里覆盖。

## 安装

```powershell
# 由 plugin_manager 完成安装（不要手改 profile 的 package.json / cordis.patch.yml）
```

已安装的入口行 id 为 `dsh-fritia-pet`。

**必须重启一次 DSH 桌面端**才会加载本文的 Host 代码：运行中的进程缓存了已导入的模块，
重新启用插件行、重装 bundle、乃至改文件 mtime 都不会重新导入它（已实测）。只改
`client.js` 时不需要重启，刷新页面即可。

## 自检（重启后）

浏览器直接打开 <http://127.0.0.1:19387/fritia-pet/health> 即可确认 Host 半是否就绪：

```json
{ "plugin": "dsh-fritia-pet", "assetCount": 20, "artwork": { "file": "待机1.png", "status": "ok", "bytes": 54378 } }
```

`artwork.status` 为 `ok` 说明立绘路由可用、桌宠能显示；若为 `no-assets` 或 `unreadable`
则是素材路径问题。页面里另外暴露了 `window.__FRITIA_PET__`（当前 pose / frame /
working / balance 状态），可在浏览器控制台查看。

## 开发自检脚本

```powershell
node tools/verify-pose.mjs     # 把状态机决策抽出来跑假时钟：待机切换、10 秒转困/钓鱼、优先级、缺图回退
node tools/verify-host.mjs     # 假 Cordis 上下文 + 真实 http 请求，检查路由与素材可达性
node tools/verify-client.mjs   # 桩 module loader + 桩 React，检查插件形状与渲染不抛错
```

三个脚本都以退出码表明结果（0 通过）。`verify-pose.mjs` 覆盖 47 条断言：

- **状态机**：待机切换、10 秒转困/钓鱼（各半）、动作优先级（动作 > 走路 > 待机）、
  走路四帧推进、缺图回退；
- **点击**：单击出高兴/困惑、连击窗口计数、第 3 次触发一次生气且同一次连击不重复触发、
  窗口过后连击清零；
- **彩蛋**：10% 阈值两侧、`彩蛋1`/`彩蛋2` 分支，并用 2 万次采样实测命中率 9.91%。

其中两条断言对应曾经真实存在的回归（睡眠时长 6 秒 > 待机阈值 10 秒时，动作结束会在
同一帧立刻重掷，睡着后永远醒不过来）：动作结束现在会清空子状态并**重新开始一段完整
待机计时**。120 秒无互动的模拟结果是 7 次睡眠、相邻两次间隔 ≥16 秒。

`verify-host.mjs` 覆盖：清单、忙碌状态、余额解包、22 张素材全部可达、目录穿越被拒、
缺文件返回 404。`verify-client.mjs` 覆盖：模块 id、插件形状、`shell.overlay` 注册、
样式注入、20 张立绘的请求 URL 形状。

## 已知限制

- 本插件只走**同源 HTTP**（Host 半的 `/fritia-pet/*`）读取素材与忙碌状态/余额兜底；
  余额优先走生成的 Remote 命名空间 `ctx.remote.deepseekAccount.getBalance`，失败时
  回落到 Host 路由。
- Host Web 服务器的 `kind: 'prefix'` 路由在本插件上不稳定（请求会落到 SPA 兜底），
  因此素材路由改成 `exact` + 查询参数 `/fritia-pet/sprite?f=<文件名>`。
- 余额金额较长时（例如 18 位小数）会完整显示，板子上的字号按比例缩放，
  如需格式化货币请改 `client.js` 的 `formatWallets`。
