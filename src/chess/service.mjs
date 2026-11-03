/**
 * 国际象棋对局服务（单局制），与象棋/五子棋服务同形状：
 * - 18 位口令只在 newGame()/restart 时返回明文，内部只存 SHA-256 摘要；
 * - 20 分钟全局限时（第一手才开始计时，时钟可注入）；
 * - move() 接受 {iccs:'e2e4'} / {from,to,promotion?} / {san:'Nf3'}；
 * - subscribe(fn) 广播快照；recordMarkdown() 生成给 agent 的 md（口令只写 <token>）。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import * as chess from '../chess/rules.mjs'

const TOKEN_LENGTH = 18
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const TOKEN_RE = /^[a-z0-9]{18}$/
const STATUS_TEXT = {
  playing: '进行中',
  'white-win': '白方胜',
  'black-win': '黑方胜',
  draw: '和棋',
}
const SIDE_TEXT = { white: '白方', black: '黑方' }
const PIECE_CN = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' }

export class ChessError extends Error {
  constructor(code, message, status = 409) {
    super(message)
    this.name = 'ChessError'
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
  return `ch-${formatDateStamp(ts)}-${rand}`
}

function winnerStatus(color) {
  return color === 'white' ? 'white-win' : 'black-win'
}

/** 走子后的战术标签：吃X / 将军 / 将死 / 王车易位 / 吃过路兵 / 升变。 */
function moveTags(board, move, next) {
  const tags = []
  if (move.castle) tags.push(move.castle === 'k' ? '王车易位(短)' : '王车易位(长)')
  if (move.enPassant) tags.push('吃过路兵')
  if (move.promotion) tags.push(`升变(${PIECE_CN[move.promotion]})`)
  if (move.capture && !move.enPassant) {
    const captured = chess.at(board, move.to.file, move.to.rank)
    if (captured) tags.push(`吃${PIECE_CN[captured.type]}`)
  }
  const result = chess.statusOf(next)
  if (result.status === 'playing') {
    if (chess.inCheck(next, next.turn)) tags.push('将军')
  } else if (result.reason === 'checkmate') {
    tags.push('将死')
  }
  return tags
}

/** 人话解说：如「车 e2→e8 将军」「马 g1→f3」。 */
function moveComment(board, move, tags) {
  const piece = chess.at(board, move.from.file, move.from.rank)
  if (!piece) return ''
  const name = PIECE_CN[piece.type]
  const from = chess.squareName(move.from)
  const to = chess.squareName(move.to)
  const key = tags.find((tag) => ['将军', '将死'].includes(tag))
  return `${name} ${from}→${to}${key ? ' ' + key : ''}`
}

export function createChessService({ now = () => Date.now(), defaultMinutes = 20 } = {}) {
  let state = null
  let currentToken = null
  let tokenDigest = null
  const listeners = new Set()

  function requireGame() {
    if (!state) throw new ChessError('NO_GAME', '还没有国际象棋对局', 410)
    return state
  }

  function syncClock() {
    const s = state
    if (!s || s.status !== 'playing') return
    if (s.startedAt === null || s.deadline === null) return
    if (now() < s.deadline) return
    const loser = s.board.turn
    s.status = winnerStatus(loser === 'white' ? 'black' : 'white')
    s.endReason = 'timeout'
    broadcast()
  }

  function pushHistory() {
    const s = state
    s.history.push({ board: chess.cloneBoard(s.board), moves: s.moves.slice(), rev: s.rev, lastMove: s.lastMove })
    if (s.history.length > 200) s.history.shift()
  }

  function cellsOf(board) {
    return board.cells.map((piece) => (piece ? { type: piece.type, color: piece.color } : null))
  }

  function buildSnapshot() {
    const s = state
    if (!s) {
      const board = chess.initialBoard()
      return {
        kind: 'chess',
        gameId: null,
        fen: chess.toFen(board),
        turn: 'white',
        status: 'no-game',
        rev: 0,
        cells: cellsOf(board),
        moves: [],
        lastMove: null,
        legal: chess.legalIndex(board),
        humanSide: 'white',
        agentSide: 'black',
        startedAt: null,
        deadline: null,
        remainingMs: null,
        ascii: chess.asciiBoard(board),
        minutes: defaultMinutes,
        endReason: null,
      }
    }
    const remainingMs = s.deadline === null ? s.minutes * 60000 : Math.max(0, s.deadline - now())
    return {
      kind: 'chess',
      gameId: s.gameId,
      fen: chess.toFen(s.board),
      turn: s.board.turn,
      status: s.status,
      rev: s.rev,
      cells: cellsOf(s.board),
      moves: s.moves.map((move) => ({ ...move })),
      lastMove: s.lastMove ? { ...s.lastMove } : null,
      legal: chess.legalIndex(s.board),
      humanSide: s.humanSide,
      agentSide: s.agentSide,
      startedAt: s.startedAt,
      deadline: s.deadline,
      remainingMs,
      ascii: chess.asciiBoard(s.board),
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
      const humanSide = options.humanSide === 'black' ? 'black' : 'white'
      const agentSide = humanSide === 'white' ? 'black' : 'white'
      const limit = Number(options.minutes) > 0 ? Number(options.minutes) : defaultMinutes
      let token = options.token
      if (typeof token !== 'string' || !TOKEN_RE.test(token.toLowerCase())) token = generateToken()
      token = token.toLowerCase()
      const board = chess.initialBoard()
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
      return { snapshot: buildSnapshot(), token, urlPath: `/chess?k=${token}` }
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
        throw new ChessError('GAME_OVER', `对局已结束（${STATUS_TEXT[s.status] || s.status}）`, 409)
      }
      const verdict = chess.validateMove(s.board, input)
      if (!verdict || verdict.ok !== true) {
        throw new ChessError(
          (verdict && verdict.code) || 'ILLEGAL_MOVE',
          (verdict && verdict.message) || '这一步不合法',
          409,
        )
      }
      const applied = verdict.move
      const san = chess.notation(s.board, applied)
      const nextBoard = chess.applyMove(s.board, applied)
      const tags = moveTags(s.board, applied, nextBoard)
      const comment = moveComment(s.board, applied, tags)
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
        san,
        from: applied.from,
        to: applied.to,
        at,
        tags,
        comment,
      })
      s.board = nextBoard
      s.lastMove = { iccs: applied.iccs, san, from: applied.from, to: applied.to, color: mover, tags, comment }
      s.rev += 1
      const result = chess.statusOf(nextBoard)
      s.status = result.status
      s.endReason = result.reason
      broadcast()
      return { snapshot: buildSnapshot() }
    },

    action(type) {
      const s = requireGame()
      syncClock()
      const action = String(type || '').trim()
      if (action === 'restart') return service.newGame({ humanSide: s.humanSide, minutes: s.minutes })
      if (action === 'undo') {
        if (s.status !== 'playing') throw new ChessError('GAME_OVER', '对局已结束，不能悔棋', 409)
        if (s.moves.length === 0) throw new ChessError('NO_MOVES', '当前没有可悔的着法', 409)
        const previous = s.history.pop()
        if (!previous) throw new ChessError('NO_MOVES', '当前没有可悔的着法', 409)
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
        if (s.status !== 'playing') throw new ChessError('GAME_OVER', '对局已结束', 409)
        const loser = s.humanSide
        s.status = winnerStatus(loser === 'white' ? 'black' : 'white')
        s.endReason = 'resign'
        broadcast()
        return { snapshot: buildSnapshot() }
      }
      if (action === 'draw') {
        if (s.status !== 'playing') throw new ChessError('GAME_OVER', '对局已结束', 409)
        s.status = 'draw'
        s.endReason = 'draw'
        broadcast()
        return { snapshot: buildSnapshot() }
      }
      throw new ChessError('BAD_REQUEST', `未知操作：${action}`, 400)
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

    legalIndex() {
      return state ? chess.legalIndex(state.board) : {}
    },

    recordMarkdown(options = {}) {
      const snap = buildSnapshot()
      const baseUrl = String(options.baseUrl || 'http://127.0.0.1:5000').replace(/\/+$/, '')
      const lines = []
      lines.push(`# 国际象棋对局 ${snap.gameId || 'unsaved'} · 白方：${snap.humanSide === 'white' ? '人类' : 'agent'} · 黑方：${snap.humanSide === 'black' ? '人类' : 'agent'}`)
      lines.push('')
      lines.push(`- 状态：${STATUS_TEXT[snap.status] || snap.status} · 轮到：${SIDE_TEXT[snap.turn] || snap.turn} · 剩余：${formatClock(snap.remainingMs || 0)}`)
      lines.push(`- FEN：\`${snap.fen}\``)
      lines.push(`- 最近一手：${snap.lastMove ? `${snap.lastMove.san}（${snap.lastMove.iccs}）` : '（尚未落子）'}`)
      lines.push('')
      lines.push('## 棋盘')
      lines.push('')
      lines.push('```text')
      lines.push(...snap.ascii)
      lines.push('```')
      lines.push('')
      lines.push('## 着法')
      lines.push('')
      lines.push('| 回合 | 白方 | 黑方 |')
      lines.push('|---:|---|---|')
      for (let i = 0; i < snap.moves.length; i += 2) {
        const white = snap.moves[i]
        const black = snap.moves[i + 1]
        lines.push(`| ${Math.floor(i / 2) + 1} | ${white ? white.san : ''} | ${black ? black.san : ''} |`)
      }
      lines.push('')
      lines.push('## 给 agent 的下一步（可直接复制）')
      lines.push('')
      lines.push(`- 拉当前局面：\`GET ${baseUrl}/api/chess/state\`，头 \`x-xiangqi-token: <token>\``)
      lines.push('- 走子：`POST /api/chess/move`，body `{"iccs":"e2e4"}`（升变用 `e7e8q`）或 `{"san":"Nf3"}`')
      lines.push(`- 记谱：\`GET ${baseUrl}/api/chess/record.md\``)
      return lines.join('\n')
    },
  }

  return service
}

export default createChessService
