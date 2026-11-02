// 棋子与棋盘几何：只负责“长什么样、摆在哪”，不含任何走子规则。
// 规则一律以服务端 /api/state 的 legal 与 snapshot 为准。

/** 棋盘 viewBox（与 index.html 中的 <svg viewBox> 保持一致）。 */
export const VIEW = { x: -0.62, y: -0.62, w: 9.24, h: 10.24 }

/** 棋盘几何：9 列 × 10 行，交点坐标 file 0..8、rank 0..9（rank 0 为红方底线）。 */
export const BOARD = { files: 9, ranks: 10, pad: 0.62 }

const FILE_LETTERS = 'abcdefghi'

/** 汉字棋子：红黑两套写法。 */
export const PIECE_GLYPHS = {
  red: { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' },
  black: { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' },
}

/** 兼容部分 FEN 方言：H=马、E=象。 */
const TYPE_ALIASES = { H: 'N', E: 'B' }

const COLOR_LABELS = { red: '红方', black: '黑方' }

/** 'h2' -> { file: 7, rank: 2 }；非法返回 null。 */
export function parseSquare(name) {
  if (typeof name !== 'string') return null
  const text = name.trim().toLowerCase()
  if (text.length !== 2) return null
  const file = FILE_LETTERS.indexOf(text[0])
  const rank = Number(text[1])
  if (file < 0 || !Number.isInteger(rank) || rank < 0 || rank > 9) return null
  return { file, rank }
}

/** { file, rank } -> 'h2'；越界返回 null。 */
export function squareName(pos) {
  if (!pos || typeof pos !== 'object') return null
  const { file, rank } = pos
  if (!Number.isInteger(file) || !Number.isInteger(rank)) return null
  if (file < 0 || file > 8 || rank < 0 || rank > 9) return null
  return FILE_LETTERS[file] + String(rank)
}

/**
 * 解析中国象棋 FEN 的棋盘部分（只用于画棋子，不做规则判断）。
 * 返回 { pieces: Map<'h2', {type,color}>, turn: 'red'|'black' }。
 */
export function parseFen(fen) {
  const pieces = new Map()
  let turn = 'red'
  if (typeof fen !== 'string' || !fen.trim()) return { pieces, turn }
  const parts = fen.trim().split(/\s+/)
  const rows = (parts[0] || '').split('/')
  for (let i = 0; i < rows.length && i < BOARD.ranks; i++) {
    const rank = 9 - i
    let file = 0
    for (const ch of rows[i]) {
      if (ch >= '1' && ch <= '9') {
        file += Number(ch)
        continue
      }
      if (file > 8) break
      const isUpper = ch === ch.toUpperCase()
      const color = isUpper ? 'red' : 'black'
      const raw = ch.toUpperCase()
      const type = TYPE_ALIASES[raw] || raw
      if (PIECE_GLYPHS[color][type]) {
        pieces.set(squareName({ file, rank }), { type, color })
      }
      file += 1
    }
  }
  const side = parts[1]
  if (side === 'b' || side === 'B') turn = 'black'
  else if (side === 'w' || side === 'W' || side === 'r' || side === 'R') turn = 'red'
  return { pieces, turn }
}

/** 交点 -> 棋盘子元素里的百分比坐标（用于绝对定位）。 */
export function pointOf(square) {
  const pos = typeof square === 'string' ? parseSquare(square) : square
  if (!pos) return null
  const left = ((pos.file + BOARD.pad) / VIEW.w) * 100
  const top = (9 - pos.rank + BOARD.pad) / VIEW.h * 100
  return { left, top }
}

/** 棋子的汉字。 */
export function glyphOf(piece) {
  if (!piece || !PIECE_GLYPHS[piece.color]) return ''
  return PIECE_GLYPHS[piece.color][piece.type] || ''
}

/** 棋子的中文读法，用于无障碍标签。 */
export function labelOf(piece) {
  if (!piece) return ''
  return (COLOR_LABELS[piece.color] || '') + glyphOf(piece)
}

/** 两枚棋子是否完全相同（用于按局面做增量渲染）。 */
export function isSamePiece(a, b) {
  if (!a || !b) return false
  return a.type === b.type && a.color === b.color
}

/** 生成一枚棋子的 DOM 节点（不使用 HTML 字符串）。 */
export function createPieceElement(piece, square) {
  const node = document.createElement('div')
  node.className = 'piece piece--' + (piece.color === 'black' ? 'black' : 'red')
  node.dataset.square = square
  node.dataset.color = piece.color
  node.dataset.type = piece.type
  node.textContent = glyphOf(piece)
  node.setAttribute('role', 'img')
  node.setAttribute('aria-label', labelOf(piece) + ' ' + square)
  const pt = pointOf(square)
  if (pt) {
    node.style.left = pt.left.toFixed(4) + '%'
    node.style.top = pt.top.toFixed(4) + '%'
  }
  return node
}

/** 棋盘宽高比（宽 / 高），用于自适应尺寸计算。 */
export const BOARD_RATIO = VIEW.w / VIEW.h
