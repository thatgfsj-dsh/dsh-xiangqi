/**
 * 五子棋对局服务（单局制），与象棋对局服务并列、接口形状对齐：
 * - 18 位口令只在 newGame()/restart 时返回明文，内部只存 SHA-256 摘要；
 * - 20 分钟全局限时（第一手才开始计时，时钟可注入）；
 * - move() 接受 {iccs:'h8'} / {file,rank} / {notation:'H8'}；
 * - subscribe(fn) 广播快照，recordMarkdown() 生成给 agent 的 md（口令只写 <token>）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as gomoku from '../gomoku/rules.mjs'

const TOKEN_LENGTH = 18
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const TOKEN_RE = /^[a-z0-9]{18}$/
const STATUS_TEXT = {
  playing: '进行中',
  'black-win': '黑方胜',
  'white-win': '白方胜',
  draw: '和棋',
}
const SIDE_TEXT = { black: '黑方', white: '白方' }

export class GomokuError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.name = 'GomokuError'
    this.code = code
    this.status = status
  }
}

export function generateToken() {
  const bytes = randomBytes(TOKEN_LENGTH)
  let out = ''
  for (let i = 0; i < TOKEN_LENGTH; i += 1) out += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length]
  return out
}

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
  return `gm-${formatDateStamp(ts)}-${rand}`
}

/** 由落子方推出胜方状态。 */
function winnerStatus(color) {
  return color === 'black' ? 'black-win' : 'white-win'
}

export function createGomokuService({ now = () => Date.now(), defaultMinutes = 20 } = {}) {
  let state = null
  let currentToken = null
  let tokenDigest = null
  const listeners = new Set()

  function requireGame() {
    if (!state) throw new GomokuError('NO_GAME', '还没有五子棋对局', 410)
    return state
  }

  function syncClock() {
    const s = state
    if (!s || s.status !== 'playing') return
    if (s.startedAt === null || s.deadline === null) return
    if (now() < s.deadline) return
    const loser = s.board.turn
    s.status = winnerStatus(loser === 'black' ? 'white' : 'black')
    s.endReason = 'timeout'
    broadcast()
  }

  function pushHistory() {
    const s = state
    s.history.push({ board: gomoku.cloneBoard(s.board), moves: s.moves.slice(), rev: s.rev, lastMove: s.lastMove })
    if (s.history.length > 200) s.history.shift()
  }

  function buildSnapshot() {
    const s = state
    if (!s) {
      return {
        kind: 'gomoku',
        gameId: null,
        size: gomoku.SIZE,
        cells: new Array(gomoku.SIZE * gomoku.SIZE).fill(null),
        turn: 'black',
        status: 'no-game',
        rev: 0,
        moves: [],
        lastMove: null,
        humanSide: 'black',
        agentSide: 'white',
        startedAt: null,
        deadline: null,
        remainingMs: null,
        ascii: gomoku.asciiBoard(gomoku.initialBoard()),
        fen: gomoku.toFen(gomoku.initialBoard()),
        minutes: defaultMinutes,
      }
    }
    const remainingMs =
      s.deadline === null ? s.minutes * 60000 : Math.max(0, s.deadline - now())
    return {
      kind: 'gomoku',
      gameId: s.gameId,
      size: gomoku.SIZE,
      cells: s.board.cells.slice(),
      turn: s.board.turn,
      status: s.status,
      rev: s.rev,
      moves: s.moves.map((move) => ({ ...move })),
      lastMove: s.lastMove ? { ...s.lastMove } : null,
      humanSide: s.humanSide,
      agentSide: s.agentSide,
      startedAt: s.startedAt,
      deadline: s.deadline,
      remainingMs,
      ascii: gomoku.asciiBoard(s.board),
      fen: gomoku.toFen(s.board),
      minutes: s.minutes,
      endReason: s.endReason || null,
    }
  }

  function broadcast() {
    const snapshot = buildSnapshot()
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch {
        /* 单个订阅者异常不影响对局 */
      }
    }
  }

  const service = {
    newGame(options = {}) {
      const humanSide = options.humanSide === 'white' ? 'white' : 'black'
      const agentSide = humanSide === 'black' ? 'white' : 'black'
      const limit = Number(options.minutes) > 0 ? Number(options.minutes) : defaultMinutes
      let token = options.token
      if (typeof token !== 'string' || !TOKEN_RE.test(token.toLowerCase())) token = generateToken()
      token = token.toLowerCase()
      const board = gomoku.initialBoard('black') // 五子棋固定黑先
      const ts = now()
      state = {
        gameId: newGameId(ts),
        board,
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
      }
      currentToken = token
      tokenDigest = digestToken(token)
      broadcast()
      return { snapshot: buildSnapshot(), token, urlPath: `/gomoku?k=${token}` }
    },

    snapshot() {
      requireGame()
      syncClock()
      return buildSnapshot()
    },

    move(input) {
      const s = requireGame()
      syncClock()
      if (s.status !== 'playing') {
        throw new GomokuError('GAME_OVER', `对局已结束（${STATUS_TEXT[s.status] || s.status}）`, 409)
      }
      const verdict = gomoku.validateMove(s.board, input)
      if (!verdict || verdict.ok !== true) {
        throw new GomokuError(
          (verdict && verdict.code) || 'ILLEGAL_MOVE',
          (verdict && verdict.message) || '这一手不合法',
          409,
        )
      }
      const applied = verdict.move
      const nextBoard = gomoku.applyMove(s.board, applied)
      const mover = s.board.turn
      pushHistory()
      const at = now()
      if (s.startedAt === null) {
        s.startedAt = at
        s.deadline = at + s.minutes * 60000
      }
      s.moves.push({
        n: s.moves.length + 1,
        color: mover,
        iccs: applied.iccs,
        file: applied.file,
        rank: applied.rank,
        notation: gomoku.notation(s.board, applied),
        at,
      })
      s.board = nextBoard
      s.lastMove = { iccs: applied.iccs, file: applied.file, rank: applied.rank, color: mover }
      s.rev += 1
      const status = gomoku.statusOf(nextBoard, applied)
      s.status = status || 'playing'
      if (s.status !== 'playing') {
        s.endReason = s.status === 'draw' ? 'draw' : 'five'
      }
      broadcast()
      return { snapshot: buildSnapshot() }
    },

    action(type) {
      const s = requireGame()
      syncClock()
      const action = String(type || '').trim()
      if (action === 'restart') return service.newGame({ humanSide: s.humanSide, minutes: s.minutes })
      if (action === 'undo') {
        if (s.status !== 'playing') throw new GomokuError('GAME_OVER', '对局已结束，不能悔棋', 409)
        if (s.moves.length === 0) throw new GomokuError('NO_MOVES', '当前没有可悔的着法', 409)
        const previous = s.history.pop()
        if (!previous) throw new GomokuError('NO_MOVES', '当前没有可悔的着法', 409)
        s.board = previous.board
        s.moves = previous.moves
        s.rev = previous.rev + 1
        s.lastMove = previous.lastMove
        s.status = 'playing'
        s.endReason = null
        broadcast()
        return { snapshot: buildSnapshot() }
      }
      if (action === 'resign') {
        if (s.status !== 'playing') throw new GomokuError('GAME_OVER', '对局已结束', 409)
        const loser = s.humanSide
        s.status = winnerStatus(loser === 'black' ? 'white' : 'black')
        s.endReason = 'resign'
        broadcast()
        return { snapshot: buildSnapshot() }
      }
      if (action === 'draw') {
        if (s.status !== 'playing') throw new GomokuError('GAME_OVER', '对局已结束', 409)
        s.status = 'draw'
        s.endReason = 'draw'
        broadcast()
        return { snapshot: buildSnapshot() }
      }
      throw new GomokuError('BAD_REQUEST', `未知操作：${action}`, 400)
    },

    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    hasGame() {
      return Boolean(state)
    },

    verifyToken(token) {
      if (!tokenDigest || typeof token !== 'string') return false
      const candidate = token.toLowerCase()
      if (!TOKEN_RE.test(candidate)) return false
      const digest = digestToken(candidate)
      if (digest.length !== tokenDigest.length) return false
      return timingSafeEqual(digest, tokenDigest)
    },

    get token() {
      return currentToken
    },

    awaiters() {
      return []
    },

    legalIndex() {
      const s = state
      if (!s) return {}
      const index = {}
      // 五子棋没有「选子」，前端只用空点集合；这里给一个 a1 风格的全量空点表
      for (const move of gomoku.legalMoves(s.board)) {
        if (!index[move.iccs]) index[move.iccs] = []
      }
      return index
    },

    recordMarkdown(options = {}) {
      const snap = buildSnapshot()
      const baseUrl = String(options.baseUrl || 'http://127.0.0.1:5000').replace(/\/+$/, '')
      const lines = []
      lines.push(`# 五子棋对局 ${snap.gameId || 'unsaved'} · 黑方：${snap.humanSide === 'black' ? '人类' : 'agent'} · 白方：${snap.humanSide === 'white' ? '人类' : 'agent'}`)
      lines.push('')
      lines.push(`- 状态：${STATUS_TEXT[snap.status] || snap.status} · 轮到：${SIDE_TEXT[snap.turn] || snap.turn} · 剩余：${formatClock(snap.remainingMs || 0)}`)
      lines.push(`- FEN：\`${snap.fen}\``)
      lines.push(`- 最近一手：${snap.lastMove ? `${snap.lastMove.iccs}（${SIDE_TEXT[snap.lastMove.color]}）` : '（尚未落子）'}`)
      lines.push('')
      lines.push('## 棋盘')
      lines.push('')
      lines.push('```text')
      lines.push(...snap.ascii)
      lines.push('```')
      lines.push('')
      lines.push('## 着法')
      lines.push('')
      lines.push('| 手 | 黑方 | 白方 |')
      lines.push('|---:|---|---|')
      for (let i = 0; i < snap.moves.length; i += 2) {
        const black = snap.moves[i]
        const white = snap.moves[i + 1]
        lines.push(`| ${Math.floor(i / 2) + 1} | ${black ? black.iccs : ''} | ${white ? white.iccs : ''} |`)
      }
      lines.push('')
      lines.push('## 给 agent 的下一步（可直接复制）')
      lines.push('')
      lines.push(`- 拉当前局面：\`GET ${baseUrl}/api/gomoku/state\`，头 \`x-xiangqi-token: <token>\``)
      lines.push('- 落子：`POST /api/gomoku/move`，body `{"iccs":"h8"}`')
      lines.push(`- 记谱：\`GET ${baseUrl}/api/gomoku/record.md\``)
      return lines.join('\n')
    },
  }

  return service
}

export default createGomokuService
