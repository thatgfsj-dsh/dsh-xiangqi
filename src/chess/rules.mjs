/**
 * 国际象棋规则层（标准规则：王车易位、吃过路兵、兵升变、将军/将死/逼和、50 回合与子力不足和棋）。
 * 纯函数；board 形状与象棋/五子棋不同，由宿主层单独使用。
 */

export const KIND = 'chess'
export const SIZE = 8
const FILES = 'abcdefgh'
const PIECE_LETTER = { p: 'p', n: 'n', b: 'b', r: 'r', q: 'q', k: 'k' }
const PIECE_NAME_CN = { p: '兵', n: '马', b: '象', r: '车', q: '后', k: '王' }
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export function parseSquare(text) {
  if (typeof text !== 'string') return null
  const match = /^([a-h])([1-8])$/i.exec(text.trim())
  if (!match) return null
  return { file: FILES.indexOf(match[1].toLowerCase()), rank: Number(match[2]) - 1 }
}

export function squareName(square) {
  if (!square || typeof square !== 'object') return null
  const { file, rank } = square
  if (!Number.isInteger(file) || !Number.isInteger(rank)) return null
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null
  return `${FILES[file]}${rank + 1}`
}

function index(file, rank) {
  return rank * SIZE + file
}

export function at(board, file, rank) {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null
  return board.cells[index(file, rank)]
}

function setCell(cells, file, rank, piece) {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return
  cells[index(file, rank)] = piece
}

export function cloneBoard(board) {
  return {
    kind: KIND,
    cells: board.cells.map((piece) => (piece ? { ...piece } : null)),
    turn: board.turn,
    castling: { ...board.castling, white: { ...board.castling.white }, black: { ...board.castling.black } },
    ep: board.ep ? { ...board.ep } : null,
    halfmove: board.halfmove || 0,
    fullmove: board.fullmove || 1,
    ply: board.ply || 0,
  }
}

function other(color) {
  return color === 'white' ? 'black' : 'white'
}

export function initialBoard() {
  return fromFen(START_FEN)
}

export function fromFen(fen) {
  const parts = String(fen || '').trim().split(/\s+/)
  if (parts.length < 4) throw new Error(`无效 FEN：${fen}`)
  const [placement, turnText, castlingText, epText, halfText, fullText] = parts
  const cells = new Array(SIZE * SIZE).fill(null)
  const rows = placement.split('/')
  if (rows.length !== SIZE) throw new Error(`无效 FEN 行数：${fen}`)
  rows.forEach((row, rowIndex) => {
    const rank = SIZE - 1 - rowIndex
    let file = 0
    for (const ch of row) {
      if (/[1-8]/.test(ch)) {
        file += Number(ch)
        continue
      }
      const lower = ch.toLowerCase()
      if (!PIECE_LETTER[lower]) throw new Error(`无效 FEN 棋子：${ch}`)
      setCell(cells, file, rank, { type: lower, color: ch === lower ? 'black' : 'white' })
      file += 1
    }
    if (file !== SIZE) throw new Error(`无效 FEN 行宽：${row}`)
  })
  const turn = turnText === 'b' ? 'black' : 'white'
  const castling = {
    white: { k: castlingText.includes('K'), q: castlingText.includes('Q') },
    black: { k: castlingText.includes('k'), q: castlingText.includes('q') },
  }
  const epSquare = epText && epText !== '-' ? parseSquare(epText) : null
  return {
    kind: KIND,
    cells,
    turn,
    castling,
    ep: epSquare,
    halfmove: Number(halfText) || 0,
    fullmove: Number(fullText) || 1,
    ply: 0,
  }
}

export function toFen(board) {
  const rows = []
  for (let rank = SIZE - 1; rank >= 0; rank -= 1) {
    let row = ''
    let empty = 0
    for (let file = 0; file < SIZE; file += 1) {
      const piece = at(board, file, rank)
      if (!piece) {
        empty += 1
        continue
      }
      if (empty > 0) {
        row += String(empty)
        empty = 0
      }
      const letter = PIECE_LETTER[piece.type]
      row += piece.color === 'white' ? letter.toUpperCase() : letter
    }
    if (empty > 0) row += String(empty)
    rows.push(row)
  }
  const castling = [
    board.castling.white.k ? 'K' : '',
    board.castling.white.q ? 'Q' : '',
    board.castling.black.k ? 'k' : '',
    board.castling.black.q ? 'q' : '',
  ].join('') || '-'
  const ep = board.ep ? squareName(board.ep) : '-'
  return `${rows.join('/')} ${board.turn === 'white' ? 'w' : 'b'} ${castling} ${ep} ${board.halfmove || 0} ${board.fullmove || 1}`
}

const KNIGHT_DELTAS = [
  [1, 2],
  [2, 1],
  [2, -1],
  [1, -2],
  [-1, -2],
  [-2, -1],
  [-2, 1],
  [-1, 2],
]
const BISHOP_DIRS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
]
const ROOK_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
]
const KING_DIRS = [...BISHOP_DIRS, ...ROOK_DIRS]

function pawnForward(color) {
  return color === 'white' ? 1 : -1
}

function pawnStartRank(color) {
  return color === 'white' ? 1 : 6
}

function promotionRank(color) {
  return color === 'white' ? 7 : 0
}

function pseudoMovesFrom(board, file, rank) {
  const piece = at(board, file, rank)
  if (!piece) return []
  const moves = []
  const push = (toFile, toRank, extra = {}) => {
    if (toFile < 0 || toFile > 7 || toRank < 0 || toRank > 7) return false
    const target = at(board, toFile, toRank)
    if (target && target.color === piece.color) return false
    moves.push({ from: { file, rank }, to: { file: toFile, rank: toRank }, piece: piece.type, color: piece.color, capture: Boolean(target), ...extra })
    return !target
  }

  if (piece.type === 'p') {
    const dir = pawnForward(piece.color)
    const oneRank = rank + dir
    if (oneRank >= 0 && oneRank <= 7 && !at(board, file, oneRank)) {
      if (oneRank === promotionRank(piece.color)) {
        for (const promotion of ['q', 'r', 'b', 'n']) {
          moves.push({ from: { file, rank }, to: { file, rank: oneRank }, piece: 'p', color: piece.color, capture: false, promotion })
        }
      } else {
        moves.push({ from: { file, rank }, to: { file, rank: oneRank }, piece: 'p', color: piece.color, capture: false })
        const twoRank = rank + dir * 2
        if (rank === pawnStartRank(piece.color) && !at(board, file, twoRank)) {
          moves.push({ from: { file, rank }, to: { file, rank: twoRank }, piece: 'p', color: piece.color, capture: false, double: true })
        }
      }
    }
    for (const dx of [-1, 1]) {
      const toFile = file + dx
      const toRank = rank + dir
      if (toFile < 0 || toFile > 7 || toRank < 0 || toRank > 7) continue
      const target = at(board, toFile, toRank)
      if (target && target.color !== piece.color) {
        if (toRank === promotionRank(piece.color)) {
          for (const promotion of ['q', 'r', 'b', 'n']) {
            moves.push({ from: { file, rank }, to: { file: toFile, rank: toRank }, piece: 'p', color: piece.color, capture: true, promotion })
          }
        } else {
          moves.push({ from: { file, rank }, to: { file: toFile, rank: toRank }, piece: 'p', color: piece.color, capture: true })
        }
      } else if (!target && board.ep && board.ep.file === toFile && board.ep.rank === toRank) {
        moves.push({ from: { file, rank }, to: { file: toFile, rank: toRank }, piece: 'p', color: piece.color, capture: true, enPassant: true })
      }
    }
    return moves
  }

  if (piece.type === 'n') {
    for (const [dx, dy] of KNIGHT_DELTAS) push(file + dx, rank + dy)
    return moves
  }
  if (piece.type === 'k') {
    for (const [dx, dy] of KING_DIRS) push(file + dx, rank + dy)
    // 王车易位（合法性在 legalMoves 里再校验被攻击格）
    const rights = board.castling[piece.color]
    const homeRank = piece.color === 'white' ? 0 : 7
    if (rank === homeRank && file === 4) {
      if (rights.k && !at(board, 5, homeRank) && !at(board, 6, homeRank)) {
        const rook = at(board, 7, homeRank)
        if (rook && rook.type === 'r' && rook.color === piece.color) {
          moves.push({ from: { file, rank }, to: { file: 6, rank: homeRank }, piece: 'k', color: piece.color, capture: false, castle: 'k' })
        }
      }
      if (rights.q && !at(board, 3, homeRank) && !at(board, 2, homeRank) && !at(board, 1, homeRank)) {
        const rook = at(board, 0, homeRank)
        if (rook && rook.type === 'r' && rook.color === piece.color) {
          moves.push({ from: { file, rank }, to: { file: 2, rank: homeRank }, piece: 'k', color: piece.color, capture: false, castle: 'q' })
        }
      }
    }
    return moves
  }
  const dirs = piece.type === 'b' ? BISHOP_DIRS : piece.type === 'r' ? ROOK_DIRS : KING_DIRS
  for (const [dx, dy] of dirs) {
    let x = file + dx
    let y = rank + dy
    while (x >= 0 && x <= 7 && y >= 0 && y <= 7) {
      const target = at(board, x, y)
      if (target) {
        if (target.color !== piece.color) {
          moves.push({ from: { file, rank }, to: { file: x, rank: y }, piece: piece.type, color: piece.color, capture: true })
        }
        break
      }
      moves.push({ from: { file, rank }, to: { file: x, rank: y }, piece: piece.type, color: piece.color, capture: false })
      x += dx
      y += dy
    }
  }
  return moves
}

/** 某格是否被 byColor 方攻击（含兵、马、王，忽略易位）。 */
export function isSquareAttacked(board, square, byColor) {
  const { file, rank } = square
  const dir = byColor === 'white' ? -1 : 1 // 兵从该方向攻击上来
  for (const dx of [-1, 1]) {
    const pawn = at(board, file + dx, rank + dir)
    if (pawn && pawn.color === byColor && pawn.type === 'p') return true
  }
  for (const [dx, dy] of KNIGHT_DELTAS) {
    const knight = at(board, file + dx, rank + dy)
    if (knight && knight.color === byColor && knight.type === 'n') return true
  }
  for (const [dx, dy] of KING_DIRS) {
    const king = at(board, file + dx, rank + dy)
    if (king && king.color === byColor && king.type === 'k') return true
  }
  for (const [dx, dy] of BISHOP_DIRS) {
    let x = file + dx
    let y = rank + dy
    while (x >= 0 && x <= 7 && y >= 0 && y <= 7) {
      const piece = at(board, x, y)
      if (piece) {
        if (piece.color === byColor && (piece.type === 'b' || piece.type === 'q')) return true
        break
      }
      x += dx
      y += dy
    }
  }
  for (const [dx, dy] of ROOK_DIRS) {
    let x = file + dx
    let y = rank + dy
    while (x >= 0 && x <= 7 && y >= 0 && y <= 7) {
      const piece = at(board, x, y)
      if (piece) {
        if (piece.color === byColor && (piece.type === 'r' || piece.type === 'q')) return true
        break
      }
      x += dx
      y += dy
    }
  }
  return false
}

export function findKing(board, color) {
  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const piece = at(board, file, rank)
      if (piece && piece.color === color && piece.type === 'k') return { file, rank }
    }
  }
  return null
}

export function inCheck(board, color) {
  const king = findKing(board, color)
  if (!king) return false
  return isSquareAttacked(board, king, other(color))
}

/** 落子（不校验），返回新 board；含易位车、吃过路兵、升变、权利与 ep 更新。 */
export function applyMove(board, move) {
  const next = cloneBoard(board)
  const piece = at(board, move.from.file, move.from.rank)
  if (!piece) return next
  const color = piece.color
  setCell(next.cells, move.from.file, move.from.rank, null)
  // 吃过路兵：拿掉身后的兵
  if (move.enPassant) {
    setCell(next.cells, move.to.file, move.from.rank, null)
  }
  const captured = at(board, move.to.file, move.to.rank)
  const isCapture = Boolean(captured) || Boolean(move.enPassant)
  setCell(next.cells, move.to.file, move.to.rank, { type: move.promotion || piece.type, color })
  // 王车易位：挪车
  if (move.castle === 'k') {
    setCell(next.cells, 7, move.from.rank, null)
    setCell(next.cells, 5, move.from.rank, { type: 'r', color })
  } else if (move.castle === 'q') {
    setCell(next.cells, 0, move.from.rank, null)
    setCell(next.cells, 3, move.from.rank, { type: 'r', color })
  }
  // 易位权利：王动 → 两边都没；车动/被吃 → 对应边没
  if (piece.type === 'k') {
    next.castling[color].k = false
    next.castling[color].q = false
  }
  if (piece.type === 'r') {
    const homeRank = color === 'white' ? 0 : 7
    if (move.from.rank === homeRank) {
      if (move.from.file === 7) next.castling[color].k = false
      if (move.from.file === 0) next.castling[color].q = false
    }
  }
  if (captured && captured.type === 'r') {
    const enemy = other(color)
    const homeRank = enemy === 'white' ? 0 : 7
    if (move.to.rank === homeRank) {
      if (move.to.file === 7) next.castling[enemy].k = false
      if (move.to.file === 0) next.castling[enemy].q = false
    }
  }
  next.ep = move.double ? { file: move.from.file, rank: (move.from.rank + move.to.rank) / 2 } : null
  next.halfmove = piece.type === 'p' || isCapture ? 0 : (board.halfmove || 0) + 1
  next.fullmove = board.fullmove + (color === 'black' ? 1 : 0)
  next.turn = other(color)
  next.ply = (board.ply || 0) + 1
  return next
}

function castleLegal(board, move) {
  const color = move.color
  const enemy = other(color)
  const homeRank = color === 'white' ? 0 : 7
  if (inCheck(board, color)) return false
  const passSquares = move.castle === 'k' ? [5, 6] : [3, 2]
  for (const file of passSquares) {
    if (isSquareAttacked(board, { file, rank: homeRank }, enemy)) return false
  }
  return true
}

/** 全部合法着法（过滤送王/被将时不解将的着法；易位额外校验经过格不被攻击）。 */
export function legalMoves(board) {
  const moves = []
  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const piece = at(board, file, rank)
      if (!piece || piece.color !== board.turn) continue
      for (const move of pseudoMovesFrom(board, file, rank)) {
        if (move.castle && !castleLegal(board, move)) continue
        const next = applyMove(board, move)
        if (inCheck(next, piece.color)) continue
        moves.push(move)
      }
    }
  }
  return moves
}

export function legalMovesFrom(board, from) {
  const square = typeof from === 'string' ? parseSquare(from) : from
  if (!square) return []
  return legalMoves(board).filter((move) => move.from.file === square.file && move.from.rank === square.rank)
}

export function normalizeMove(board, input) {
  if (!input || typeof input !== 'object') return null
  if (typeof input.iccs === 'string') {
    const text = input.iccs.trim().toLowerCase()
    const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(text)
    if (!match) return null
    const from = parseSquare(match[1])
    const to = parseSquare(match[2])
    if (!from || !to) return null
    return { from, to, promotion: match[3] || null }
  }
  if (typeof input.san === 'string') {
    const target = input.san.trim().replace(/[+#!?]/g, '')
    for (const move of legalMoves(board)) {
      if (notation(board, move).replace(/[+#]/g, '') === target) return move
    }
    return null
  }
  if (input.from !== undefined && input.to !== undefined) {
    const from = typeof input.from === 'string' ? parseSquare(input.from) : input.from
    const to = typeof input.to === 'string' ? parseSquare(input.to) : input.to
    if (!from || !to) return null
    return { from, to, promotion: input.promotion || null }
  }
  return null
}

export function validateMove(board, input) {
  const normalized = normalizeMove(board, input)
  if (!normalized) return { ok: false, code: 'BAD_MOVE', message: '无法识别的着法（用 e2e4 或 SAN，如 Nf3）' }
  const candidates = legalMoves(board).filter(
    (move) =>
      move.from.file === normalized.from.file &&
      move.from.rank === normalized.from.rank &&
      move.to.file === normalized.to.file &&
      move.to.rank === normalized.to.rank,
  )
  if (candidates.length === 0) {
    const piece = at(board, normalized.from.file, normalized.from.rank)
    if (!piece) return { ok: false, code: 'EMPTY_SQUARE', message: '起点没有棋子' }
    if (piece.color !== board.turn) return { ok: false, code: 'NOT_YOUR_PIECE', message: '现在不是这方走棋' }
    return { ok: false, code: 'ILLEGAL_MOVE', message: '这一步不合法（可能送将或走法不对）' }
  }
  if (candidates.length === 1) {
    const move = candidates[0]
    if (move.promotion) {
      const wanted = normalized.promotion || 'q'
      const chosen = candidates.find((candidate) => candidate.promotion === wanted)
      if (!chosen) return { ok: false, code: 'BAD_MOVE', message: '升变只能选 q/r/b/n' }
      return { ok: true, move: withMeta(board, chosen) }
    }
    return { ok: true, move: withMeta(board, move) }
  }
  const wanted = normalized.promotion || 'q'
  const chosen = candidates.find((candidate) => (candidate.promotion || 'q') === wanted) || candidates[0]
  return { ok: true, move: withMeta(board, chosen) }
}

function withMeta(board, move) {
  return { ...move, iccs: `${squareName(move.from)}${squareName(move.to)}${move.promotion || ''}`, capture: Boolean(move.capture) }
}

/** 子力不足和棋（K vs K、K+单马/象 vs K）。 */
export function insufficientMaterial(board) {
  const pieces = board.cells.filter(Boolean)
  if (pieces.length > 4) return false
  const nonKings = pieces.filter((piece) => piece.type !== 'k')
  if (nonKings.length === 0) return true
  if (nonKings.length === 1 && ['n', 'b'].includes(nonKings[0].type)) return true
  if (nonKings.length === 2 && nonKings.every((piece) => piece.type === 'b')) return true
  return false
}

/** 局面状态：'playing' | 'white-win' | 'black-win' | 'draw'（附 reason）。 */
export function statusOf(board) {
  const moves = legalMoves(board)
  if (moves.length === 0) {
    if (inCheck(board, board.turn)) {
      return { status: board.turn === 'white' ? 'black-win' : 'white-win', reason: 'checkmate' }
    }
    return { status: 'draw', reason: 'stalemate' }
  }
  if (board.halfmove >= 100) return { status: 'draw', reason: 'fifty-move' }
  if (insufficientMaterial(board)) return { status: 'draw', reason: 'insufficient' }
  return { status: 'playing', reason: null }
}

/** SAN 记谱（含易位、升变、将军/将死后缀、必要消歧）。 */
export function notation(board, move) {
  if (move.castle === 'k') return withSuffix(board, move, 'O-O')
  if (move.castle === 'q') return withSuffix(board, move, 'O-O-O')
  const piece = at(board, move.from.file, move.from.rank)
  if (!piece) return ''
  let text = ''
  if (piece.type === 'p') {
    if (move.capture) text += FILES[move.from.file]
  } else {
    text += piece.type.toUpperCase()
    const others = legalMoves(board).filter(
      (candidate) =>
        candidate.piece === piece.type &&
        candidate.to.file === move.to.file &&
        candidate.to.rank === move.to.rank &&
        !(candidate.from.file === move.from.file && candidate.from.rank === move.from.rank),
    )
    if (others.length > 0) {
      const sameFile = others.some((candidate) => candidate.from.file === move.from.file)
      const sameRank = others.some((candidate) => candidate.from.rank === move.from.rank)
      if (!sameFile) text += FILES[move.from.file]
      else if (!sameRank) text += String(move.from.rank + 1)
      else text += squareName(move.from)
    }
  }
  if (move.capture) text += 'x'
  text += squareName(move.to)
  if (move.promotion) text += '=' + move.promotion.toUpperCase()
  return withSuffix(board, move, text)
}

function withSuffix(board, move, text) {
  const next = applyMove(board, move)
  const result = statusOf(next)
  if (result.status === 'playing') return inCheck(next, next.turn) ? text + '+' : text
  if (result.reason === 'checkmate') return text + '#'
  return text
}

/** 前端合法性索引：{ "e2": ["e3","e4"], ... } */
export function legalIndex(board) {
  const index2 = {}
  for (const move of legalMoves(board)) {
    const from = squareName(move.from)
    const to = squareName(move.to)
    if (!index2[from]) index2[from] = []
    if (!index2[from].includes(to)) index2[from].push(to)
  }
  return index2
}

export function asciiBoard(board) {
  const lines = []
  for (let rank = 7; rank >= 0; rank -= 1) {
    const row = []
    for (let file = 0; file < 8; file += 1) {
      const piece = at(board, file, rank)
      if (!piece) {
        row.push('·')
        continue
      }
      const letter = PIECE_LETTER[piece.type]
      row.push(piece.color === 'white' ? letter.toUpperCase() : letter)
    }
    lines.push(`${rank + 1} ${row.join(' ')}`)
  }
  lines.push(`  ${FILES.split('').join(' ')}`)
  return lines
}

export { START_FEN, PIECE_NAME_CN, PIECE_LETTER, other }
