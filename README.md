# dsh-xiangqi

> 在 DeepSeek Harness（DSH）里和 agent 下中国象棋：插件在宿主进程里起一个独立对弈网站，人类用手机浏览器走子，agent 用工具应战，一键内网穿透把棋盘发到公网。

- 形态：**独立网站**，不是 DSH 界面里的面板。插件启动 `node:http` 服务监听 `127.0.0.1:5000-5050` 的空闲端口，浏览器打开带口令的邀请链接即可对弈。
- 对手：**本机 DSH 里的 agent**。agent 通过 `xiangqi_*` 工具走子、等待、导出记谱；人类只用浏览器。
- 对局：**单局制**。点「新局」即弃掉上一局，旧口令与旧记谱一并作废。
- 依赖：**零第三方依赖**，只用 Node 内置模块与浏览器原生 API；前端无构建、无 CDN、无外链字体。

## 特性

- **手机优先布局**：顶部状态条（轮到谁 + 「你」标记 + `mm:ss` 倒计时，≤60 秒变红闪烁），中间棋盘，底部两列棋谱（`1. 炮二平五  马8进7`，自动滚到最新）。宽度 ≥ 720px 自动切桌面分栏：棋盘居中偏左，右侧信息栏放状态、时间、控制、棋谱与隧道。
- **精美棋盘**：SVG 绘制 9×10 线格、楚河汉界、炮兵位十字标记、九宫斜线；棋子为圆形立体棋子（径向渐变 + 内阴影 + 描边 + 楷体字），红黑双色清晰；选中态、最近一手、合法落点圆点/吃子圈都有独立提示。
- **点选走子**：点自己的子 → 高亮服务端给出的合法落点 → 点落子。**前端不实现任何规则**，合法性与错误文案全部来自服务端；非法走子弹出服务端返回的人话原因并让棋子抖动回弹。
- **实时同步**：SSE（`/api/events`）推送局面，断线按 1s→30s 指数退避自动重连，另有轮询兜底；断网、口令失效都有明确提示。
- **一键穿透**：支持 `cloudflared`（默认，quick tunnel）与 `natfrp`（SakuraFrp），状态点 + 公网 URL + 复制按钮。
- **Markdown 记谱**：中文记谱 + ICCS + FEN + 文字棋盘，可导出 `.md` 给 agent 读。
- **脱敏**：口令只在运行时产生，落盘记谱与日志只写 `<token>` 占位。

## 截图

真机截图不入库。需要更新 README 展示图时，把两张图放到 `docs/` 下并替换下方占位：

| 文件 | 说明 |
| --- | --- |
| `docs/screenshot-mobile.png` | 手机视口（390×844）：顶部状态条 / 中间棋盘 / 底部棋谱 |
| `docs/screenshot-desktop.png` | 桌面视口（1280×800）：棋盘居中偏左 + 右侧信息栏 |

```text
docs/screenshot-mobile.png    （占位：手机端三段式）
docs/screenshot-desktop.png   （占位：桌面端分栏）
```

## 安装

要求：DSH `>= 0.2.1-rc.2 < 0.3.0`、Node `>= 22`（本机实测 Node 24）。

```powershell
# 从本地仓库目录安装（<本地仓库路径> 换成你 clone 下来的目录）
dsh plugin --profile web add <本地仓库路径>

# 或从 npm 包安装（发布后）
dsh plugin --profile web add dsh-xiangqi
```

安装后重启 / 重新加载 DSH profile，插件会注册 `xiangqi_*` 工具并在宿主进程内起对弈服务。插件只监听本机回环地址，公网访问请用「内网穿透」。

## 快速开始

1. 在 DSH 里对 agent 说：`开一局象棋，我执红`。
2. agent 调 `xiangqi_new_game`，返回**邀请 URL**（形如 `http://127.0.0.1:5000/?k=<token>`）与先手方。
3. 手机/浏览器打开邀请 URL，点自己的棋子开始走。
4. agent 用 `xiangqi_wait` 等你走子，用 `xiangqi_move` 应招；想复盘就让 agent 调 `xiangqi_record`。

本地只想看前端效果、不接 agent 时，也可以：

```powershell
node scripts/dev-server.mjs
```

按脚本输出的地址与口令在浏览器打开即可。

## 配置

配置文件查找顺序（先到先得，全部不入库）：

1. 环境变量 `XQ_CONFIG` 指向的文件；
2. `$DSH_HOME/plugins-data/xiangqi/config.json`；
3. 仓库根目录的 `xiangqi.config.json`。

```json
{
  "port": 5000,
  "minutes": 20,
  "proxy": "http://127.0.0.1:7897",
  "binPath": "<可选：cloudflared 可执行文件路径>",
  "natfrp": {
    "token": "<natfrp-token>",
    "tunnelId": "<natfrp-隧道-id>",
    "clientPath": "<可选：frpc 可执行文件路径>"
  }
}
```

| 键名 | 类型 | 说明 |
| --- | --- | --- |
| `port` | number | 首选端口，默认 `5000`；被占用时在 5000–5050 内另选 |
| `minutes` | number | 全局限时（分钟），默认 `20`；第一手落子才开始计时 |
| `proxy` | string | 启动 cloudflared 时注入的 `HTTPS_PROXY`，默认 `http://127.0.0.1:7897` |
| `binPath` | string | cloudflared / frpc 可执行文件路径；不填则查 `PATH` |
| `natfrp.token` | string | SakuraFrp 访问密钥，**绝不入仓** |
| `natfrp.tunnelId` | string | SakuraFrp 隧道 ID |
| `natfrp.clientPath` | string | frpc 可执行文件路径 |
| `dataDir` | string | 记谱落盘目录，默认插件数据目录下的 `games/` |

环境变量覆盖（优先级高于配置文件）：

| 变量 | 作用 |
| --- | --- |
| `XQ_CONFIG` | 指定配置文件路径 |
| `XQ_TOKEN` | 固定口令（仅本地调试；正常由插件每局随机生成） |
| `XQ_PORT` | 首选端口 |
| `XQ_MINUTES` | 全局限时（分钟） |
| `XQ_NATFRP_TOKEN` | natfrp 访问密钥 |
| `XQ_NATFRP_TUNNEL` | natfrp 隧道 ID |
| `XQ_CLOUDFLARED` | cloudflared 可执行文件路径 |
| `XQ_PROXY` | cloudflared 代理地址 |
| `XQ_DATA_DIR` | 记谱与数据目录 |

> 凭据只放本地配置或环境变量；仓库、README、示例、日志里一律用 `<natfrp-token>`、`<token>` 这类占位符。

## 工具清单

agent 可用的工具（名字固定）：

| 工具 | 参数 | 行为 |
| --- | --- | --- |
| `xiangqi_new_game` | `{ humanSide?: 'red'\|'black', minutes?: number }` | 新建单局，返回邀请 URL（含 18 位口令）与先手方 |
| `xiangqi_board` | `{}` | 返回文字棋盘 + FEN + 轮到谁 + 剩余时间 + 最近一手 + 棋谱 |
| `xiangqi_move` | `{ move: string }` | 接受 `h2e2` / `h2-e2` / `炮二平五`；非法时返回人话原因，不抛给模型栈 |
| `xiangqi_wait` | `{ timeoutMs?: number, sinceRev?: number }` | 长等到人类走子或超时（上限 120000ms），返回新局面 |
| `xiangqi_record` | `{}` | 返回 Markdown 记谱全文，并落盘到数据目录 `games/<gameId>.md` |
| `xiangqi_tunnel` | `{ action: 'start'\|'stop'\|'status', provider?: 'cloudflared'\|'natfrp' }` | 开/关/查隧道，返回公网 URL |
| `xiangqi_status` | `{}` | 站点地址、口令是否就绪、隧道状态、剩余时间 |

## 内网穿透

两种提供方，插件内一键开/关，也可由 agent 用 `xiangqi_tunnel` 控制：

- **cloudflared（默认）**：spawn `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>`，从 stderr 里抓 `https://*.trycloudflare.com`，30 秒内拿不到地址即判失败；需要代理时注入 `HTTPS_PROXY`。
- **natfrp（SakuraFrp）**：需要本地配置 `natfrp.token` + `natfrp.tunnelId`；缺配置时启动会报 `NOT_CONFIGURED` 并提示改用 cloudflared。

状态机：`stopped → starting → running → stopped`（失败进入 `error`）。`stop` 只结束插件自己 spawn 的子进程（记录 pid 后按 pid 结束），不会碰系统里其它隧道。

公网地址示例：`https://example.trycloudflare.com`（每次启动都会变）。

## 排障：公网 502（隧道端口与站点端口不一致）

**现象**：浏览器打公网地址返回 Cloudflare `502 Bad Gateway`，但本机 `http://127.0.0.1:<站点端口>` 打开正常。

**根因**：隧道进程指向的端口和 HTTP 服务**实际绑定**的端口不是同一个。真实踩坑记录：站点绑在 `127.0.0.1:61350`（落在 5000–5050 之外），而 cloudflared 参数是 `--url http://127.0.0.1:5000` → 云边能连上隧道，但回源必然失败。

**一眼定位**（三步）：

```powershell
# 1) 站点真实端口与隧道端口必须一致（xiangqi_status 里「站点地址」与隧道「本地端口」）
#    agent 里直接调 xiangqi_status；或看 /api/tunnel 的 localPort

# 2) 隧道进程实际指向哪里
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" |
  Select-Object ProcessId, CommandLine

# 3) 那个端口上到底有没有在听
Get-NetTCPConnection -State Listen |
  Where-Object { $_.LocalPort -ge 5000 -and $_.LocalPort -le 5050 } |
  Select-Object LocalAddress, LocalPort, OwningProcess
```

**处理**：

1. 升级到含修复的版本（`0.1.1` 起：`tunnel.start(provider, { port })` 强制使用服务**实际绑定端口**，不再自行挑口），然后**重启 DSH** 让宿主加载新代码；
2. 用 `xiangqi_tunnel stop` → `xiangqi_tunnel start` 重新开隧道，公网地址会变；
3. 若站点端口落在 5000–5050 之外，插件会在宿主日志里打一行「服务绑定到 61350…隧道会使用真实端口」的提示——这是允许的降级路径，但仍然建议重启让端口回到区间内。

**不要这样做**：绕过插件手动 `cloudflared tunnel --url http://127.0.0.1:<port>`。手工进程不受插件管理：`xiangqi_tunnel status` 看不到它、`stop` 杀不掉它、重启 DSH 后它还活着但指向的端口可能已经变了，排查成本会翻倍。

## 隐私与脱敏

- 仓库内**不出现**真实公网 IP/域名、隧道地址、访问密钥、口令明文、本机绝对路径与用户名。
- 口令 18 位（`[a-z0-9]`），随对局生成、拼在邀请 URL 里；服务端只保存 SHA-256 摘要用于校验，明文只在创建时返回给 agent。
- 页面不显示口令；前端从 `?k=` 读取一次后仅放在 `x-xiangqi-token` 请求头里，后续请求不再拼 URL。
- 落盘记谱与日志只写 `<token>` 占位；`GET /api/record.md` 与导出的 `.md` 都不含口令明文。
- 对弈服务只监听本机回环地址；公网暴露完全由用户显式开启的隧道负责。
- 本地配置 `xiangqi.config.json`、数据目录、`games/`、日志均在 `.gitignore` 内。

## 开发

```powershell
# 单元测试（node --test：规则、记谱、服务鉴权、隧道）
npm test

# 起本地开发服务器（对弈站点 + 示例口令）
node scripts/dev-server.mjs

# 前端静态自检（文件、挂载点、无外链、无 HTML 拼接、无硬编码口令、行数）
node scripts/check-web.mjs
```

目录结构：

```text
index.js              插件入口（注册工具、起服务、清理隧道）
src/rules/            规则与中文记谱（纯函数）
src/host/             对局服务、HTTP 服务、隧道管理、配置读取
web/                  对弈网站（index.html / app.js / style.css / pieces.js）
scripts/dev-server.mjs 本地开发服务器
scripts/check-web.mjs  前端静态自检
tests/                node --test 测试
docs/DESIGN.md        设计契约
docs/USER-MANUAL.md   人类与 agent 使用手册
```

前端约定：原生 ES module，无构建、无第三方库、无 CDN、无外链字体；所有用户与服务端数据用 `textContent` 渲染，不拼 HTML 字符串；不使用 `eval` 一类动态执行；单文件 ≤ 1000 行。

## 许可

MIT
