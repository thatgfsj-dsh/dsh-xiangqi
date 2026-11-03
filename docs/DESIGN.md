# dsh-xiangqi 设计契约（v1，施工依据）

> 本文件是并行施工的唯一契约。三名施工者只读本文件，各自只写自己的文件范围，不得改本文件、不得改 `package.json`。
> 目标版本：本机 `dsh 0.2.1-rc.2`、Node 24、Windows。**零第三方依赖**，只允许 Node 内置模块 + 浏览器原生 API。

## 1. 产品定义（已与用户对齐）

- 形态：**独立的对弈网站**（不是 DSH 界面里的面板），由 DSH 插件在宿主进程内起一个 `node:http` 服务，监听 `127.0.0.1:5000-5050` 中某个空闲端口，再由内网穿透暴露到公网。
- 使用者：**人类在外部用浏览器打开网站**，对手是**本机 DSH 里的 agent**（agent 用插件注册的工具走子），两者操作同一份内存棋局。
- 棋种：先做**中国象棋**；规则层留可插拔接口，国际象棋后续追加（本期不做）。
- 对局：**单局制**。同一时刻只有一局；点「新局」即弃掉上一局（旧口令、旧记谱一并作废）。
- 口令：**18 位**随机串（`[a-z0-9]`），生成时随对局创建，**拼在邀请 URL 里**（`/?k=<token>`），单局用完即扔。token 只存 SHA-256 摘要用于校验，明文只在创建时返回给 agent。
- 时间：**全局限时 20 分钟**（可配置），第一手落子才开始计时；超时判「超时方负」。顶部实时显示剩余时间与轮到谁。
- 手机端布局（硬要求）：**上方** = 该谁走 + 剩余时间；**中间** = 棋盘；**下方** = 棋谱（着法列表，滚动、自动滚到底）。桌面端自由排版（宽度 ≥ 720px 用左右分栏即可）。
- 记谱：中文记谱（如 `炮二平五`）+ ICCS（如 `h2e2`）+ FEN + 文字棋盘，输出 Markdown，给 agent 读。
- 内网穿透：插件内一键开/关。提供方 `cloudflared`（默认，quick tunnel）与 `natfrp`（SakuraFrp，需要访问密钥/隧道 ID，从本地配置读，绝不入仓）。

## 2. 目录与文件所有权（互不重叠）

| 范围 | 所有者 | 允许写的文件 |
|---|---|---|
| 规则与记谱 | R（rules） | `src/rules/*.mjs`、`src/record.mjs`、`tests/rules.test.mjs`、`tests/record.test.mjs` |
| 宿主/服务/隧道/工具 | H（host） | `index.js`、`src/host/*.mjs`、`scripts/dev-server.mjs`、`tests/game.test.mjs`、`tests/server.test.mjs`、`tests/tunnel.test.mjs` |
| 前端网站 | W（web） | `web/*`（`index.html`、`app.js`、`style.css`、`pieces.js`）、`scripts/check-web.mjs`、`README.md`、`docs/USER-MANUAL.md` |
| 契约/清单/评审 | Lead | `docs/DESIGN.md`、`package.json`、`cordis.patch.yml`、`.gitignore`、`LICENSE` |

约定：ESM（`.mjs` 或 `"type":"module"` 的 `.js`）、相对 import 必须带扩展名、UTF-8 无 BOM、单文件 ≤ 1000 行、不引入任何 npm 依赖、**不 import 任何 `@deepseek-ai/*` 包**（本机 profile 解析不到，会静默失败）。

## 3. 规则层接口（R 实现，H 消费）

`src/rules/xiangqi.mjs`：

```js
export const kind = 'xiangqi'
export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR r'

// 坐标：file 0..8（Red 视角从左到右，a..i）；rank 0..9（0 = 红方底线）
export function parseSquare(text)      // 'h2' -> {file:7, rank:2}；非法返回 null
export function squareName({file, rank}) // -> 'h2'
export function initialBoard()         // -> {squares: Array(90) 元素为 null 或 {type,color}, turn:'red', ply:0}
export function toFen(board)           // 中国象棋 FEN（含行棋方）
export function fromFen(fen)           // -> board
export function legalMoves(board)      // -> Move[]（全部合法着法）
export function legalMovesFrom(board, from) // -> Move[]
export function validateMove(board, move) // -> {ok:true} | {ok:false, code, message}
export function applyMove(board, move) // 纯函数，返回新 board（不修改入参），并 push 到 board.history？
export function notation(board, move)  // 落子前的中文记谱：'炮二平五'（红）/ '炮8平5'（黑）
export function statusOf(board)        // 'playing' | 'red-win' | 'black-win' | 'draw'
export function asciiBoard(board)      // -> string[]，10 行文字棋盘（给 md / agent）
export function moveTags(board, move)  // -> string[] 招数标签：将军/双将/将军抽车/将军抽子/将死/吃X/捉双/应将/过河
```

`Move = { from: {file,rank}, to: {file,rank}, iccs: 'h2e2', capture: boolean }`

`src/rules/index.mjs`：`export function getRules(kind='xiangqi')`，返回上面这组函数与 `kind`，供未来加国际象棋。

**0.3.0 起另有五子棋（独立模块，不放进上面的 registry）**：`src/gomoku/rules.mjs` + `src/gomoku/service.mjs`。

```js
// src/gomoku/rules.mjs
export const SIZE = 15
export function initialBoard(turn='black')   // { kind:'gomoku', size:15, cells: Array(225), turn, ply }
export function parseSquare(text)            // 'h8' -> {file:7, rank:7}
export function squareName(square)           // -> 'h8'
export function legalMoves(board)            // 全部空点
export function validateMove(board, input)   // {iccs} / {file,rank}；占位 → OCCUPIED
export function applyMove(board, move)       // 纯函数，换手
export function statusOf(board, lastMove)    // 'playing' | 'black-win' | 'white-win' | 'draw'
export function isWinningMove(board, file, rank) // 横/竖/两斜 ≥5 连
export function asciiBoard(board)            // 15 行文字棋盘（X/O/·）
export function toFen(board)                 // 行压缩 FEN
```

`src/gomoku/service.mjs` 提供与象棋对局服务同形状的接口（`newGame / snapshot / move / action / subscribe / verifyToken / recordMarkdown`），口令规则、20 分钟限时、单局制一致；`startServer({ gomoku })` 挂载 `/gomoku` 页面与 `/api/gomoku/*`（state / wait / move / new / action / record.md），复用同一套 `xq_sid` 会话 cookie 与隧道。

## 4.2 国际象棋（0.4.0 新增，独立模块）

`src/chess/rules.mjs`（纯函数，标准规则）：

```js
export function initialBoard()          // 起始局面
export function fromFen(fen) / toFen(board)
export function legalMoves(board)       // 过滤送王；含易位经过格校验
export function validateMove(board, {iccs|san|from,to,promotion})
export function applyMove(board, move)  // 易位挪车 / 吃过路兵 / 升变 / 权利与 ep 更新
export function statusOf(board)         // {status, reason}: checkmate/stalemate/fifty-move/insufficient
export function notation(board, move)   // SAN：消歧、+、#、O-O、=Q
export function asciiBoard(board) / legalIndex(board)
```

`src/chess/service.mjs` 与其它棋种同形状（口令 / 20 分钟 / 单局制 / 订阅 / 记谱），move 额外返回 SAN 与战术标签（吃X/将军/将死/王车易位/吃过路兵/升变）。五子棋与国际象棋的 HTTP 适配统一收在 `src/host/aux-game-api.mjs`（鉴权 / 状态载荷 / 长轮询 / 页面 / move·new·action·record），`server.mjs` 只负责挂载，避免重复代码把单文件撑过 1000 行。

非法原因 `code`（前端与工具都要用）：`NOT_YOUR_PIECE`、`EMPTY_SQUARE`、`ILLEGAL_PATTERN`、`SELF_CHECK`、`FLYING_GENERAL`、`OUT_OF_BOARD`、`GAME_OVER`。`message` 必须是人话（例：`炮吃子必须隔一个棋子`）。

## 4. 对局服务接口（H 实现，index.js/前端/工具消费）

`src/host/game.mjs`：

```js
export function createGameService({ rules, minutes = 20, now = () => Date.now() })
// 返回：
//   newGame({ humanSide = 'red', minutes }) -> { snapshot, token, urlPath }   // token 18 位；只在此处返回明文
//   snapshot() -> Snapshot
//   move(input) -> { snapshot }   // input: {from,to} | {iccs} | {notation}；失败抛 GameError
//   action(type)                  // 'undo' | 'resign' | 'draw' | 'restart'
//   subscribe(fn) -> unsubscribe  // fn(snapshot)，每次状态变化后广播（含 SSE 与工具通知）
//   recordMarkdown(meta) -> string
//   verifyToken(text) -> boolean  // 常数时间比较
//   status() -> { port?, url, tokenSet, gameId, tunnel }
```

`Snapshot`：
```js
{ gameId, fen, turn:'red'|'black', status:'playing'|'red-win'|'black-win'|'draw',
  rev, moves:[{n, color, iccs, notation, at, tags:string[]}], lastMove:{iccs,from,to,notation,tags}|null,
  humanSide, agentSide, startedAt, deadline, remainingMs,
  ascii: string[], recordMarkdown: string }
```

> `tags` 为招数标签（`moveTags()` 产出），网页徽标、agent 工具输出、Markdown 记谱三处同源；空数组表示普通着法。

`GameError`：`{ code, message, status }`（HTTP 映射：400/409/410）。

## 5. HTTP 服务接口（H 实现，W 消费）

`src/host/server.mjs`：

```js
export async function startServer({ service, tunnel, token, port, assetsDir, preview })
// -> { port, url, close() }
// preview=true 时放开 token（仅供本地浏览器预览，不用于公网）
```

路由（全部同源，`content-type` 严格设置）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 校验 `?k=`（或 cookie `xq`）→ 种 cookie + 返回 `web/index.html`；口令错 → 401 极简页 |
| GET | `/assets/*` | 静态文件（仅 `web/` 目录内的白名单后缀：html/js/css/svg/png/ico） |
| GET | `/api/state` | `{ok, snapshot, tunnel, invite:{url?}, legal}`（`legal` 为合法性索引） |
| GET | `/api/wait` | **长轮询（0.2.0 起前端主通道）**：`?since=<rev>&timeout=<ms>`；`since` 与当前 rev 不同（含首次）→ 立即返回；否则挂起，直到 rev / gameId 变化或超时（默认 25s，上限 30s），超时回当前态。响应 `{ok, snapshot, legal}`，一次原子应用 |
| POST | `/api/move` | body `{from,to}` → 200 `{ok, snapshot, legal}` / 409 `{ok:false,code,message}` |
| POST | `/api/new` | body `{humanSide?, minutes?}` → 200 `{ok, snapshot, legal, url}`（**新 token，旧 token 立即失效**） |
| POST | `/api/action` | body `{type}` → 200 `{ok, snapshot, legal, url?}` |
| GET | `/api/events` | SSE（保留兼容，前端 0.2.0 起不再使用）：`data: <snapshot json>\n\n`，25s 心跳注释行 |
| GET | `/api/record.md` | `text/markdown; charset=utf-8` |
| GET | `/gomoku` | 五子棋页面（校验五子棋口令或 `xq_sid`） |
| GET | `/chess` | 国际象棋页面（同上） |
| GET | `/api/chess/state` | `{ok, snapshot, invite?}`（快照：`kind:'chess'`, `fen`, `cells: Array(64)`, `legal`） |
| GET | `/api/chess/wait` | 国际象棋长轮询 |
| POST | `/api/chess/move` | body `{iccs}` / `{san}` / `{from,to,promotion?}` |
| POST | `/api/chess/new` | 新建国际象棋局（新口令） |
| POST | `/api/chess/action` | `{type:'resign'|'undo'|'restart'|'draw'}` |
| GET | `/api/chess/record.md` | 国际象棋记谱 Markdown |
| GET | `/api/gomoku/state` | `{ok, snapshot, invite?}`（五子棋快照：`kind:'gomoku'`, `cells: Array(225)`, `size:15`） |
| GET | `/api/gomoku/wait` | 五子棋长轮询，语义同 `/api/wait` |
| POST | `/api/gomoku/move` | body `{iccs:'h8'}` 或 `{file,rank}` → `{ok, snapshot}` |
| POST | `/api/gomoku/new` | 新建五子棋局，返回 `{ok, snapshot, url}`（新口令） |
| POST | `/api/gomoku/action` | `{type:'resign'|'undo'|'restart'|'draw'}` |
| GET | `/api/gomoku/record.md` | 五子棋记谱 Markdown |
| GET | `/api/tunnel` | `{ok, provider, status:'stopped'|'starting'|'running'|'error', url, error}`（仅 agent 工具使用） |
| POST | `/api/tunnel` | body `{action:'start'|'stop'|'status', provider?}`（仅 agent 工具使用；网页无穿透 UI） |

鉴权：`/api/*` 必须带 `x-xiangqi-token`（前端从 cookie/URL 取）或 `?k=`；`POST` 还要 `content-type: application/json`（缺 → 400）。失败一律 401 `{ok:false,code:'UNAUTHORIZED'}`，**不回显 token**。

**浏览器会话 cookie（0.1.2 起，修复「换局后页面不再自动更新」）**：`GET /` 通过校验后除口令 cookie `xq` 外再发一个 HttpOnly 的 `xq_sid`（随机 24 字符，服务进程内保存，TTL 12h）。此后的 `/api/*` 与 SSE 同时接受「当前口令」或「有效 `xq_sid`」。口令轮换只让**旧口令**失效（401），不再把同一个浏览器踢下线；SSE 连接按 `authBySession` 区分，轮到口令 cookie 的连接仍随轮换关闭，会话连接保持。因此 agent `xiangqi_new_game` 换局后，用户已在看的那一页会直接跳到新局，不需要刷新或重新点链接。

## 6. 隧道管理接口（H 实现）

`src/host/tunnel.mjs`：

```js
export function createTunnelManager({ config, log = () => {} })
// -> { start(provider?, { port }?), stop(), status(), onChange(fn), pickLocalPort() }
// 状态机 stopped -> starting -> running -> stopped；stop() 只杀自己 spawn 的子进程（记 pid，按 pid 杀）
```

- **不变式（2026-11-02 复盘，见 Issue #3）：隧道指向的端口必须等于 HTTP 服务实际绑定的端口。**
  端口唯一来源是 `startServer()` 返回的 `port`（`server.address().port`），由 `index.js` 与 `/api/tunnel` 显式传给 `tunnel.start(provider, { port })`；
  隧道**不得**在服务之外自行 `resolvePort()` 挑口。只有调用方没传端口时，才允许回退 `config.port` / `pickLocalPort(5000,5050)`。
  反例（线上事故）：站点绑到 `61350`，隧道却 `--url http://127.0.0.1:5000` → 公网 502。
- 本地端口：`pickLocalPort(5000, 5050)` —— 从 5000 起扫，`net.createServer().listen()` 成功即用；全占则抛 `NO_FREE_PORT`。
- `cloudflared`：spawn `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port> --metrics 127.0.0.1:<20500-20600 空闲口>`；从 **stderr** 匹配 `https://[a-z0-9-]+\.trycloudflare\.com`；30s 未拿到 URL 判失败；需要代理时读 `config.proxy`（默认 `http://127.0.0.1:7897`）注入 `HTTPS_PROXY`。
  **必须显式给 `--metrics`**：cloudflared 默认抢 `127.0.0.1:20241`，本机已有实例（手工/上一版残留）时后来的进程会直接退出（code=1），表现为「前端点穿透就报错、隧道没啥用」。
- `natfrp`（SakuraFrp）：`config.natfrp = { token, tunnelId, clientPath }`，默认命令 `[clientPath, '-f', token + ':' + tunnelId]`；缺 token/tunnelId → `start()` 抛 `NOT_CONFIGURED` 并提示改用 cloudflared。URL 从 stdout/stderr 行里匹配 `https?://\S+`。
- 二进制查找顺序：`config.binPath` → `PATH` 里的 `cloudflared`/`frpc` → 仓库同级 `tunnel/bin/cloudflared.exe`（存在才用，不写死绝对路径）。
- 本地配置：`src/host/config.mjs` 读 `xiangqi.config.json`（查找顺序：`$XQ_CONFIG` → `$DSH_HOME/plugins-data/xiangqi/config.json` → 仓库根 `xiangqi.config.json`，都 gitignore），env 覆盖：`XQ_TOKEN`、`XQ_PORT`、`XQ_MINUTES`、`XQ_NATFRP_TOKEN`、`XQ_NATFRP_TUNNEL`、`XQ_CLOUDFLARED`、`XQ_PROXY`、`XQ_DATA_DIR`。

## 7. DSH 插件入口（H 实现）

`index.js`：`export const name = 'xiangqi'`、`export const inject = ['tools']`、`export function apply(ctx)`。要点：

- 起服务与规则服务，注册工具，`ctx.effect(() => () => { server.close(); tunnel.stop() })`。
- **不要 import 任何 `@deepseek-ai/*`**；工具直接 `ctx.tools.register({...})` 传普通对象，形状：
  `{ name, description, parameters: <DSH 方言对象>, output: { schema, render(a,v) }, async execute(args, exec) }`（`render` 返回 `[{type:'text',text}]`）。
- 工具清单（名字固定，前端/文档/测试都用这套）：

| 工具 | 参数 | 行为 |
|---|---|---|
| `xiangqi_new_game` | `{ humanSide?: 'red'|'black', minutes?: number }` | 新建单局，返回邀请 URL（含 18 位口令）+ 谁先走 |
| `xiangqi_board` | `{}` | 返回文字棋盘 + FEN + 轮到谁 + 剩余时间 + 最近一手 + 棋谱 |
| `xiangqi_move` | `{ move: string }` | 接受 `h2e2` / `h2-e2` / `炮二平五`；非法时返回人话原因（不抛给模型栈） |
| `xiangqi_wait` | `{ timeoutMs?: number, sinceRev?: number }` | 长等到人类走子或超时（上限 120000），返回新局面 |
| `xiangqi_record` | `{}` | 返回 Markdown 记谱全文（同时落盘到数据目录 `games/<gameId>.md`） |
| `xiangqi_tunnel` | `{ action: 'start'|'stop'|'status', provider?: 'cloudflared'|'natfrp' }` | 开/关/查隧道，返回公网 URL |
| `xiangqi_status` | `{}` | 站点地址、口令是否就绪、隧道状态、剩余时间、自动唤醒是否绑定会话 |

### 7.1 自动唤醒（2026-11-02 新增，回应用户「md 棋盘同步后触发」）

- **触发点**：`game.service.subscribe(snapshot)` —— 人类在网页落子后快照 `rev` 递增、`recordMarkdown` 同时重算（md 与网站同源同帧），此时判断 `status === 'playing' && turn === agentSide` 即触发唤醒；对局结束也唤醒一次通知结果。
- **绑定会话**：工具执行时用 `ctx.get('agents').currentInitiator()` 取发起对局的 Agent，记录 `agent.session.id`（`--help` / 无 agent 上下文时忽略）。
- **投递**：`ctx.get('sessionController').resolveAgent(sessionId)` → `agent.followup(userMessage)` → `ctx.get('sessions').flush(agent.session)`（与官方 `dsh-schedule` 的唤醒路径一致）。
- **消息形状**：`{ id: randomUUID(), role:'user', content:[{type:'text',text}], source:{kind:'user'} }`；文案带 `[象棋自动唤醒]` 前缀，**不含口令与 URL**（会话会被持久化）。
- **去重与节流**：以 `gameId:rev`（结束时 `gameId:end`）为键，500ms 合并抖动；agent 自己走子导致 `turn` 变成人类方，不触发。
- **投递前复核（0.1.4）**：500ms 抖动窗口内可能已经换局或又走了一步，所以真正 `followup` 前重新取一次快照；`gameId` / `rev` 不一致、或已轮到人类方就**丢弃**。否则会把「上一局结束」的消息晚投到新局里（实测踩到：换局后收到 `对局已结束：black-win（resign）`，而新局其实刚开始）。
- **开关**：`config.autoWake`（默认 true）/ 环境变量 `XQ_AUTO_WAKE=0`；关闭后行为退回「agent 主动 `xiangqi_wait` 或人类喊一句」。
- **降级**：`sessionController` / `agents` 服务不存在、会话已关闭、flush 失败 → 只打日志，不影响对局。

## 8. 记谱 Markdown 格式（R 实现 `renderRecordMd`）

```markdown
# 象棋对局 xq-20261102-1a2b · 红方：人类 · 黑方：agent

- 状态：进行中 · 轮到：黑方 · 剩余：18:42
- FEN：`rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR b`
- 最近一手：炮二平五（h2e2）· 将军抽车

## 棋盘

（10 行文字棋盘，红方在下，用 车马相仕帅仕相马车 / 卒炮 等汉字；空位用 ·）

## 着法

| 回合 | 红方 | 黑方 |
|---:|---|---|
| 1 | 炮二平五 | 马8进7 |
| 2 | 车二进六 吃马 | 炮8平9 |

## 给 agent 的下一步（可直接复制）

- 拉当前局面：`GET <base>/api/state`，头 `x-xiangqi-token: <token>`
- 走子：`POST <base>/api/move`，body `{"from":"h2","to":"e2"}`
- 记谱：`GET <base>/api/record.md`
```

> 口令永远不写进落盘的 md（写 `<token>` 占位）；md 会随 `xiangqi_record` 返回并被大模型看到，属于「脱敏」要求。

## 9. 前端要求（W 实现）

- 纯静态文件 + 原生 ES module，无构建、无 CDN、无字体外链（棋子在 CSS 里用 `serif` 字体族）。模块拆分：`app.js`（主流程）、`pieces.js`（棋子/坐标）、`sound.js`（音效）、`feedback.js`（音效开关/招数提示）、`record-view.js`（棋谱渲染），单文件 ≤1000 行。
- 棋盘：SVG 线格 + 楚河汉界 + 炮/兵位标记；棋子圆形、有立体感（渐变 + 内阴影），红黑双色可辨；点击选子 → 高亮合法落点（**前端不实现规则，全部以服务端返回的 `legal` 为准**）。
- **手机首屏（0.2.0）**：状态条 + 棋盘（按剩余高度撑满、宽度优先）+ 一排功能键；**棋谱放到首屏下方（下滑可见）**，避免挤压棋盘。桌面 ≥720px 仍为「棋盘 + 右侧信息栏」两栏。
- **动态刷新（0.2.0，替代 SSE 与补丁式补拉）**：`watchLoop()` 循环请求 `GET /api/wait?since=<rev>`，响应到达即 `applyState({snapshot, legal})` 原子应用；断线按 400ms→4s 退避，`visibilitychange`/`online` 时取消旧请求并立即重启。不存在的「先渲染再拉 legal」路径已删除。
- **拿起放下动画（0.2.0）**：选中 → `.piece.is-picked`（抬高/放大/光晕，CSS transition）；落子 → 在目标格棋子上用 WAAPI `animate()` 从出发格偏移平移 + 回弹落定（190ms）；`prefers-reduced-motion` 下 CSS 动画自动关闭。
- 交互：点选走子；非法走子必须弹出**人话错误**（用服务端 `message`），并让棋子抖动回弹。
- 顶部（手机在上方）：轮到谁（红/黑 + 「你」标记）+ 倒计时 `mm:ss`（≤60s 变红闪烁）。
- 底部（手机在下方）：棋谱列表（`1. 炮二平五  马8进7` 两列），自动滚动；桌面端放侧栏。
- 控制区：新局、悔棋、认输、导出记谱（下载 `.md`）、音效开关（🔊/🔇，状态存 localStorage）。**穿透不在网页上**（0.2.0 移除按钮与面板），只由 agent 工具 `xiangqi_tunnel` 管理。
- **音效（0.1.5，0.2.0 调清脆）**：`web/sound.js` 用 Web Audio 实时合成，零音频文件；人类落子稍低、agent 落子更亮，吃子加高频脆裂，将军类播两声高音，结束按胜负播上行/下行三音；浏览器自动播放策略要求先有用户手势，`pointerdown`/`keydown` 里 `unlock()`。
- **招数提示（0.1.5）**：棋谱每手渲染 `tags` 徽标（将军类红色 + `tag-pop` 动画）；将军/将死额外弹 toast + 提示音；逻辑在 `web/feedback.js`，棋谱渲染在 `web/record-view.js`。
- 结束态：覆盖层显示胜负原因（将死/超时/认输/和棋），提供「再来一局」。
- 无障碍/健壮：无 JS 时报错文本；长轮询断线自动退避重连；所有 DOM 更新走文本节点，不 `innerHTML` 拼接用户数据。
- **服务端 `legal`**：`LegalityIndex = { "<fromSquare>": ["<toSquare>", ...] }`，由服务端用 `legalMoves` 全量生成；`/api/state`、`/api/wait`、`/api/move`、`/api/new`、`/api/action` 都返回（一次请求即可原子渲染）。

## 10. 验收（Lead 执行，施工者自测后再交）

1. `npm test`（`node --test`）全绿：规则合法/非法、记谱格式、服务鉴权与 409、隧道端口选择与 mock provider。
2. `node scripts/dev-server.mjs` 起站，`curl "http://127.0.0.1:<port>/?k=<token>"` 返回页面；错 token 401。
3. 对局脚本：`POST /api/new` → 连走 6 步（含 2 次非法）→ `GET /api/record.md` 含 12 行着法表；20 分钟超时用注入时钟测。
4. 前端：真实浏览器打开移动端视口（390×844），确认首屏只有状态+棋盘+一排功能、棋谱在首屏下方；点选有拿起动画、落子有落位动画；走子后页面靠长轮询自更新（另一客户端走子 → 页面 ≤300ms 内变化）；截取首屏/拿起/棋谱与音效开关各一张图。
5. DSH 冒烟：`dsh --profile web --patch <临时 overlay> --help` 能加载插件不报错（端口绑定在 `--help` 下不得阻塞退出）。
6. 隧道：`cloudflared` 起 → 拿到 `https://*.trycloudflare.com` → 从本机 `curl` 该 URL 的 `/api/state` 通 → stop 后端口与子进程都消失。

## 11. 脱敏红线（评审重点）

- 仓库内**绝不出现**：真实公网 IP/域名、natfrp 访问密钥、隧道 URL、token 明文、本机绝对路径（用户目录或工作盘下的真实路径）、本机用户名。
- 邀请 URL 里的 token 只在运行时产生；`README`/示例一律 `<token>`、`127.0.0.1:5000`、`https://example.trycloudflare.com`。
- `.gitignore` 至少覆盖：`xiangqi.config.json`、`.data/`、`games/`、`*.log`、`node_modules/`、`.env*`。
