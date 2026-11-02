/**
 * 规则层契约测试（docs/DESIGN.md §3）。
 *
 * 原则：
 * - 只 import `src/rules/xiangqi.mjs` 与 `src/rules/index.mjs` 的公开导出，不碰内部辅助函数；
 * - 断言全部落在契约上（FEN / 中文记谱 / code / message / 着法数），不依赖数组下标等实现细节；
 * - 非法用例逐条核对 `code` 与「人话」`message`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  kind,
  START_FEN,
  parseSquare,
  squareName,
  initialBoard,
  toFen,
  fromFen,
  legalMoves,
  legalMovesFrom,
  validateMove,
  applyMove,
  notation,
  statusOf,
  asciiBoard,
} from '../src/rules/xiangqi.mjs'
import { getRules } from '../src/rules/index.mjs'

// ---------------------------------------------------------------------------
// 测试辅助（只用公开 API 拼局面：FEN 是契约的一部分）
// ---------------------------------------------------------------------------

const FILES = 'abcdefghi'

/** { h2: 'C', e0: 'K', ... } -> FEN；大写=红方，小写=黑方。 */
function fenFrom(pieces, turn = 'r') {
  const rows = []
  for (let rank = 9; rank >= 0; rank -= 1) {
    let row = ''
    let empty = 0
    for (let file = 0; file <= 8; file += 1) {
      const piece = pieces[FILES[file] + rank]
      if (!piece) {
        empty += 1
        continue
      }
      if (empty > 0) {
        row += empty
        empty = 0
      }
      row += piece
    }
    if (empty > 0) row += empty
    rows.push(row)
  }
  return `${rows.join('/')} ${turn}`
}

/** 用棋子表建局面。 */
function boardFrom(pieces, turn = 'r') {
  return fromFen(fenFrom(pieces, turn))
}

/** 取一个合法着法；不合法就让测试失败（带实际 code/message）。 */
function legalMove(board, from, to) {
  const verdict = validateMove(board, { from, to })
  assert.equal(
    verdict.ok,
    true,
    `期望 ${from}->${to} 合法，实际：${verdict.code} ${verdict.message}`,
  )
  return verdict.move
}

/** 合法着法的中文记谱。 */
function notationOf(board, from, to) {
  return notation(board, legalMove(board, from, to))
}

/** 断言非法，并核对 code 与 message 片段。 */
function expectIllegal(board, from, to, code, messagePart) {
  const verdict = validateMove(board, { from, to })
  assert.equal(verdict.ok, false, `期望 ${from}->${to} 非法，实际却判为合法`)
  assert.equal(verdict.code, code, `${from}->${to} 的 code 期望 ${code}，实际 ${verdict.code}`)
  if (messagePart) {
    assert.ok(
      String(verdict.message).includes(messagePart),
      `${from}->${to} 的 message 期望包含「${messagePart}」，实际「${verdict.message}」`,
    )
  }
  return verdict
}

// ---------------------------------------------------------------------------
// 契约常量与坐标
// ---------------------------------------------------------------------------

test('契约常量：kind / START_FEN', () => {
  assert.equal(kind, 'xiangqi')
  assert.equal(
    START_FEN,
    'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR r',
  )
})

test('坐标换算：parseSquare / squareName 往返', () => {
  assert.deepEqual(parseSquare('h2'), { file: 7, rank: 2 })
  assert.deepEqual(parseSquare('a0'), { file: 0, rank: 0 })
  assert.deepEqual(parseSquare('i9'), { file: 8, rank: 9 })
  assert.deepEqual(parseSquare(' H2 '), { file: 7, rank: 2 })

  for (const square of ['a0', 'e0', 'i0', 'b2', 'h2', 'a9', 'e9', 'i9']) {
    const parsed = parseSquare(square)
    assert.equal(squareName(parsed), square)
  }
  // 90 个格子全部往返一致
  const seen = new Set()
  for (let rank = 0; rank <= 9; rank += 1) {
    for (let file = 0; file <= 8; file += 1) {
      seen.add(squareName({ file, rank }))
    }
  }
  assert.equal(seen.size, 90)

  for (const bad of ['', 'j0', 'a10', 'aa', '2h', 'h 2', null, 42]) {
    assert.equal(parseSquare(bad), null, `parseSquare(${JSON.stringify(bad)}) 应为 null`)
  }
})

test('FEN 往返：初始局面与中局', () => {
  const board = initialBoard()
  assert.equal(toFen(board), START_FEN)
  assert.equal(toFen(fromFen(START_FEN)), START_FEN)

  // 行棋方也要往返
  const blackTurnFen = START_FEN.replace(/\s+r$/, ' b')
  const blackBoard = fromFen(blackTurnFen)
  assert.equal(blackBoard.turn, 'black')
  assert.equal(toFen(blackBoard), blackTurnFen)

  // 连走 4 步后再往返（马八进七 → 马8进7 → 车九平八 → 车9平8）
  let mid = initialBoard()
  for (const [from, to] of [['b0', 'c2'], ['h9', 'g7'], ['a0', 'b0'], ['i9', 'h9']]) {
    mid = applyMove(mid, { from, to })
  }
  const midFen = toFen(mid)
  assert.equal(toFen(fromFen(midFen)), midFen)
  assert.equal(midFen.endsWith(' r'), true)
  assert.equal(mid.history.length, 4)
})

// ---------------------------------------------------------------------------
// 初始局面着法数（标准中国象棋红先 44 步）
// ---------------------------------------------------------------------------

test('初始局面红方合法着法恰好 44 步', () => {
  const moves = legalMoves(initialBoard())
  assert.equal(moves.length, 44)

  // 不许出现重复着法
  const unique = new Set(moves.map((move) => move.iccs))
  assert.equal(unique.size, moves.length)

  // 每一步都是 red 的子
  for (const move of moves) {
    assert.match(move.iccs, /^[a-i][0-9][a-i][0-9]$/)
    assert.equal(typeof move.capture, 'boolean')
  }
})

test('初始局面着法分布（逐子核对，防止整类走法漏生成）', () => {
  const expected = {
    a0: 2, b0: 2, c0: 2, d0: 1, e0: 1, f0: 1, g0: 2, h0: 2, i0: 2,
    b2: 12, h2: 12,
    a3: 1, c3: 1, e3: 1, g3: 1, i3: 1,
  }
  const actual = {}
  for (const move of legalMoves(initialBoard())) {
    const from = squareName(move.from)
    actual[from] = (actual[from] || 0) + 1
  }
  assert.deepEqual(actual, expected)

  // 两个炮各 12 步：其中包含「翻山」吃对方底车（b2xb9 / h2xh9）
  assert.equal(legalMovesFrom(initialBoard(), parseSquare('h2')).length, 12)
  assert.ok(legalMovesFrom(initialBoard(), parseSquare('h2')).some((m) => m.iccs === 'h2h9'))
  assert.ok(legalMovesFrom(initialBoard(), parseSquare('b2')).some((m) => m.iccs === 'b2b9'))
})

test('黑方初始局面同样 44 步（镜像对称）', () => {
  const blackBoard = fromFen(START_FEN.replace(/\s+r$/, ' b'))
  const moves = legalMoves(blackBoard)
  assert.equal(moves.length, 44)

  const expected = {
    a9: 2, b9: 2, c9: 2, d9: 1, e9: 1, f9: 1, g9: 2, h9: 2, i9: 2,
    b7: 12, h7: 12,
    a6: 1, c6: 1, e6: 1, g6: 1, i6: 1,
  }
  const actual = {}
  for (const move of moves) {
    const from = squareName(move.from)
    actual[from] = (actual[from] || 0) + 1
  }
  assert.deepEqual(actual, expected)
})

test('炮翻山吃子：h2h9 合法且是吃子', () => {
  const board = initialBoard()
  const verdict = validateMove(board, { from: 'h2', to: 'h9' })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.move.capture, true)

  const next = applyMove(board, { from: 'h2', to: 'h9' })
  assert.equal(toFen(next).startsWith('rnbakabCr/'), true, 'h9 的黑车应被红炮替换')
})

// ---------------------------------------------------------------------------
// 中文记谱
// ---------------------------------------------------------------------------

test('中文记谱：红方标准着法', () => {
  const board = initialBoard()
  assert.equal(notationOf(board, 'h2', 'e2'), '炮二平五')
  assert.equal(notationOf(board, 'b2', 'e2'), '炮八平五')
  assert.equal(notationOf(board, 'b0', 'c2'), '马八进七')
  assert.equal(notationOf(board, 'h0', 'g2'), '马二进三')
  assert.equal(notationOf(board, 'i0', 'i1'), '车一进一')
  assert.equal(notationOf(board, 'a0', 'a2'), '车九进二')
  assert.equal(notationOf(board, 'c3', 'c4'), '兵七进一')
  assert.equal(notationOf(board, 'g3', 'g4'), '兵三进一')
})

test('中文记谱：黑方标准着法（阿拉伯数字 + 从左向右数路）', () => {
  const board = fromFen(START_FEN.replace(/\s+r$/, ' b'))
  assert.equal(notationOf(board, 'h9', 'g7'), '马8进7')
  assert.equal(notationOf(board, 'b9', 'c7'), '马2进3')
  assert.equal(notationOf(board, 'g6', 'g5'), '卒7进1')
  assert.equal(notationOf(board, 'a6', 'a5'), '卒1进1')
  assert.equal(notationOf(board, 'i6', 'i5'), '卒9进1')
  assert.equal(notationOf(board, 'i9', 'i8'), '车9进1')
})

test('中文记谱：同列两子用「前/后」前缀', () => {
  // 红方：a0、a5 两个车
  const redBoard = boardFrom({ a0: 'R', a5: 'R', d0: 'K', e9: 'k' })
  assert.equal(notationOf(redBoard, 'a5', 'a6'), '前车进一')
  assert.equal(notationOf(redBoard, 'a0', 'a1'), '后车进一')

  // 黑方：a4、a9 两个车（黑方「前」= 更靠近红方，即 rank 更小；黑方数字用阿拉伯数字）
  const blackBoard = boardFrom({ a4: 'r', a9: 'r', d0: 'K', e9: 'k' }, 'b')
  assert.equal(notationOf(blackBoard, 'a4', 'a3'), '前车进1')
  assert.equal(notationOf(blackBoard, 'a9', 'a8'), '后车进1')
})

// ---------------------------------------------------------------------------
// 各兵种走法
// ---------------------------------------------------------------------------

test('车：直线任意距离，路径必须通畅', () => {
  const board = initialBoard()
  assert.equal(legalMove(board, 'a0', 'a1').iccs, 'a0a1')
  assert.equal(legalMove(board, 'a0', 'a2').iccs, 'a0a2')
  assert.equal(legalMove(board, 'i0', 'i2').iccs, 'i0i2')

  expectIllegal(board, 'a0', 'a5', 'ILLEGAL_PATTERN', '车的路径被挡住了')
  expectIllegal(board, 'a0', 'b0', 'ILLEGAL_PATTERN', '不能吃自己的棋子')
  expectIllegal(board, 'e0', 'd2', 'ILLEGAL_PATTERN', '将/帅只能走一步直线')
})

test('马：走日字，马腿被挡不能走', () => {
  const board = initialBoard()
  // b0 的马腿在 b1（空），可走 a2 / c2
  assert.equal(legalMove(board, 'b0', 'a2').iccs, 'b0a2')
  assert.equal(legalMove(board, 'b0', 'c2').iccs, 'b0c2')
  // b0 -> d1 的马腿在 c0（红相占着）
  expectIllegal(board, 'b0', 'd1', 'ILLEGAL_PATTERN', '马腿被挡住了')
  // 不是日字（b3 为空位，先过「不能吃自己的棋子」这一关）
  expectIllegal(board, 'b0', 'b3', 'ILLEGAL_PATTERN', '马走日字')
})

test('象：走田字、象眼不能堵、不能过河', () => {
  const board = initialBoard()
  assert.equal(legalMove(board, 'c0', 'a2').iccs, 'c0a2')
  assert.equal(legalMove(board, 'c0', 'e2').iccs, 'c0e2')

  // 象眼被堵
  const blockedEye = boardFrom({ c0: 'B', b1: 'P', d0: 'K', e9: 'k' })
  expectIllegal(blockedEye, 'c0', 'a2', 'ILLEGAL_PATTERN', '象眼被挡住了')

  // 象不能过河（红方 rank>=5）
  const crossing = boardFrom({ c4: 'B', d0: 'K', e9: 'k' })
  expectIllegal(crossing, 'c4', 'a6', 'ILLEGAL_PATTERN', '象不能过河')

  // 不是田字
  expectIllegal(board, 'c0', 'c2', 'ILLEGAL_PATTERN', '象走田字')
})

test('士：只斜走一步、不能出九宫', () => {
  const board = initialBoard()
  assert.equal(legalMove(board, 'd0', 'e1').iccs, 'd0e1')
  assert.equal(legalMove(board, 'f0', 'e1').iccs, 'f0e1')

  const outside = boardFrom({ d0: 'A', e1: 'K', d9: 'k' })
  expectIllegal(outside, 'd0', 'c1', 'ILLEGAL_PATTERN', '士不能出九宫')
  expectIllegal(outside, 'd0', 'd1', 'ILLEGAL_PATTERN', '士只能斜走一步')
})

test('将/帅：一步直线、不能出九宫', () => {
  const board = initialBoard()
  assert.equal(legalMove(board, 'e0', 'e1').iccs, 'e0e1')

  const palace = boardFrom({ d0: 'K', e9: 'k' })
  expectIllegal(palace, 'd0', 'c0', 'ILLEGAL_PATTERN', '将/帅不能出九宫')
  expectIllegal(palace, 'd0', 'd3', 'ILLEGAL_PATTERN', '将/帅只能走一步直线')
})

test('兵/卒：未过河只能前进，过河后可横走但不能后退', () => {
  const board = initialBoard()
  assert.equal(legalMove(board, 'a3', 'a4').iccs, 'a3a4')
  expectIllegal(board, 'a3', 'b3', 'ILLEGAL_PATTERN', '兵/卒未过河只能向前走一步')

  // 已过河（红方 rank>=5）：e5 可左右横走
  const crossed = boardFrom({ e5: 'P', d0: 'K', e9: 'k' })
  assert.equal(legalMove(crossed, 'e5', 'd5').iccs, 'e5d5')
  assert.equal(legalMove(crossed, 'e5', 'f5').iccs, 'e5f5')
  assert.equal(legalMove(crossed, 'e5', 'e6').iccs, 'e5e6')
  expectIllegal(crossed, 'e5', 'e4', 'ILLEGAL_PATTERN', '不能后退')
})

test('炮：平移、隔一子吃子；无隔子/隔两子不能吃；平移路径不能有子', () => {
  const board = initialBoard()
  assert.equal(legalMove(board, 'h2', 'e2').iccs, 'h2e2')
  assert.equal(legalMove(board, 'b2', 'b4').iccs, 'b2b4')

  // 隔一个棋子可以吃（红帅放 d0，避免与黑将 e9 照面）
  const oneScreen = boardFrom({ a0: 'C', a1: 'P', a5: 'r', d0: 'K', e9: 'k' })
  const capture = legalMove(oneScreen, 'a0', 'a5')
  assert.equal(capture.capture, true)

  // 无隔子不能吃
  const noScreen = boardFrom({ a0: 'C', a5: 'r', d0: 'K', e9: 'k' })
  expectIllegal(noScreen, 'a0', 'a5', 'ILLEGAL_PATTERN', '炮吃子必须隔一个棋子')

  // 隔两个棋子不能吃
  const twoScreens = boardFrom({ a0: 'C', a1: 'P', a2: 'P', a5: 'r', d0: 'K', e9: 'k' })
  expectIllegal(twoScreens, 'a0', 'a5', 'ILLEGAL_PATTERN', '炮吃子必须隔一个棋子')

  // 不吃子时路径上不能有棋子
  const blockedMove = boardFrom({ a0: 'C', a1: 'P', d0: 'K', e9: 'k' })
  expectIllegal(blockedMove, 'a0', 'a3', 'ILLEGAL_PATTERN', '炮移动时路径上不能有棋子')

  // 炮不能斜走（g4 为空位）
  expectIllegal(board, 'h2', 'g4', 'ILLEGAL_PATTERN', '炮只能走直线')
})

// ---------------------------------------------------------------------------
// 基础非法原因
// ---------------------------------------------------------------------------

test('非法：对方子 / 空位 / 吃自己子 / 坐标非法 / 原地不动', () => {
  const board = initialBoard()

  expectIllegal(board, 'a9', 'a8', 'NOT_YOUR_PIECE', '还没轮到你走')
  expectIllegal(board, 'd4', 'e4', 'EMPTY_SQUARE', '该位置没有棋子')
  expectIllegal(board, 'a0', 'b0', 'ILLEGAL_PATTERN', '不能吃自己的棋子')
  expectIllegal(board, 'j0', 'a1', 'OUT_OF_BOARD', '坐标不合法')
  expectIllegal(board, 'a0', 'a0', 'ILLEGAL_PATTERN', '起点和终点不能相同')

  // 字符串坐标也走同一套校验
  const verdict = validateMove(board, { from: 'j0', to: 'a1' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.code, 'OUT_OF_BOARD')
  assert.equal(typeof verdict.message, 'string')
  assert.ok(verdict.message.length > 0)
})

// ---------------------------------------------------------------------------
// 将军相关：将帅照面 / 走后自将
// ---------------------------------------------------------------------------

test('将帅照面 → FLYING_GENERAL', () => {
  // 红帅 e0、黑将 e9，中间只有红车 e5 挡着；红车横走即照面
  const board = boardFrom({ e0: 'K', e5: 'R', e9: 'k' })
  const verdict = expectIllegal(board, 'e5', 'd5', 'FLYING_GENERAL', '将帅不能照面')
  assert.equal(verdict.message, '将帅不能照面')
})

test('走后自己被将军 → SELF_CHECK', () => {
  // 红车 e5 被黑车 e9 牵制：横走会暴露红帅
  const board = boardFrom({ e0: 'K', e5: 'R', e9: 'r', d9: 'k' })
  const verdict = expectIllegal(board, 'e5', 'd5', 'SELF_CHECK', '走后自己被将军')
  assert.equal(verdict.message, '走后自己被将军')

  // 同一局面下，把红车沿 e 线走一步（仍挡着）是合法的
  assert.equal(legalMove(board, 'e5', 'e6').iccs, 'e5e6')
})

// ---------------------------------------------------------------------------
// applyMove 纯函数 / 非法抛错
// ---------------------------------------------------------------------------

test('applyMove 是纯函数，返回带 history 的新局面', () => {
  const board = initialBoard()
  const fenBefore = toFen(board)
  const snapshotBefore = JSON.stringify(board.squares)
  const turnBefore = board.turn
  const plyBefore = board.ply
  const historyBefore = (board.history || []).length

  const next = applyMove(board, { from: 'h2', to: 'e2' })

  // 入参一个字段都不能变
  assert.equal(toFen(board), fenBefore)
  assert.equal(JSON.stringify(board.squares), snapshotBefore)
  assert.equal(board.turn, turnBefore)
  assert.equal(board.ply, plyBefore)
  assert.equal((board.history || []).length, historyBefore)

  // 新对象、新数组
  assert.notEqual(next, board)
  assert.notEqual(next.squares, board.squares)

  // 新局面的契约字段
  assert.equal(next.turn, 'black')
  assert.equal(next.ply, plyBefore + 1)
  assert.equal(next.history.length, 1)
  assert.equal(next.history[0].move.iccs, 'h2e2')
  assert.equal(next.history[0].notation, '炮二平五')
  assert.equal(
    toFen(next),
    'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR b',
  )

  // 继续在返回值上走子，不影响原局面
  const next2 = applyMove(next, { from: 'h9', to: 'g7' })
  assert.equal(next2.history.length, 2)
  assert.equal(next2.history[1].notation, '马8进7')
  assert.equal(board.ply, 0)
})

test('applyMove 遇到非法着法抛错，错误带 code', () => {
  const board = initialBoard()
  assert.throws(
    () => applyMove(board, { from: 'a3', to: 'b3' }),
    (error) => error.code === 'ILLEGAL_PATTERN' && error.message.includes('兵/卒未过河'),
  )
  assert.throws(
    () => applyMove(board, { from: 'd4', to: 'e4' }),
    (error) => error.code === 'EMPTY_SQUARE',
  )
  // 抛错后原局面仍然完好
  assert.equal(toFen(board), START_FEN)
})

// ---------------------------------------------------------------------------
// legalMovesFrom / statusOf / asciiBoard / getRules
// ---------------------------------------------------------------------------

test('legalMovesFrom 只返回行棋方的子', () => {
  const board = initialBoard()
  assert.equal(legalMovesFrom(board, parseSquare('h2')).length, 12)
  assert.equal(legalMovesFrom(board, parseSquare('a9')).length, 0, '黑子不该有红方着法')
  assert.equal(legalMovesFrom(board, parseSquare('d4')).length, 0, '空位没有着法')
  assert.deepEqual(legalMovesFrom(board, { file: 99, rank: 0 }), [])
})

test('statusOf：进行中 / 红胜 / 黑胜', () => {
  assert.equal(statusOf(initialBoard()), 'playing')

  // 红胜：黑将 e9 被 a9 车与 e0 车夹死（d9/f9 同线被 a9 控制，e8 被 e0 控制）
  const redMate = boardFrom({ e9: 'k', a9: 'R', e0: 'R', d0: 'K' }, 'b')
  assert.equal(legalMoves(redMate).length, 0)
  assert.equal(statusOf(redMate), 'red-win')

  // 黑胜：镜像
  const blackMate = boardFrom({ e0: 'K', a0: 'r', e9: 'r', d9: 'k' }, 'r')
  assert.equal(legalMoves(blackMate).length, 0)
  assert.equal(statusOf(blackMate), 'black-win')
})

test('asciiBoard：恰好 10 行，每行 9 个格子符号', () => {
  const lines = asciiBoard(initialBoard())
  assert.equal(lines.length, 10)
  for (const [index, line] of lines.entries()) {
    assert.match(line, /^[0-9] (?:[^\s] ){8}[^\s]$/, `第 ${index} 行格式不对：${line}`)
  }
  // 红方在下：第 1 行是黑方底线（将），第 10 行是红方底线（帅）
  assert.ok(lines[0].includes('将'), `首行应含黑将：${lines[0]}`)
  assert.ok(lines[9].includes('帅'), `末行应含红帅：${lines[9]}`)
  // 空位用 ·
  assert.ok(lines[4].includes('·'), `空行应用 · 占位：${lines[4]}`)
})

test('getRules 门面返回完整规则接口', () => {
  const rules = getRules()
  assert.equal(rules.kind, 'xiangqi')
  for (const name of [
    'initialBoard',
    'toFen',
    'fromFen',
    'legalMoves',
    'legalMovesFrom',
    'validateMove',
    'applyMove',
    'notation',
    'statusOf',
    'asciiBoard',
    'parseSquare',
    'squareName',
  ]) {
    assert.equal(typeof rules[name], 'function', `getRules() 缺少 ${name}`)
  }
  assert.equal(getRules('xiangqi').initialBoard, rules.initialBoard)
  assert.throws(() => getRules('chess'), /未知棋种/)
})
