/**
 * 五子棋规则层（15×15 无禁手自由规则：横/竖/斜任意方向连成 5 子或以上即胜）。
 * 与象棋规则层并列，由宿主层分别使用（不共用 board 形状）。
 */

export const KIND = 'gomoku'
export const SIZE = 15

const FILES = 'abcdefghijklmno'

/** 棋盘坐标：file 0..14（a..o），rank 0..14（1..15，rank 0 在最下）。 */
export function parseSquare(text) {
  if (typeof text !== 'string') return null
  const match = /^([a-o])(1[0-5]|[1-9])$/i.exec(text.trim())
  if (!match) return null
  return { file: FILES.indexOf(match[1].toLowerCase()), rank: Number(match[2]) - 1 }
}

export function squareName(square) {
  if (!square || typeof square !== 'object') return null
  const { file, rank } = square
  if (!Number.isInteger(file) || !Number.isInteger(rank)) return null
  if (file < 0 || file >= SIZE || rank < 0 || rank >= SIZE) return null
  return `${FILES[file]}${rank + 1}`
}

export function initialBoard(turn = 'black') {
  return {
    kind: KIND,
    size: SIZE,
    cells: new Array(SIZE * SIZE).fill(null), // null | 'black' | 'white'
    turn,
    ply: 0,
  }
}

export function cloneBoard(board) {
  return { ...board, cells: board.cells.slice() }
}

function cellIndex(file, rank) {
  return rank * SIZE + file
}

export function at(board, file, rank) {
  if (file < 0 || file >= SIZE || rank < 0 || rank >= SIZE) return null
  return board.cells[cellIndex(file, rank)]
}

/** 全部空点（数量随棋盘递减）。 */
export function legalMoves(board) {
  const moves = []
  for (let rank = 0; rank < SIZE; rank += 1) {
    for (let file = 0; file < SIZE; file += 1) {
      if (board.cells[cellIndex(file, rank)]) continue
      moves.push({ file, rank, iccs: squareName({ file, rank }), color: board.turn })
    }
  }
  return moves
}

/** 是否为正着：落点为空；对局进行中。 */
export function validateMove(board, input) {
  const move = normalizeMove(board, input)
  if (!move) return { ok: false, code: 'OUT_OF_BOARD', message: '坐标超出棋盘（a-o，1-15）' }
  if (at(board, move.file, move.rank)) {
    return { ok: false, code: 'OCCUPIED', message: `${move.iccs} 已经有子了`, move }
  }
  return { ok: true, move: { ...move, color: board.turn } }
}

function normalizeMove(board, input) {
  if (!input || typeof input !== 'object') return null
  if (typeof input.iccs === 'string') {
    const sq = parseSquare(input.iccs)
    if (!sq) return null
    return { ...sq, iccs: squareName(sq) }
  }
  if (Number.isInteger(input.file) && Number.isInteger(input.rank)) {
    const sq = { file: input.file, rank: input.rank }
    const iccs = squareName(sq)
    if (!iccs) return null
    return { ...sq, iccs }
  }
  return null
}

/** 落子（纯函数，返回新 board；不做合法性判断，调用前先 validateMove）。 */
export function applyMove(board, move) {
  const next = cloneBoard(board)
  next.cells[cellIndex(move.file, move.rank)] = board.turn
  next.turn = board.turn === 'black' ? 'white' : 'black'
  next.ply = (board.ply || 0) + 1
  return next
}

export function notation(board, move) {
  return squareName(move) || ''
}

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
]

/** 某点落子后是否连成 5 子以上（沿四个方向数同色连续子）。 */
export function isWinningMove(board, file, rank) {
  const color = at(board, file, rank)
  if (!color) return false
  for (const [dx, dy] of DIRECTIONS) {
    let count = 1
    for (const dir of [1, -1]) {
      let x = file + dx * dir
      let y = rank + dy * dir
      while (at(board, x, y) === color) {
        count += 1
        x += dx * dir
        y += dy * dir
      }
    }
    if (count >= 5) return true
  }
  return false
}

/** 局面状态：'playing' | 'black-win' | 'white-win' | 'draw'。 */
export function statusOf(board, lastMove) {
  const move = lastMove || null
  if (move && Number.isInteger(move.file) && Number.isInteger(move.rank)) {
    // 落子方是上一步的对面
    const mover = board.turn === 'black' ? 'white' : 'black'
    if (isWinningMove(board, move.file, move.rank)) return `${mover}-win`
  }
  const full = board.cells.every((cell) => cell !== null)
  return full ? 'draw' : 'playing'
}

export const PIECE_CHARS = { black: 'X', white: 'O' }

/** 文字棋盘：行号 15→1，列 a..o；黑 X、白 O、空 ·。 */
export function asciiBoard(board) {
  const lines = []
  for (let rank = SIZE - 1; rank >= 0; rank -= 1) {
    const row = []
    for (let file = 0; file < SIZE; file += 1) {
      const cell = at(board, file, rank)
      row.push(cell ? PIECE_CHARS[cell] : '·')
    }
    lines.push(`${String(rank + 1).padStart(2)} ${row.join(' ')}`)
  }
  const footer = `   ${FILES.split('').join(' ')}`
  return [footer, ...lines]
}

/** 简单 FEN：'15/15/... b'（行内用 x 压缩空位，b=黑先、w=白先）。 */
export function toFen(board) {
  const rows = []
  for (let rank = SIZE - 1; rank >= 0; rank -= 1) {
    let row = ''
    let empty = 0
    for (let file = 0; file < SIZE; file += 1) {
      const cell = at(board, file, rank)
      if (!cell) {
        empty += 1
        continue
      }
      if (empty > 0) {
        row += String(empty)
        empty = 0
      }
      row += cell === 'black' ? 'X' : 'O'
    }
    if (empty > 0) row += String(empty)
    rows.push(row || String(empty))
  }
  return `${rows.join('/')} ${board.turn === 'black' ? 'b' : 'w'}`
}

/** 回合标号（黑 1、白 2 … 按 1 起的手数）。 */
export function moveLabel(move) {
  return move && move.iccs ? move.iccs : ''
}

export const RULES_NAME = '五子棋'
