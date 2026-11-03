// 对局服务（单局制）。契约见 docs/DESIGN.md §4。
//
// 要点：
// - 18 位口令只在 newGame()/action('restart') 时返回明文；内部只存 SHA-256 摘要，
//   verifyToken() 用 timingSafeEqual 做常数时间比较；restart 立即换新口令。
// - 20 分钟全局限时：第一手落子才开始计时（startedAt/deadline 落子前为 null），
//   时钟可注入（now），超时方判负。
// - move() 接受 {from,to} / {iccs:'h2e2'} / {notation:'炮二平五'} 三种入参；
//   失败抛 GameError{code,message,status}。
// - subscribe(fn) 在每次状态变化后广播快照；recordMarkdown() 优先委托 src/record.mjs
//   （规则层可能尚未就绪，内置渲染兜底），口令永远只以 <token> 占位出现。
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_LENGTH = 18
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const TOKEN_RE = /^[a-z0-9]{18}$/
const STATUS_TEXT = {
  playing: '进行中',
  'red-win': '红方胜',
  'black-win': '黑方胜',
  draw: '和棋',
}
const SIDE_TEXT = { red: '红方', black: '黑方' }
const COLOR_TEXT = { red: '红方', black: '黑方' }

/** 对局服务错误：{code,message,status}，HTTP 映射 400/409/410。 */
export class GameError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.name = 'GameError'
    this.code = code
    this.status = status
  }
}

/** 18 位口令：[a-z0-9]。 */
export function generateToken() {
  const bytes = randomBytes(TOKEN_LENGTH)
  let out = ''
  for (let i = 0; i < TOKEN_LENGTH; i += 1) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length]
  return out
}

/** SHA-256 摘要（口令只以摘要形式留存）。 */
export function digestToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest()
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n)
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
}

function formatDateStamp(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
}

function newGameId(ts) {
  const rand = randomBytes(2).toString('hex')
  return `xq-${formatDateStamp(ts)}-${rand}`
}

function cloneMove(move) {
  return {
    n: move.n,
    color: move.color,
    iccs: move.iccs,
    notation: move.notation,
    at: move.at,
    tags: Array.isArray(move.tags) ? move.tags.slice() : [],
    comment: typeof move.comment === 'string' ? move.comment : '',
  }
}

// ---------------------------------------------------------------------------
// 记谱渲染：优先委托规则层的 src/record.mjs；没有就内置一份 DESIGN §8 格式。
// 规则层尚未落盘时不影响宿主层单测（动态 import 失败 → 内置兜底）。
// ---------------------------------------------------------------------------
let externalRecordRenderer = null
let recordRendererSource = 'builtin'
try {
  const mod = await import('../record.mjs')
  if (typeof mod.renderRecordMd === 'function') {
    externalRecordRenderer = mod.renderRecordMd
    recordRendererSource = 'src/record.mjs'
  }
} catch {
  // 规则层尚未就绪：静默兜底，等 src/record.mjs 出现后自动切换。
}

/** 当前记谱渲染来源：'src/record.mjs' | 'builtin'（供测试/状态回报）。 */
export function getRecordRendererSource() {
  return recordRendererSource
}

function tagsSuffix(move) {
  if (!move) return ''
  const comment = typeof move.comment === 'string' && move.comment ? `（${move.comment}）` : ''
  const tags = Array.isArray(move.tags) && move.tags.length > 0 ? ' ' + move.tags.join('·') : ''
  return comment + tags
}

function moveRows(moves) {
  const rows = []
  for (let i = 0; i < moves.length; i += 2) {
    const red = moves[i]
    const black = moves[i + 1]
    rows.push(
      `| ${Math.floor(i / 2) + 1} | ${red ? red.notation + tagsSuffix(red) : ''} | ${
        black ? black.notation + tagsSuffix(black) : ''
      } |`,
    )
  }
  return rows
}

/** 内置 Markdown 记谱（DESIGN §8），口令一律 <token> 占位。 */
export function renderRecordMarkdown(snapshot, meta = {}) {
  const baseUrl = (meta.baseUrl || meta.base || 'http://127.0.0.1:5000').replace(/\/+$/, '')
  const humanSide = snapshot.humanSide || 'red'
  const agentSide = snapshot.agentSide || 'black'
  const statusText = STATUS_TEXT[snapshot.status] || snapshot.status
  const turnText = SIDE_TEXT[snapshot.turn] || snapshot.turn
  const remaining = formatClock(snapshot.remainingMs || 0)
  const last = snapshot.lastMove
  const lines = []
  lines.push(
    `# 象棋对局 ${snapshot.gameId} · 红方：${humanSide === 'red' ? '人类' : 'agent'} · 黑方：${
      agentSide === 'black' ? 'agent' : '人类'
    }`,
  )
  lines.push('')
  lines.push(`- 状态：${statusText} · 轮到：${turnText} · 剩余：${remaining}`)
  lines.push(`- FEN：\`${snapshot.fen}\``)
  lines.push(
    `- 最近一手：${last ? `${last.notation || ''}（${last.iccs}）${[last.comment, ...(Array.isArray(last.tags) ? last.tags : [])].filter(Boolean).length ? ' · ' + [last.comment, ...(Array.isArray(last.tags) ? last.tags : [])].filter(Boolean).join(' · ') : ''}` : '（暂无）'}`,
  )
  lines.push('')
  lines.push('## 棋盘')
  lines.push('')
  const ascii = Array.isArray(snapshot.ascii) ? snapshot.ascii : []
  if (ascii.length === 0) lines.push('（棋盘暂不可用）')
  else lines.push(...ascii)
  lines.push('')
  lines.push('## 着法')
  lines.push('')
  lines.push('| 回合 | 红方 | 黑方 |')
  lines.push('|---:|---|---|')
  const rows = moveRows(Array.isArray(snapshot.moves) ? snapshot.moves : [])
  if (rows.length === 0) lines.push('| 1 | （未开始） | |')
  else lines.push(...rows)
  lines.push('')
  lines.push('## 给 agent 的下一步（可直接复制）')
  lines.push('')
  lines.push(`- 拉当前局面：\`GET ${baseUrl}/api/state\`，头 \`x-xiangqi-token: <token>\``)
  lines.push(`- 走子：\`POST ${baseUrl}/api/move\`，body \`{"from":"h2","to":"e2"}\``)
  lines.push(`- 记谱：\`GET ${baseUrl}/api/record.md\``)
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------

function isSquareObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    Number.isInteger(value.file) &&
    Number.isInteger(value.rank)
  )
}

function normalizeText(text) {
  return String(text || '')
    .replace(/[\s\u3000]/g, '')
    .trim()
}

/**
 * 创建对局服务。
 * @param {object} options
 * @param {object} options.rules 规则层（src/rules/index.mjs 的 getRules() 返回值）
 * @param {number} [options.minutes=20] 默认全局限时（分钟）
 * @param {() => number} [options.now] 可注入时钟（测试用）
 * @param {() => {port?:number,url?:string,tunnel?:object}} [options.runtime] 运行态（端口/隧道）
 * @param {(snapshot:object, meta?:object) => string} [options.record] 记谱渲染器覆盖
 */
export function createGameService({ rules, minutes = 20, now = () => Date.now(), runtime, record } = {}) {
  if (!rules || typeof rules.initialBoard !== 'function') {
    throw new TypeError('createGameService: 缺少规则层（rules.initialBoard 不存在）')
  }
  const defaultMinutes = Number(minutes) > 0 ? Number(minutes) : 20
  const renderRecord = typeof record === 'function' ? record : externalRecordRenderer

  /** 单局状态；null 表示还没有对局。 */
  let state = null
  const subscribers = new Set()

  function buildCoreSnapshot() {
    const s = state
    const fen = rules.toFen(s.board)
    const gameMinutes = Number(s.minutes) > 0 ? Number(s.minutes) : defaultMinutes
    const remainingMs = s.deadline ? Math.max(0, s.deadline - now()) : gameMinutes * 60000
    return {
      gameId: s.gameId,
      fen,
      turn: s.board.turn || s.turn,
      status: s.status,
      rev: s.rev,
      moves: s.moves.map(cloneMove),
      lastMove: s.lastMove
        ? {
            iccs: s.lastMove.iccs,
            from: s.lastMove.from,
            to: s.lastMove.to,
            notation: s.lastMove.notation,
            tags: Array.isArray(s.lastMove.tags) ? s.lastMove.tags.slice() : [],
            comment: typeof s.lastMove.comment === 'string' ? s.lastMove.comment : '',
          }
        : null,
      humanSide: s.humanSide,
      agentSide: s.agentSide,
      startedAt: s.startedAt,
      deadline: s.deadline,
      remainingMs,
      ascii: rules.asciiBoard(s.board),
      // 以下为契约外的补充字段（前端展示胜负原因、限时长度用）
      endReason: s.endReason || null,
      minutes: s.minutes,
      ply: s.moves.length,
    }
  }

  function baseUrlForRecord() {
    try {
      const rt = typeof runtime === 'function' ? runtime() : null
      if (rt && rt.url) return rt.url
    } catch {
      /* runtime 不可用时退回本地默认 */
    }
    return `http://127.0.0.1:${(typeof runtime === 'function' && runtime()?.port) || 5000}`
  }

  function renderRecordMarkdownFor(meta, core) {
    const baseUrl = (meta && meta.baseUrl) || baseUrlForRecord()
    // token 永远是 <token> 占位：即使调用方误传 token 也不写进 md。
    const mergedMeta = { ...(meta || {}), base: baseUrl, baseUrl, token: '<token>' }
    if (typeof renderRecord === 'function') {
      try {
        // 兼容规则层可能采用的多种签名：renderRecordMd(snapshot) /
        // renderRecordMd({snapshot, meta}) / renderRecordMd(snapshot, meta)。
        const arg = {
          ...core,
          snapshot: core,
          meta: mergedMeta,
          base: mergedMeta.base,
          token: mergedMeta.token,
        }
        const out = renderRecord(arg, mergedMeta)
        if (typeof out === 'string' && out.trim()) return out
      } catch {
        // 委托失败时退回内置渲染，保证工具与 /api/record.md 永远可用
      }
    }
    return renderRecordMarkdown(core, mergedMeta)
  }

  function buildSnapshot() {
    const core = buildCoreSnapshot()
    core.recordMarkdown = renderRecordMarkdownFor({}, core)
    return core
  }

  function broadcast() {
    if (!state) return
    const snapshot = buildSnapshot()
    for (const fn of [...subscribers]) {
      try {
        fn(snapshot)
      } catch {
        // 单个订阅者出错不影响其它订阅者（SSE / 工具等待）
      }
    }
  }

  function requireGame() {
    if (!state) throw new GameError('NO_GAME', '当前没有对局，请先新建一局（xiangqi_new_game）', 410)
    return state
  }

  /** 惰性时钟检查：超时方判负。返回是否发生了状态变化。 */
  function syncClock() {
    const s = state
    if (!s || s.status !== 'playing' || !s.deadline) return false
    if (now() < s.deadline) return false
    s.status = s.turn === 'red' ? 'black-win' : 'red-win'
    s.endReason = 'timeout'
    s.rev += 1
    broadcast()
    return true
  }

  function pushHistory() {
    const s = state
    s.history.push({
      board: s.board,
      moves: s.moves.map(cloneMove),
      lastMove: s.lastMove,
      startedAt: s.startedAt,
      deadline: s.deadline,
      status: s.status,
      endReason: s.endReason,
      turn: s.turn,
      rev: s.rev,
    })
    if (s.history.length > 200) s.history.shift()
  }

  function toSquare(value) {
    if (isSquareObject(value)) {
      if (value.file < 0 || value.file > 8 || value.rank < 0 || value.rank > 9) return null
      return { file: value.file, rank: value.rank }
    }
    if (typeof value === 'string') {
      const parsed = rules.parseSquare(value.trim().toLowerCase())
      return parsed || null
    }
    return null
  }

  function resolveIccs(text) {
    const cleaned = String(text).trim().toLowerCase().replace(/[\s-]/g, '')
    const match = /^([a-i][0-9])([a-i][0-9])$/.exec(cleaned)
    if (!match) return null
    const from = toSquare(match[1])
    const to = toSquare(match[2])
    if (!from || !to) return null
    return { from, to }
  }

  function resolveMoveInput(input) {
    if (!input || typeof input !== 'object') {
      throw new GameError('BAD_REQUEST', '缺少走子参数：需要 {from,to}、{iccs} 或 {notation}', 400)
    }
    if (typeof input.iccs === 'string' && input.iccs.trim()) {
      const resolved = resolveIccs(input.iccs)
      if (!resolved) {
        throw new GameError('OUT_OF_BOARD', `无法识别的 ICCS 着法：${input.iccs}`, 409)
      }
      return resolved
    }
    if (input.from !== undefined || input.to !== undefined) {
      const from = toSquare(input.from)
      const to = toSquare(input.to)
      if (!from || !to) {
        throw new GameError('OUT_OF_BOARD', '坐标超出棋盘（纵线 a-i，横线 0-9）', 409)
      }
      return { from, to }
    }
    if (typeof input.notation === 'string' && input.notation.trim()) {
      const target = normalizeText(input.notation)
      const board = requireGame().board
      const candidates = rules.legalMoves(board) || []
      for (const move of candidates) {
        let text = ''
        try {
          text = normalizeText(rules.notation(board, move))
        } catch {
          text = ''
        }
        if (text === target) return { from: move.from, to: move.to }
      }
      throw new GameError('ILLEGAL_MOVE', `无法识别记谱「${input.notation}」，请改用 ICCS（如 h2e2）`, 409)
    }
    throw new GameError('BAD_REQUEST', '缺少走子参数：需要 {from,to}、{iccs} 或 {notation}', 400)
  }

  const service = {
    /** 新建一局（单局制：旧局、旧口令、旧记谱立即作废）。 */
    newGame(options = {}) {
      const humanSide = options.humanSide === 'black' ? 'black' : 'red'
      const agentSide = humanSide === 'red' ? 'black' : 'red'
      const limit = Number(options.minutes) > 0 ? Number(options.minutes) : defaultMinutes
      let token = options.token
      if (typeof token !== 'string' || !TOKEN_RE.test(token.toLowerCase())) token = generateToken()
      token = token.toLowerCase()
      const board = rules.initialBoard()
      const ts = now()
      state = {
        gameId: newGameId(ts),
        board,
        turn: board.turn || 'red',
        status: 'playing',
        endReason: null,
        rev: 1,
        moves: [],
        lastMove: null,
        humanSide,
        agentSide,
        minutes: limit,
        startedAt: null,
        deadline: null,
        history: [],
        tokenDigest: digestToken(token),
      }
      broadcast()
      return { snapshot: buildSnapshot(), token, urlPath: `/?k=${token}` }
    },

    /** 当前快照（会先做一次时钟检查）。 */
    snapshot() {
      requireGame()
      syncClock()
      return buildSnapshot()
    },

    /** 走子：接受 {from,to} / {iccs} / {notation}。失败抛 GameError。 */
    move(input) {
      const s = requireGame()
      syncClock()
      if (s.status !== 'playing') {
        throw new GameError('GAME_OVER', `对局已结束（${STATUS_TEXT[s.status] || s.status}）`, 409)
      }
      const { from, to } = resolveMoveInput(input)
      const move = {
        from,
        to,
        iccs: `${rules.squareName(from)}${rules.squareName(to)}`,
        capture: Boolean(s.board.squares?.[to.rank * 9 + to.file]),
      }
      const verdict = rules.validateMove(s.board, move)
      if (!verdict || verdict.ok !== true) {
        throw new GameError(
          (verdict && verdict.code) || 'ILLEGAL_MOVE',
          (verdict && verdict.message) || '这步棋不合法',
          409,
        )
      }
      // 规则层会返回归一化后的 Move（含 iccs/capture），优先用它
      const applied = verdict.move || move
      const iccs = applied.iccs || `${rules.squareName(applied.from)}${rules.squareName(applied.to)}`
      const notation = (() => {
        try {
          return rules.notation(s.board, applied)
        } catch {
          return iccs
        }
      })()
      const nextBoard = rules.applyMove(s.board, applied)
      // 招数标签：将军 / 将军抽车 / 将死 / 吃X / 捉双 / 应将 / 过河 / 双将
      const tags = (() => {
        try {
          return typeof rules.moveTags === 'function' ? rules.moveTags(s.board, applied) || [] : []
        } catch {
          return []
        }
      })()
      // 招数解说短语（进车捉马 / 平炮打马 …）
      const comment = (() => {
        try {
          return typeof rules.moveComment === 'function' ? rules.moveComment(s.board, applied) || '' : ''
        } catch {
          return ''
        }
      })()
      // 解说里已经包含的标签不再重复（例如「进炮吃马」里不必再挂一个「吃马」）
      const dedupedTags = comment ? tags.filter((tag) => !comment.includes(tag)) : tags
      pushHistory()
      const at = now()
      if (s.startedAt === null) {
        s.startedAt = at
        s.deadline = at + s.minutes * 60000
      }
      s.moves.push({
        n: s.moves.length + 1,
        color: s.turn,
        iccs,
        notation,
        at,
        tags: dedupedTags,
        comment,
      })
      s.board = nextBoard
      s.turn = nextBoard.turn || (s.turn === 'red' ? 'black' : 'red')
      s.lastMove = { iccs, from: applied.from, to: applied.to, notation, tags: dedupedTags, comment }
      s.rev += 1
      const status = rules.statusOf(nextBoard)
      s.status = status || 'playing'
      if (s.status !== 'playing') s.endReason = s.status === 'draw' ? 'draw' : 'checkmate'
      broadcast()
      return { snapshot: buildSnapshot() }
    },

    /** 悔棋 / 认输 / 和棋 / 重开。重开会换新口令。 */
    action(type) {
      const s = requireGame()
      syncClock()
      const action = String(type || '').trim()
      if (action === 'restart') {
        return service.newGame({ humanSide: s.humanSide, minutes: s.minutes })
      }
      if (action === 'undo') {
        if (s.status !== 'playing') {
          throw new GameError('GAME_OVER', '对局已结束，不能悔棋', 409)
        }
        if (s.moves.length === 0) throw new GameError('NO_MOVES', '当前没有可悔的着法', 409)
        const previous = s.history.pop()
        if (!previous) throw new GameError('NO_MOVES', '当前没有可悔的着法', 409)
        s.board = previous.board
        s.moves = previous.moves
        s.lastMove = previous.lastMove
        s.startedAt = previous.startedAt
        s.deadline = previous.deadline
        s.status = previous.status === 'playing' ? 'playing' : previous.status
        s.endReason = previous.endReason
        s.turn = previous.turn
        s.rev += 1
        broadcast()
        return { snapshot: buildSnapshot() }
      }
      if (action === 'resign') {
        if (s.status !== 'playing') throw new GameError('GAME_OVER', '对局已结束', 409)
        s.status = s.humanSide === 'red' ? 'black-win' : 'red-win'
        s.endReason = 'resign'
        s.rev += 1
        broadcast()
        return { snapshot: buildSnapshot() }
      }
      if (action === 'draw') {
        if (s.status !== 'playing') throw new GameError('GAME_OVER', '对局已结束', 409)
        s.status = 'draw'
        s.endReason = 'draw'
        s.rev += 1
        broadcast()
        return { snapshot: buildSnapshot() }
      }
      throw new GameError('BAD_REQUEST', `未知操作：${action}`, 400)
    },

    /** 订阅状态变化，返回取消订阅函数。 */
    subscribe(fn) {
      if (typeof fn !== 'function') throw new TypeError('subscribe: 需要函数')
      subscribers.add(fn)
      return () => {
        subscribers.delete(fn)
      }
    },

    /** Markdown 记谱全文（口令永远 <token> 占位）。 */
    recordMarkdown(meta) {
      requireGame()
      syncClock()
      return renderRecordMarkdownFor(meta, buildCoreSnapshot())
    },

    /** 常数时间校验口令。 */
    verifyToken(text) {
      if (!state || typeof text !== 'string' || text.length === 0) return false
      const candidate = digestToken(text.toLowerCase())
      return timingSafeEqual(candidate, state.tokenDigest)
    },

    /** 全量合法着法索引：{"h2":["e2","h0"]}（前端只展示，不实现规则）。 */
    legalIndex() {
      const s = requireGame()
      syncClock()
      if (s.status !== 'playing') return {}
      const index = {}
      for (const move of rules.legalMoves(s.board) || []) {
        const from = rules.squareName(move.from)
        const to = rules.squareName(move.to)
        if (!index[from]) index[from] = []
        if (!index[from].includes(to)) index[from].push(to)
      }
      return index
    },

    /** 运行态摘要（端口/URL/隧道由宿主注入 runtime）。 */
    status() {
      const rt = typeof runtime === 'function' ? runtime() || {} : {}
      if (!state) {
        return {
          gameId: null,
          tokenSet: false,
          rev: 0,
          turn: null,
          status: 'no-game',
          remainingMs: 0,
          humanSide: null,
          agentSide: null,
          port: rt.port ?? null,
          url: rt.url ?? null,
          tunnel: rt.tunnel ?? null,
        }
      }
      const remainingMs = state.deadline
        ? Math.max(0, state.deadline - now())
        : state.minutes * 60000
      return {
        gameId: state.gameId,
        tokenSet: Boolean(state.tokenDigest),
        rev: state.rev,
        turn: state.board.turn || state.turn,
        status: state.status,
        remainingMs,
        humanSide: state.humanSide,
        agentSide: state.agentSide,
        port: rt.port ?? null,
        url: rt.url ?? null,
        tunnel: rt.tunnel ?? null,
      }
    },

    /** 是否有对局（工具判断用，不抛错）。 */
    hasGame() {
      return state !== null
    },
  }

  return service
}

export default createGameService
