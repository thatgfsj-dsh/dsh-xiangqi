// DSH 宿主插件入口（DESIGN §7）。
//
// - export name / inject / apply；不 import 任何 @deepseek-ai/* 包。
// - 工具用普通对象直接 ctx.tools.register({ name, description, parameters, output, execute })：
//   本机 dsh-tools 的 register 只强校验 output.schema 与 output.render。
// - apply 内**不 await 端口绑定**：服务异步启动，失败只 console.error，避免
//   `dsh --patch <overlay> --help` 被端口/隧道挂住。
// - ctx.effect 负责在插件卸载时关闭 HTTP 服务与隧道。
import { mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { REPO_ROOT, loadConfig } from './src/host/config.mjs'
import { GameError, createGameService } from './src/host/game.mjs'
import { createTunnelManager, pickLocalPort } from './src/host/tunnel.mjs'
import { startServer } from './src/host/server.mjs'
import { getRules } from './src/rules/index.mjs'

export const name = 'xiangqi'
export const inject = ['tools']

const SIDE_TEXT = { red: '红方', black: '黑方' }
const STATUS_TEXT = {
  playing: '进行中',
  'red-win': '红方胜',
  'black-win': '黑方胜',
  draw: '和棋',
}
const END_REASON_TEXT = {
  timeout: '超时',
  resign: '认输',
  draw: '和棋',
  checkmate: '将死',
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatClock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00'
  const total = Math.floor(ms / 1000)
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
}

function turnText(snapshot) {
  return SIDE_TEXT[snapshot.turn] || '未知'
}

function statusLine(snapshot) {
  const status = STATUS_TEXT[snapshot.status] || snapshot.status
  const reason = snapshot.endReason ? `（${END_REASON_TEXT[snapshot.endReason] || snapshot.endReason}）` : ''
  return `${status}${reason} · 轮到${turnText(snapshot)} · 剩余 ${formatClock(snapshot.remainingMs)}`
}

function movesLine(moves) {
  if (!Array.isArray(moves) || moves.length === 0) return '棋谱：（尚未落子）'
  const parts = []
  for (let i = 0; i < moves.length; i += 2) {
    const red = moves[i]
    const black = moves[i + 1]
    parts.push(`${Math.floor(i / 2) + 1}. ${red ? red.notation || red.iccs : '—'} ${black ? black.notation || black.iccs : ''}`.trim())
  }
  return `棋谱（${moves.length} 手）：${parts.join('  ')}`
}

function boardText(snapshot) {
  const lines = [
    `对局 ${snapshot.gameId} · ${statusLine(snapshot)}`,
    `FEN：${snapshot.fen}`,
    '',
    ...(Array.isArray(snapshot.ascii) ? snapshot.ascii : ['（棋盘不可用）']),
    '',
    snapshot.lastMove
      ? `最近一手：${snapshot.lastMove.notation || ''}（${snapshot.lastMove.iccs}）`
      : '最近一手：（尚未落子）',
    movesLine(snapshot.moves),
  ]
  return lines.join('\n')
}

function gameOverHint(snapshot) {
  if (!snapshot || snapshot.status === 'playing') return ''
  const winner =
    snapshot.status === 'draw'
      ? '和棋'
      : snapshot.status === 'red-win'
        ? '红方胜'
        : '黑方胜'
  return `\n对局已结束：${winner}${snapshot.endReason ? `（${END_REASON_TEXT[snapshot.endReason] || snapshot.endReason}）` : ''}。用 xiangqi_new_game 再来一局。`
}

function isIccsLike(text) {
  return /^[a-iA-I][0-9]-?[a-iA-I][0-9]$/.test(String(text || '').trim())
}

/** 单个工具统一的输出投影：纯函数，只产出 text 内容块。 */
function textOutput(schema = { type: 'string' }) {
  return {
    schema,
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  }
}

/**
 * DSH 插件入口。
 * @param {object} ctx cordis 上下文（已注入 tools）
 */
export function apply(ctx) {
  const state = {
    config: null,
    service: null,
    server: null,
    tunnel: null,
    starting: null,
    startError: null,
    disposed: false,
  }

  const { config, warnings, source } = loadConfig()
  state.config = config
  for (const warning of warnings) console.error(`[xiangqi] ${warning}`)
  if (source !== 'none') console.error(`[xiangqi] 配置来源：${source}`)

  const rules = getRules('xiangqi')

  const publicUrl = () => {
    if (state.tunnel) {
      try {
        const status = state.tunnel.status()
        if (status.status === 'running' && status.url) return status.url
      } catch {
        /* 隧道状态不可用时退回本地地址 */
      }
    }
    return state.server ? state.server.url : null
  }

  state.service = createGameService({
    rules,
    minutes: config.minutes,
    runtime: () => ({
      port: state.server ? state.server.port : null,
      url: publicUrl() || `http://127.0.0.1:${config.port || 5000}`,
      tunnel: state.tunnel ? state.tunnel.status() : null,
    }),
  })

  // ---- 自动唤醒：人类在网页走完子后，主动给「发起对局的 agent」补一条用户消息 ----
  // 没有推送就没有对弈体感：agent 不会自己醒来查局面。这里在状态变化后 followup 一条消息。
  state.wake = { sessionId: null, lastKey: null, timer: null }

  /** 在工具调用里记录「发起对局的会话」（agent 上下文里有 initiator）。 */
  function captureSession() {
    try {
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : null
      const agent = agents && typeof agents.currentInitiator === 'function' ? agents.currentInitiator() : null
      const id = agent && agent.session && agent.session.id ? String(agent.session.id) : null
      if (id && id !== state.wake.sessionId) {
        state.wake.sessionId = id
        console.error(`[xiangqi] 自动唤醒已绑定会话 ${id}`)
      }
    } catch {
      /* 非 agent 上下文（例如 --help 冒烟）忽略 */
    }
  }

  function makeUserMessage(text) {
    return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  }

  async function wakeAgent(text) {
    const sessionId = state.wake.sessionId
    if (!sessionId) return false
    try {
      const controller = typeof ctx.get === 'function' ? ctx.get('sessionController') : null
      if (!controller || typeof controller.resolveAgent !== 'function') return false
      const resolved = await controller.resolveAgent(sessionId)
      if (!resolved || resolved.error || !resolved.agent) return false
      const agent = resolved.agent
      if (typeof agent.followup !== 'function') return false
      agent.followup(makeUserMessage(text))
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : null
      if (sessions && typeof sessions.flush === 'function') await sessions.flush(agent.session)
      return true
    } catch (error) {
      console.error(`[xiangqi] 自动唤醒失败：${error && error.message ? error.message : error}`)
      return false
    }
  }

  /** 状态变化后按需唤醒（去重 + 500ms 合并抖动）。 */
  function scheduleWake(snapshot) {
    if (!config.autoWake || !state.wake.sessionId || !snapshot) return
    const playing = snapshot.status === 'playing'
    if (playing && snapshot.turn !== snapshot.agentSide) return
    const key = `${snapshot.gameId}:${playing ? `move:${snapshot.rev}` : 'end'}`
    if (state.wake.lastKey === key) return
    state.wake.lastKey = key
    if (state.wake.timer) clearTimeout(state.wake.timer)
    state.wake.timer = setTimeout(() => {
      state.wake.timer = null
      const last = snapshot.lastMove
      const who = snapshot.agentSide === 'red' ? '红方' : '黑方'
      const moveText = last && last.notation ? `${last.notation}${last.iccs ? `（${last.iccs}）` : ''}` : `第 ${snapshot.rev} 手`
      const text = playing
        ? `[象棋自动唤醒] 对手刚走 ${moveText}，现在轮到你（${who}）。\n用 xiangqi_board 看当前局面，用 xiangqi_move 应手；走完可继续 xiangqi_wait 等对方落子。`
        : `[象棋自动唤醒] 对局已结束：${snapshot.status}${snapshot.endReason ? `（${snapshot.endReason}）` : ''}。可用 xiangqi_record 导出记谱。`
      void wakeAgent(text).then((ok) => {
        if (!ok) console.error('[xiangqi] 自动唤醒未送达（会话可能已关闭或服务不可用）')
      })
    }, 500)
    if (typeof state.wake.timer.unref === 'function') state.wake.timer.unref()
  }

  state.service.subscribe((snapshot) => {
    try {
      scheduleWake(snapshot)
    } catch {
      /* 唤醒失败不影响对局 */
    }
  })
  ctx.effect(() => () => {
    if (state.wake && state.wake.timer) clearTimeout(state.wake.timer)
  }, 'xiangqi: auto-wake timer')

  /** 懒启动 HTTP 服务（apply 内不 await）。返回 server 或 null。 */
  function ensureReady() {
    if (state.disposed) return Promise.resolve(null)
    if (state.server) return Promise.resolve(state.server)
    if (state.starting) return state.starting
    const promise = (async () => {
      const rawRange = Array.isArray(config.portRange) ? config.portRange : [5000, 5050]
      const [rangeLo, rangeHi] = rawRange.map(Number)
      const lo = Number.isInteger(rangeLo) && rangeLo > 0 ? rangeLo : 5000
      const hi = Number.isInteger(rangeHi) && rangeHi >= lo ? rangeHi : 5050
      const explicitPort = Number.isInteger(config.port) && config.port > 0 ? config.port : null
      const port = explicitPort ?? (await pickLocalPort(lo, hi, config.host))
      config.port = port
      if (!state.tunnel) {
        state.tunnel = createTunnelManager({
          config,
          log: (line) => console.error(line),
        })
      }
      const server = await startServer({
        service: state.service,
        tunnel: state.tunnel,
        token: config.token || null,
        port,
        assetsDir: join(REPO_ROOT, 'web'),
        preview: false,
        host: config.host,
        unref: true, // 不让端口绑定阻止宿主进程退出（--help 冒烟）
      })
      if (state.disposed) {
        await server.close().catch(() => {})
        return null
      }
      state.server = server
      state.startError = null
      if (server.port < lo || server.port > hi) {
        console.error(
          `[xiangqi] 提示：服务绑定到 ${server.port}（不在 ${lo}-${hi} 范围内，通常是系统分配）。隧道会使用真实端口 ${server.port}。`,
        )
      }
      console.error(`[xiangqi] 服务已启动：${server.url}（邀请链接用 xiangqi_new_game 获取）`)
      return server
    })()
      .catch((error) => {
        state.startError = error
        console.error(
          `[xiangqi] 服务启动失败（不影响插件加载）：${error && error.message ? error.message : error}`,
        )
        return null
      })
      .finally(() => {
        state.starting = null
      })
    state.starting = promise
    return promise
  }

  // 立即异步启动（不 await）：插件加载与 --help 都不被阻塞。
  void ensureReady()

  function notReadyText() {
    const reason = state.startError ? `（${state.startError.message || state.startError}）` : ''
    return `服务尚未就绪${reason}。请稍后重试，或用 xiangqi_status 查看状态。`
  }

  function safeSnapshot() {
    try {
      return state.service.snapshot()
    } catch {
      return null
    }
  }

  function waitForChange({ timeoutMs, sinceRev, signal } = {}) {
    const cap = Math.min(Math.max(Number(timeoutMs) || 30000, 1000), 120000)
    const current = safeSnapshot()
    if (!current) return Promise.resolve({ reason: 'no-game', snapshot: null })
    const baseRev = Number.isInteger(sinceRev) ? sinceRev : current.rev
    if (current.rev > baseRev || current.status !== 'playing') {
      return Promise.resolve({ reason: 'changed', snapshot: current })
    }
    return new Promise((resolvePromise) => {
      let settled = false
      let timer = null
      const finish = (result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        unsubscribe()
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort)
        }
        resolvePromise(result)
      }
      const onAbort = () => finish({ reason: 'aborted', snapshot: safeSnapshot() })
      const unsubscribe = state.service.subscribe((snapshot) => {
        if (snapshot.rev > baseRev || snapshot.status !== 'playing') {
          finish({ reason: 'changed', snapshot })
        }
      })
      if (signal && signal.aborted) {
        finish({ reason: 'aborted', snapshot: safeSnapshot() })
        return
      }
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true })
      }
      timer = setTimeout(() => finish({ reason: 'timeout', snapshot: safeSnapshot() }), cap)
      if (typeof timer.unref === 'function') timer.unref()
      const after = safeSnapshot()
      if (after && (after.rev > baseRev || after.status !== 'playing')) {
        finish({ reason: 'changed', snapshot: after })
      }
    })
  }

  async function writeRecordFile(markdown, snapshot) {
    try {
      const dir = join(state.config.dataDir, 'games')
      await mkdir(dir, { recursive: true })
      const safeId = String(snapshot.gameId || 'game').replace(/[^a-z0-9-]/gi, '')
      await writeFile(join(dir, `${safeId}.md`), markdown, 'utf8')
    } catch (error) {
      console.error(`[xiangqi] 记谱落盘失败：${error && error.message ? error.message : error}`)
    }
  }

  function tunnelStatusText(status) {
    const provider = status.provider || 'cloudflared'
    const lines = [
      `隧道状态：${status.status} · 提供方 ${provider}`,
      status.url ? `公网地址：${status.url}` : '公网地址：（暂无）',
      `本地端口：${status.localPort ?? config.port ?? '（未知）'}`,
    ]
    if (status.error) lines.push(`原因：${status.error}`)
    return lines.join('\n')
  }

  const toolDefinitions = [
    {
      name: 'xiangqi_new_game',
      description:
        '新建一局中国象棋（单局制：会立即作废上一局、旧邀请口令与旧记谱）。返回邀请 URL（含 18 位口令）、谁先走与初始局面。人类用浏览器打开邀请 URL 对弈，agent 用 xiangqi_move 走子。',
      parameters: {
        humanSide: {
          type: 'string',
          enum: ['red', 'black'],
          description: '人类执哪一方，默认 red（红先）',
        },
        minutes: {
          type: 'integer',
          description: '本局全局限时（分钟），默认 20；第一手落子才开始计时',
        },
      },
      output: textOutput(),
      async execute(args = {}) {
        captureSession()
        const server = await ensureReady()
        const created = state.service.newGame({
          humanSide: args.humanSide === 'black' ? 'black' : 'red',
          minutes: args.minutes,
          token: state.config.token || undefined,
        })
        const snapshot = created.snapshot
        if (server && typeof server.setToken === 'function') server.setToken(created.token)
        const base = publicUrl() || (server ? server.url : null)
        const invite = base ? `${base}${created.urlPath}` : `${created.urlPath}（服务未就绪，稍后用 xiangqi_status 取地址）`
        return [
          `已新建对局 ${snapshot.gameId}。`,
          `邀请 URL：${invite}`,
          `口令：${created.token}（只在本消息返回，请转交给人类；不要写进任何文件或记谱）`,
          `人类执${SIDE_TEXT[snapshot.humanSide]}，agent 执${SIDE_TEXT[snapshot.agentSide]}；${turnText(snapshot)}先走。`,
          `限时 ${snapshot.minutes} 分钟，第一手落子开始计时。`,
          '',
          boardText(snapshot),
        ].join('\n')
      },
    },
    {
      name: 'xiangqi_board',
      description:
        '查看当前棋局：文字棋盘、FEN、轮到谁、剩余时间、最近一手与完整棋谱。agent 每步之前先调它确认局面。',
      parameters: {},
      output: textOutput(),
      async execute() {
        const snapshot = safeSnapshot()
        if (!snapshot) return '当前还没有对局。请先调用 xiangqi_new_game 新建一局。'
        return `${boardText(snapshot)}${gameOverHint(snapshot)}`
      },
    },
    {
      name: 'xiangqi_move',
      description:
        '按当前局面走一步棋。接受 ICCS（如 h2e2、h2-e2）或中文记谱（如 炮二平五）。非法走子会返回人话原因（code + message），不会抛错。',
      parameters: {
        move: {
          type: 'string',
          required: true,
          description: '着法：ICCS 如 h2e2 / h2-e2，或中文记谱如 炮二平五',
        },
      },
      output: textOutput(),
      async execute(args = {}) {
        captureSession()
        if (!state.service.hasGame()) return '当前还没有对局。请先调用 xiangqi_new_game 新建一局。'
        const text = String(args.move || '').trim()
        if (!text) return '缺少 move 参数：请给 ICCS（如 h2e2）或中文记谱（如 炮二平五）。'
        const input = isIccsLike(text) ? { iccs: text } : { notation: text }
        try {
          const result = state.service.move(input)
          const snapshot = result.snapshot
          return [
            `走子成功：${snapshot.lastMove.notation || ''}（${snapshot.lastMove.iccs}）。`,
            boardText(snapshot),
            gameOverHint(snapshot),
          ]
            .filter(Boolean)
            .join('\n')
        } catch (error) {
          if (error instanceof GameError || (error && error.code && error.status)) {
            return `走子失败（${error.code}）：${error.message}\n${boardText(safeSnapshot() || {})}`
          }
          return `走子失败：${error && error.message ? error.message : error}`
        }
      },
    },
    {
      name: 'xiangqi_wait',
      description:
        '等待人类走子或对局状态变化（最多 120 秒）。返回新局面；超时返回「等待超时」与当前局面。适合 agent 走完一步后等人类回应。',
      parameters: {
        timeoutMs: {
          type: 'integer',
          description: '等待上限（毫秒），默认 30000，最大 120000',
        },
        sinceRev: {
          type: 'integer',
          description: '从哪个 rev 之后开始算新变化；默认用当前 rev',
        },
      },
      output: textOutput(),
      async execute(args = {}, exec = {}) {
        const result = await waitForChange({
          timeoutMs: args.timeoutMs,
          sinceRev: args.sinceRev,
          signal: exec && exec.signal,
        })
        if (result.reason === 'no-game' || !result.snapshot) {
          return '当前还没有对局。请先调用 xiangqi_new_game 新建一局。'
        }
        const snapshot = result.snapshot
        if (result.reason === 'timeout') {
          return `等待超时：人类还没有走子。\n${boardText(snapshot)}`
        }
        if (result.reason === 'aborted') {
          return `等待被取消。\n${boardText(snapshot)}`
        }
        return `局面已变化。\n${boardText(snapshot)}${gameOverHint(snapshot)}`
      },
    },
    {
      name: 'xiangqi_record',
      description:
        '导出 Markdown 记谱全文（中文记谱 + ICCS + FEN + 文字棋盘 + 给 agent 的下一步），同时落盘到数据目录 games/<gameId>.md。口令不会写进记谱。',
      parameters: {},
      output: textOutput(),
      async execute() {
        const snapshot = safeSnapshot()
        if (!snapshot) return '当前还没有对局。请先调用 xiangqi_new_game 新建一局。'
        const markdown = state.service.recordMarkdown({ baseUrl: publicUrl() || undefined })
        await writeRecordFile(markdown, snapshot)
        return markdown
      },
    },
    {
      name: 'xiangqi_tunnel',
      description:
        '开/关/查内网穿透，返回公网 URL。provider 默认 cloudflared（quick tunnel，需本机可访问 Cloudflare 并走系统代理）；natfrp 需要本地配置凭据，未配置会返回 NOT_CONFIGURED 并提示改用 cloudflared。',
      parameters: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status'],
          required: true,
          description: 'start 开隧道 / stop 关隧道 / status 查询',
        },
        provider: {
          type: 'string',
          enum: ['cloudflared', 'natfrp'],
          description: '提供方，默认 cloudflared',
        },
      },
      output: textOutput(),
      async execute(args = {}) {
        const action = String(args.action || 'status')
        if (action === 'start') {
          const server = await ensureReady()
          if (!server) return notReadyText()
          try {
            const status = await state.tunnel.start(args.provider, { port: server.port })
            return `隧道已开启。\n${tunnelStatusText(status)}`
          } catch (error) {
            const status = state.tunnel ? state.tunnel.status() : {}
            return `隧道启动失败（${(error && error.code) || 'ERROR'}）：${
              (error && error.message) || error
            }\n${tunnelStatusText({ ...status, error: (error && error.message) || String(error) })}`
          }
        }
        if (action === 'stop') {
          if (!state.tunnel) return '隧道管理器尚未初始化。'
          const status = await state.tunnel.stop()
          return `隧道已关闭。\n${tunnelStatusText(status)}`
        }
        if (action !== 'status') return 'action 只支持 start / stop / status。'
        if (!state.tunnel) return '隧道管理器尚未初始化。'
        return tunnelStatusText(state.tunnel.status())
      },
    },
    {
      name: 'xiangqi_status',
      description:
        '查看站点地址、口令是否就绪、隧道状态、对局状态与剩余时间。不返回口令明文。',
      parameters: {},
      output: textOutput(),
      async execute() {
        captureSession()
        const status = state.service.status()
        const lines = [
          `站点地址：${publicUrl() || '（服务尚未就绪）'}`,
          `口令：${status.tokenSet ? '已就绪' : '未创建对局（先调 xiangqi_new_game）'}`,
        ]
        if (status.gameId) {
          lines.push(
            `对局：${status.gameId} · ${STATUS_TEXT[status.status] || status.status} · 轮到${
              SIDE_TEXT[status.turn] || '未知'
            } · 剩余 ${formatClock(status.remainingMs)}`,
          )
        } else {
          lines.push('对局：暂无')
        }
        if (state.tunnel) {
          const tunnel = state.tunnel.status()
          lines.push(
            `隧道：${tunnel.status} · ${tunnel.provider || 'cloudflared'}${
              tunnel.url ? ` · ${tunnel.url}` : ''
            }${tunnel.error ? ` · ${tunnel.error}` : ''}`,
          )
        } else {
          lines.push('隧道：未初始化')
        }
        if (state.startError) lines.push(`服务启动错误：${state.startError.message || state.startError}`)
        const wakeSession = state.wake && state.wake.sessionId ? state.wake.sessionId.slice(0, 8) : null
        lines.push(
          `自动唤醒：${config.autoWake ? '已开启' : '已关闭'}${
            wakeSession ? `（会话 ${wakeSession}…）` : '（尚未绑定会话：先调 xiangqi_new_game 才会绑定）'
          }`,
        )
        return lines.join('\n')
      },
    },
  ]

  if (!ctx || !ctx.tools || typeof ctx.tools.register !== 'function') {
    console.error('[xiangqi] 缺少 ctx.tools，工具未注册')
    return
  }
  for (const definition of toolDefinitions) ctx.tools.register(definition)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      state.disposed = true
      const tasks = []
      if (state.server) tasks.push(Promise.resolve(state.server.close()).catch(() => {}))
      if (state.tunnel) tasks.push(Promise.resolve(state.tunnel.stop()).catch(() => {}))
      return Promise.all(tasks).then(() => {
        console.error('[xiangqi] 服务与隧道已关闭')
      })
    })
  }
}

export default { name, inject, apply }
