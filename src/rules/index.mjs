/**
 * 规则层门面：当前只有中国象棋；国际象棋后续按同一门面追加。
 * 宿主层只依赖这里导出的形状（docs/DESIGN.md §3）。
 */
import * as xiangqi from './xiangqi.mjs'

const REGISTRY = {
  xiangqi,
}

/** 取某棋种规则实现；未知棋种抛错。 */
export function getRules(kind = 'xiangqi') {
  const rules = REGISTRY[kind]
  if (!rules) throw new Error(`未知棋种：${kind}`)
  return rules
}

/** 支持的棋种。 */
export function supportedKinds() {
  return Object.keys(REGISTRY)
}

/**
 * 按中文记谱找合法着法（如「炮二平五」「马8进7」）。
 * @returns {object|null} Move 或 null
 */
export function findMoveByNotation(board, text) {
  const target = String(text || '').replace(/\s+/g, '')
  if (!target) return null
  for (const move of xiangqi.legalMoves(board)) {
    if (xiangqi.notation(board, move) === target) return move
  }
  return null
}

/**
 * 生成给前端的合法性索引：{ "h2": ["e2","h0", ...], ... }。
 */
export function legalIndex(board) {
  const index = {}
  for (const move of xiangqi.legalMoves(board)) {
    const from = xiangqi.squareName(move.from)
    const to = xiangqi.squareName(move.to)
    if (!from || !to) continue
    if (!index[from]) index[from] = []
    index[from].push(to)
  }
  return index
}

export { xiangqi }
export default { getRules, supportedKinds, findMoveByNotation, legalIndex }
