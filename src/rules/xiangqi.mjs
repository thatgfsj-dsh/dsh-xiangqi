/**
 * 中国象棋规则引擎（零依赖，纯函数式）。
 *
 * 坐标约定（与 docs/DESIGN.md §3 一致）：
 * - file 0..8 对应 a..i，从红方视角自左向右；
 * - rank 0..9，0 为红方底线，9 为黑方底线；
 * - 棋盘用长度 90 的数组表示，index = rank * 9 + file；
 * - 棋子对象 { type: 'k'|'a'|'b'|'n'|'r'|'c'|'p', color: 'red'|'black' }。
 */

export const kind = 'xiangqi'

export const START_FEN = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR r'

export const FILES = 'abcdefghi'
export const RANKS = 10

export const PIECE_NAMES = {
  red: { k: '帅', a: '仕', b: '相', n: '马', r: '车', c: '炮', p: '兵' },
  black: { k: '将', a: '士', b: '象', n: '马', r: '车', c: '炮', p: '卒' },
}

const FEN_LETTERS = { r: 'r', n: 'n', b: 'b', a: 'a', k: 'k', c: 'c', p: 'p' }
const LETTER_TYPES = { r: 'r', n: 'n', b: 'b', a: 'a', k: 'k', c: 'c', p: 'p' }

const CN_DIGITS = ['一', '二', '三', '四', '五', '六', '七', '八', '九']
const AR_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9']

const DIAGONAL = new Set(['a', 'b', 'n'])
const STRAIGHT = new Set(['r', 'c', 'p', 'k'])

/** 是否在棋盘内。 */
export function inBoard(file, rank) {
  return Number.isInteger(file) && Number.isInteger(rank) && file >= 0 && file <= 8 && rank >= 0 && rank <= 9
}

/** 坐标对象 -> 方格名，如 {file:7,rank:2} -> 'h2'。 */
export function squareName(square) {
  if (!square || !inBoard(square.file, square.rank)) return null
  return FILES[square.file] + String(square.rank)
}

/** 方格名 -> 坐标对象；非法返回 null。 */
export function parseSquare(text) {
  if (typeof text !== 'string') return null
  const trimmed = text.trim().toLowerCase()
  const match = /^([a-i])([0-9])$/.exec(trimmed)
  if (!match) return null
  return { file: FILES.indexOf(match[1]), rank: Number(match[2]) }
}

function idx(file, rank) {
  return rank * 9 + file
}

function at(board, file, rank) {
  if (!inBoard(file, rank)) return null
  return board.squares[idx(file, rank)]
}

function colorOf(board, file, rank) {
  const piece = at(board, file, rank)
  return piece ? piece.color : null
}

function other(color) {
  return color === 'red' ? 'black' : 'red'
}

/** 红方 / 黑方的九宫范围。 */
export function inPalace(color, file, rank) {
  if (file < 3 || file > 5) return false
  return color === 'red' ? rank >= 0 && rank <= 2 : rank >= 7 && rank <= 9
}

/** 是否已过河（红方向上为 rank 增大）。 */
export function crossedRiver(color, rank) {
  return color === 'red' ? rank >= 5 : rank <= 4
}

/** 建立初始局面。 */
export function initialBoard() {
  return fromFen(START_FEN)
}

/** FEN 写出。 */
export function toFen(board) {
  const rows = []
  for (let rank = 9; rank >= 0; rank -= 1) {
    let row = ''
    let empty = 0
    for (let file = 0; file <= 8; file += 1) {
      const piece = at(board, file, rank)
      if (!piece) {
        empty += 1
        continue
      }
      if (empty > 0) {
        row += String(empty)
        empty = 0
      }
      const letter = FEN_LETTERS[piece.type] || '?'
      row += piece.color === 'red' ? letter.toUpperCase() : letter
    }
    if (empty > 0) row += String(empty)
    rows.push(row)
  }
  return `${rows.join('/')} ${board.turn === 'red' ? 'r' : 'b'}`
}

/** FEN 读入。 */
export function fromFen(fen) {
  if (typeof fen !== 'string' || fen.trim() === '') throw new Error('fromFen: 需要非空 FEN')
  const [position, turnRaw = 'r'] = fen.trim().split(/\s+/)
  const rows = position.split('/')
  if (rows.length !== 10) throw new Error(`fromFen: 行数应为 10，实际 ${rows.length}`)
  const squares = new Array(90).fill(null)
  for (let r = 0; r < 10; r += 1) {
    const rank = 9 - r
    let file = 0
    for (const ch of rows[r]) {
      if (/[0-9]/.test(ch)) {
        file += Number(ch)
        continue
      }
      const type = LETTER_TYPES[ch.toLowerCase()]
      if (!type) throw new Error(`fromFen: 无法识别的棋子字符 ${ch}`)
      if (file > 8) throw new Error('fromFen: 一行超过 9 列')
      squares[idx(file, rank)] = { type, color: ch === ch.toUpperCase() ? 'red' : 'black' }
      file += 1
    }
  }
  return { squares, turn: turnRaw.toLowerCase().startsWith('b') ? 'black' : 'red', ply: 0, history: [] }
}

/** 深拷贝棋盘（棋子对象按值共享，不修改）。 */
export function cloneBoard(board) {
  return {
    squares: board.squares.slice(),
    turn: board.turn,
    ply: board.ply || 0,
    history: (board.history || []).slice(),
  }
}

function makeMove(board, from, to) {
  const piece = at(board, from.file, from.rank)
  return {
    from: { file: from.file, rank: from.rank },
    to: { file: to.file, rank: to.rank },
    iccs: squareName(from) + squareName(to),
    capture: Boolean(at(board, to.file, to.rank)),
    piece: piece ? piece.type : null,
    color: piece ? piece.color : null,
  }
}

/** 两将是否照面（同一列且中间无子）。 */
export function generalsFacing(board) {
  let redKing = null
  let blackKing = null
  for (let rank = 0; rank <= 9; rank += 1) {
    for (let file = 0; file <= 8; file += 1) {
      const piece = at(board, file, rank)
      if (!piece || piece.type !== 'k') continue
      if (piece.color === 'red') redKing = { file, rank }
      else blackKing = { file, rank }
    }
  }
  if (!redKing || !blackKing || redKing.file !== blackKing.file) return false
  const file = redKing.file
  const low = Math.min(redKing.rank, blackKing.rank)
  const high = Math.max(redKing.rank, blackKing.rank)
  for (let rank = low + 1; rank < high; rank += 1) {
    if (at(board, file, rank)) return false
  }
  return true
}

/** 找某方将/帅位置。 */
export function findKing(board, color) {
  for (let rank = 0; rank <= 9; rank += 1) {
    for (let file = 0; file <= 8; file += 1) {
      const piece = at(board, file, rank)
      if (piece && piece.type === 'k' && piece.color === color) return { file, rank }
    }
  }
  return null
}

function rookTargets(board, from, out) {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  for (const [df, dr] of dirs) {
    let file = from.file + df
    let rank = from.rank + dr
    while (inBoard(file, rank)) {
      const piece = at(board, file, rank)
      if (!piece) out.push(makeMove(board, from, { file, rank }))
      else {
        if (piece.color !== colorOf(board, from.file, from.rank)) out.push(makeMove(board, from, { file, rank }))
        break
      }
      file += df
      rank += dr
    }
  }
}

function cannonTargets(board, from, out) {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]]
  const ownColor = colorOf(board, from.file, from.rank)
  for (const [df, dr] of dirs) {
    let file = from.file + df
    let rank = from.rank + dr
    let screened = false
    while (inBoard(file, rank)) {
      const piece = at(board, file, rank)
      if (!screened) {
        if (!piece) out.push(makeMove(board, from, { file, rank }))
        else screened = true
      } else if (piece) {
        if (piece.color !== ownColor) out.push(makeMove(board, from, { file, rank }))
        break
      }
      file += df
      rank += dr
    }
  }
}

const KNIGHT_STEPS = [
  [1, 2, 0, 1], [-1, 2, 0, 1], [1, -2, 0, -1], [-1, -2, 0, -1],
  [2, 1, 1, 0], [2, -1, 1, 0], [-2, 1, -1, 0], [-2, -1, -1, 0],
]

function knightTargets(board, from, out) {
  const ownColor = colorOf(board, from.file, from.rank)
  for (const [df, dr, legF, legR] of KNIGHT_STEPS) {
    const file = from.file + df
    const rank = from.rank + dr
    if (!inBoard(file, rank)) continue
    if (at(board, from.file + legF, from.rank + legR)) continue
    const piece = at(board, file, rank)
    if (piece && piece.color === ownColor) continue
    out.push(makeMove(board, from, { file, rank }))
  }
}

const BISHOP_STEPS = [[2, 2, 1, 1], [2, -2, 1, -1], [-2, 2, -1, 1], [-2, -2, -1, -1]]

function bishopTargets(board, from, out) {
  const ownColor = colorOf(board, from.file, from.rank)
  for (const [df, dr, eyeF, eyeR] of BISHOP_STEPS) {
    const file = from.file + df
    const rank = from.rank + dr
    if (!inBoard(file, rank)) continue
    if (crossedRiver(ownColor, rank)) continue
    if (at(board, from.file + eyeF, from.rank + eyeR)) continue
    const piece = at(board, file, rank)
    if (piece && piece.color === ownColor) continue
    out.push(makeMove(board, from, { file, rank }))
  }
}

function advisorTargets(board, from, out) {
  const ownColor = colorOf(board, from.file, from.rank)
  for (const [df, dr] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    const file = from.file + df
    const rank = from.rank + dr
    if (!inBoard(file, rank) || !inPalace(ownColor, file, rank)) continue
    const piece = at(board, file, rank)
    if (piece && piece.color === ownColor) continue
    out.push(makeMove(board, from, { file, rank }))
  }
}

function kingTargets(board, from, out) {
  const ownColor = colorOf(board, from.file, from.rank)
  for (const [df, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const file = from.file + df
    const rank = from.rank + dr
    if (!inBoard(file, rank) || !inPalace(ownColor, file, rank)) continue
    const piece = at(board, file, rank)
    if (piece && piece.color === ownColor) continue
    out.push(makeMove(board, from, { file, rank }))
  }
}

function pawnTargets(board, from, out) {
  const ownColor = colorOf(board, from.file, from.rank)
  const forward = ownColor === 'red' ? 1 : -1
  const push = (file, rank) => {
    if (!inBoard(file, rank)) return
    const piece = at(board, file, rank)
    if (piece && piece.color === ownColor) return
    out.push(makeMove(board, from, { file, rank }))
  }
  push(from.file, from.rank + forward)
  if (crossedRiver(ownColor, from.rank)) {
    push(from.file - 1, from.rank)
    push(from.file + 1, from.rank)
  }
}

function pseudoMovesFrom(board, from) {
  const piece = at(board, from.file, from.rank)
  if (!piece) return []
  const out = []
  switch (piece.type) {
    case 'r': rookTargets(board, from, out); break
    case 'c': cannonTargets(board, from, out); break
    case 'n': knightTargets(board, from, out); break
    case 'b': bishopTargets(board, from, out); break
    case 'a': advisorTargets(board, from, out); break
    case 'k': kingTargets(board, from, out); break
    case 'p': pawnTargets(board, from, out); break
    default: break
  }
  return out
}

/** 走子后是否让己方处于被将军 / 将帅照面状态。 */
function leavesKingExposed(board, move, color) {
  const next = cloneBoard(board)
  next.squares[idx(move.to.file, move.to.rank)] = next.squares[idx(move.from.file, move.from.rank)]
  next.squares[idx(move.from.file, move.from.rank)] = null
  if (generalsFacing(next)) return { code: 'FLYING_GENERAL', message: '将帅不能照面' }
  if (isKingAttacked(next, color)) return { code: 'SELF_CHECK', message: '走后自己被将军' }
  return null
}

/** 某方将/帅是否正被攻击（含对方将的照面威胁由 generalsFacing 单独判定）。 */
export function isKingAttacked(board, color) {
  const king = findKing(board, color)
  if (!king) return false
  const enemy = other(color)
  for (let rank = 0; rank <= 9; rank += 1) {
    for (let file = 0; file <= 8; file += 1) {
      const piece = at(board, file, rank)
      if (!piece || piece.color !== enemy) continue
      const moves = pseudoMovesFrom(board, { file, rank })
      for (const move of moves) {
        if (move.to.file === king.file && move.to.rank === king.rank) return true
      }
    }
  }
  return false
}

/** 该方全部合法着法。 */
export function legalMoves(board) {
  const out = []
  for (let rank = 0; rank <= 9; rank += 1) {
    for (let file = 0; file <= 8; file += 1) {
      const piece = at(board, file, rank)
      if (!piece || piece.color !== board.turn) continue
      out.push(...legalMovesFrom(board, { file, rank }))
    }
  }
  return out
}

/** 单子合法着法。 */
export function legalMovesFrom(board, from) {
  if (!from || !inBoard(from.file, from.rank)) return []
  const piece = at(board, from.file, from.rank)
  if (!piece || piece.color !== board.turn) return []
  return pseudoMovesFrom(board, from).filter((move) => !leavesKingExposed(board, move, piece.color))
}

/** 单子走法模式校验（不含自将判定），返回人话错误。 */
export function patternError(board, from, to) {
  const piece = at(board, from.file, from.rank)
  if (!piece) return { code: 'EMPTY_SQUARE', message: '该位置没有棋子' }
  if (piece.color !== board.turn) return { code: 'NOT_YOUR_PIECE', message: '还没轮到你走这一方' }
  const target = at(board, to.file, to.rank)
  if (target && target.color === piece.color) return { code: 'ILLEGAL_PATTERN', message: '不能吃自己的棋子' }
  const df = to.file - from.file
  const dr = to.rank - from.rank
  const name = PIECE_NAMES[piece.color][piece.type]

  switch (piece.type) {
    case 'r': {
      if (df !== 0 && dr !== 0) return { code: 'ILLEGAL_PATTERN', message: '车只能走直线' }
      if (!pathClear(board, from, to)) return { code: 'ILLEGAL_PATTERN', message: '车的路径被挡住了' }
      return null
    }
    case 'c': {
      if (df !== 0 && dr !== 0) return { code: 'ILLEGAL_PATTERN', message: '炮只能走直线' }
      const between = countBetween(board, from, to)
      if (target) {
        if (between !== 1) return { code: 'ILLEGAL_PATTERN', message: '炮吃子必须隔一个棋子' }
      } else if (between !== 0) {
        return { code: 'ILLEGAL_PATTERN', message: '炮移动时路径上不能有棋子' }
      }
      return null
    }
    case 'n': {
      const absF = Math.abs(df)
      const absR = Math.abs(dr)
      if (!((absF === 1 && absR === 2) || (absF === 2 && absR === 1))) {
        return { code: 'ILLEGAL_PATTERN', message: '马走日字' }
      }
      const legF = from.file + (absF === 2 ? Math.sign(df) : 0)
      const legR = from.rank + (absR === 2 ? Math.sign(dr) : 0)
      if (at(board, legF, legR)) return { code: 'ILLEGAL_PATTERN', message: '马腿被挡住了' }
      return null
    }
    case 'b': {
      if (Math.abs(df) !== 2 || Math.abs(dr) !== 2) return { code: 'ILLEGAL_PATTERN', message: '象走田字' }
      if (crossedRiver(piece.color, to.rank)) return { code: 'ILLEGAL_PATTERN', message: '象不能过河' }
      if (at(board, from.file + Math.sign(df), from.rank + Math.sign(dr))) {
        return { code: 'ILLEGAL_PATTERN', message: '象眼被挡住了' }
      }
      return null
    }
    case 'a': {
      if (Math.abs(df) !== 1 || Math.abs(dr) !== 1) return { code: 'ILLEGAL_PATTERN', message: '士只能斜走一步' }
      if (!inPalace(piece.color, to.file, to.rank)) return { code: 'ILLEGAL_PATTERN', message: '士不能出九宫' }
      return null
    }
    case 'k': {
      if (Math.abs(df) + Math.abs(dr) !== 1) return { code: 'ILLEGAL_PATTERN', message: '将/帅只能走一步直线' }
      if (!inPalace(piece.color, to.file, to.rank)) return { code: 'ILLEGAL_PATTERN', message: '将/帅不能出九宫' }
      return null
    }
    case 'p': {
      const forward = piece.color === 'red' ? 1 : -1
      if (dr === forward && df === 0) return null
      if (dr === 0 && Math.abs(df) === 1 && crossedRiver(piece.color, from.rank)) return null
      return {
        code: 'ILLEGAL_PATTERN',
        message: crossedRiver(piece.color, from.rank) ? '兵/卒过河后可横走一步，但不能后退' : '兵/卒未过河只能向前走一步',
      }
    }
    default:
      return { code: 'ILLEGAL_PATTERN', message: `${name}不能这样走` }
  }
}

function pathClear(board, from, to) {
  return countBetween(board, from, to) === 0
}

function countBetween(board, from, to) {
  let count = 0
  const df = Math.sign(to.file - from.file)
  const dr = Math.sign(to.rank - from.rank)
  let file = from.file + df
  let rank = from.rank + dr
  while (file !== to.file || rank !== to.rank) {
    if (!inBoard(file, rank)) break
    if (at(board, file, rank)) count += 1
    file += df
    rank += dr
  }
  return count
}

/** 统一把各种入参归一化成 Move。 */
export function normalizeMove(board, input) {
  if (!input || typeof input !== 'object') return null
  let from = input.from
  let to = input.to
  if (typeof from === 'string') from = parseSquare(from)
  if (typeof to === 'string') to = parseSquare(to)
  if ((!from || !to) && typeof input.iccs === 'string') {
    const text = input.iccs.trim().toLowerCase()
    if (text.length === 4) {
      from = parseSquare(text.slice(0, 2))
      to = parseSquare(text.slice(2))
    }
  }
  if (!from || !to) return null
  if (!inBoard(from.file, from.rank) || !inBoard(to.file, to.rank)) return null
  return makeMove(board, from, to)
}

/** 校验着法：{ok:true, move} 或 {ok:false, code, message}。 */
export function validateMove(board, input) {
  const move = normalizeMove(board, input)
  if (!move) return { ok: false, code: 'OUT_OF_BOARD', message: '坐标不合法，应为 a0..i9' }
  if (move.from.file === move.to.file && move.from.rank === move.to.rank) {
    return { ok: false, code: 'ILLEGAL_PATTERN', message: '起点和终点不能相同' }
  }
  const pattern = patternError(board, move.from, move.to)
  if (pattern) return { ok: false, ...pattern }
  const exposed = leavesKingExposed(board, move, board.turn)
  if (exposed) return { ok: false, ...exposed }
  return { ok: true, move }
}

/** 执行着法（纯函数）：返回新棋盘，非法则抛错。 */
export function applyMove(board, input) {
  const result = validateMove(board, input)
  if (!result.ok) {
    const error = new Error(result.message)
    error.code = result.code
    throw error
  }
  const move = result.move
  const next = cloneBoard(board)
  const text = notation(board, move)
  next.squares[idx(move.to.file, move.to.rank)] = next.squares[idx(move.from.file, move.from.rank)]
  next.squares[idx(move.from.file, move.from.rank)] = null
  next.turn = other(board.turn)
  next.ply = (board.ply || 0) + 1
  next.history.push({ move, notation: text })
  return next
}

/** 中文记谱（落子前的局面）。 */
export function notation(board, move) {
  const piece = at(board, move.from.file, move.from.rank)
  if (!piece) return move.iccs
  const color = piece.color
  const digits = color === 'red' ? CN_DIGITS : AR_DIGITS
  const name = PIECE_NAMES[color][piece.type]
  const fileNumeral = (file) => digits[color === 'red' ? 8 - file : file]

  let prefix = ''
  let fromNumeral = fileNumeral(move.from.file)
  const sameFile = []
  for (let rank = 0; rank <= 9; rank += 1) {
    const other = at(board, move.from.file, rank)
    if (other && other.color === color && other.type === piece.type) sameFile.push(rank)
  }
  if (sameFile.length >= 2) {
    sameFile.sort((a, b) => a - b)
    const forwardFirst = color === 'red' ? sameFile.slice().reverse() : sameFile
    if (forwardFirst.length === 2) prefix = move.from.rank === forwardFirst[0] ? '前' : '后'
    else if (forwardFirst.length === 3) {
      const pos = forwardFirst.indexOf(move.from.rank)
      prefix = pos === 0 ? '前' : pos === 2 ? '后' : '中'
    }
    fromNumeral = ''
  }

  let action
  let targetNumeral
  if (move.from.rank === move.to.rank) {
    action = '平'
    targetNumeral = fileNumeral(move.to.file)
  } else {
    const forward = color === 'red' ? move.to.rank > move.from.rank : move.to.rank < move.from.rank
    action = forward ? '进' : '退'
    if (DIAGONAL.has(piece.type)) targetNumeral = fileNumeral(move.to.file)
    else targetNumeral = digits[Math.abs(move.to.rank - move.from.rank) - 1]
  }
  return `${prefix}${name}${fromNumeral}${action}${targetNumeral}`
}

/** 局面状态：'playing' | 'red-win' | 'black-win' | 'draw'。 */
export function statusOf(board) {
  if (legalMoves(board).length > 0) return 'playing'
  const loser = board.turn
  return loser === 'red' ? 'black-win' : 'red-win'
}

/** 文字棋盘：恰好 10 行，红方在下（每行前缀行号，列序 a..i）。 */
export function asciiBoard(board) {
  const lines = []
  for (let rank = 9; rank >= 0; rank -= 1) {
    const cells = []
    for (let file = 0; file <= 8; file += 1) {
      const piece = at(board, file, rank)
      cells.push(piece ? PIECE_NAMES[piece.color][piece.type] : '·')
    }
    lines.push(`${rank} ${cells.join(' ')}`)
  }
  return lines
}

/** 供测试与调试：列出某方格的所有合法目标方格名。 */
export function legalTargets(board, squareText) {
  const square = typeof squareText === 'string' ? parseSquare(squareText) : squareText
  if (!square) return []
  return legalMovesFrom(board, square).map((move) => squareName(move.to))
}
