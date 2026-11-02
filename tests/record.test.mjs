/**
 * 记谱 Markdown 契约测试（docs/DESIGN.md §8）。
 *
 * 只 import `src/record.mjs` 的 `renderRecordMd`，用对局快照（DESIGN §4）驱动；
 * 重点：章节结构、着法表、文字棋盘 10 行、口令/URL 脱敏。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderRecordMd } from '../src/record.mjs'
import { initialBoard, toFen, asciiBoard } from '../src/rules/xiangqi.mjs'

const REAL_BASE = 'https://example.trycloudflare.com'
const REAL_TOKEN = 'a1b2c3d4e5f6g7h8i9'

/** DESIGN §4 形状的对局快照（红先，已走 4 步）。 */
function makeSnapshot(overrides = {}) {
  const board = initialBoard()
  return {
    gameId: 'xq-20261102-1a2b',
    fen: toFen(board),
    turn: 'black',
    status: 'playing',
    rev: 4,
    moves: [
      { n: 1, color: 'red', iccs: 'h2e2', notation: '炮二平五', at: 1 },
      { n: 2, color: 'black', iccs: 'h9g7', notation: '马8进7', at: 2 },
      { n: 3, color: 'red', iccs: 'a0b0', notation: '车九平八', at: 3 },
      { n: 4, color: 'black', iccs: 'i9h9', notation: '车9平8', at: 4 },
    ],
    lastMove: {
      iccs: 'i9h9',
      from: { file: 8, rank: 9 },
      to: { file: 7, rank: 9 },
      notation: '车9平8',
    },
    humanSide: 'red',
    agentSide: 'black',
    startedAt: 0,
    deadline: 0,
    remainingMs: 18 * 60 * 1000 + 42 * 1000,
    ascii: asciiBoard(board),
    ...overrides,
  }
}

const md = renderRecordMd(makeSnapshot())

test('标题与状态行符合 DESIGN §8', () => {
  assert.ok(
    md.includes('# 象棋对局 xq-20261102-1a2b · 红方：人类 · 黑方：agent'),
    `标题行不符：\n${md.split('\n')[0]}`,
  )
  assert.ok(md.includes('- 状态：进行中 · 轮到：黑方 · 剩余：18:42'))
  assert.ok(md.includes('- FEN：`' + toFen(initialBoard()) + '`'))
  assert.ok(md.includes('- 最近一手：车9平8（i9h9）'))
})

test('包含「## 棋盘」且文字棋盘恰好 10 行', () => {
  assert.ok(md.includes('## 棋盘'))
  const boardLines = md
    .split('\n')
    .filter((line) => /^[0-9] (?:[^\s] ){8}[^\s]$/.test(line))
  assert.equal(boardLines.length, 10, `文字棋盘行数应为 10，实际 ${boardLines.length}`)
  assert.ok(boardLines[0].includes('将'))
  assert.ok(boardLines[9].includes('帅'))
})

test('包含「## 着法」表格，红黑两列按回合对齐', () => {
  assert.ok(md.includes('## 着法'))
  assert.ok(md.includes('| 回合 | 红方 | 黑方 |'))
  assert.ok(md.includes('|---:|---|---|'))
  assert.ok(md.includes('| 1 | 炮二平五 | 马8进7 |'))
  assert.ok(md.includes('| 2 | 车九平八 | 车9平8 |'))
})

test('包含「## 给 agent 的下一步」，给出可复制的请求示例', () => {
  assert.ok(md.includes('## 给 agent 的下一步（可直接复制）'))
  assert.ok(md.includes('`GET <base>/api/state`'))
  assert.ok(md.includes('`POST <base>/api/move`'))
  assert.ok(md.includes('{"from":"h2","to":"e2"}'))
  assert.ok(md.includes('`GET <base>/api/record.md`'))
})

test('口令与 URL 脱敏为 <token> / <base>，不泄漏真实域名', () => {
  // 默认调用（宿主实际路径）：一律占位符
  assert.ok(md.includes('<token>'), '应含 <token> 占位符')
  assert.ok(md.includes('<base>'), '应含 <base> 占位符')
  assert.equal(/https?:\/\//.test(md), false, `不应出现真实 URL：\n${md}`)
  assert.equal(md.includes('trycloudflare'), false)

  // 宿主调用方式：renderRecordMd({ ...snapshot, snapshot, meta }) 也不能泄漏
  const hostArg = { ...makeSnapshot(), snapshot: makeSnapshot(), meta: { baseUrl: REAL_BASE } }
  const hostMd = renderRecordMd(hostArg, { baseUrl: REAL_BASE })
  assert.ok(hostMd.includes('<base>'))
  assert.ok(hostMd.includes('<token>'))
  assert.equal(/https?:\/\//.test(hostMd), false, '宿主路径不应泄漏隧道 URL')
  assert.equal(hostMd.includes('trycloudflare'), false)
  assert.equal(hostMd.includes(REAL_TOKEN), false, '不应泄漏口令明文')
})

test('结束态：状态与「轮到」显示为人话', () => {
  const ended = renderRecordMd(makeSnapshot({ status: 'red-win' }))
  assert.ok(ended.includes('- 状态：红方胜 · 轮到：已结束'))

  const blackWin = renderRecordMd(makeSnapshot({ status: 'black-win' }))
  assert.ok(blackWin.includes('- 状态：黑方胜 · 轮到：已结束'))

  const draw = renderRecordMd(makeSnapshot({ status: 'draw' }))
  assert.ok(draw.includes('- 状态：和棋 · 轮到：已结束'))
})

test('尚无着法时表格只有表头，不出现伪造的着法', () => {
  const fresh = renderRecordMd(makeSnapshot({ moves: [], lastMove: null }))
  assert.ok(fresh.includes('| 回合 | 红方 | 黑方 |'))
  assert.equal(/\|\s*1\s*\|\s*[^\s|]/.test(fresh), false, '未走子时不应有着法数据行')
  assert.ok(fresh.includes('- 最近一手：'))
})

test('renderRecordMd 返回非空 Markdown 字符串', () => {
  assert.equal(typeof md, 'string')
  assert.ok(md.length > 200)
  assert.ok(md.trimEnd().endsWith('按 message 修正。'), '结尾应是给 agent 的提示行')
})
