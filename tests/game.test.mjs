// 对局服务单测（DESIGN §4）：单局制、18 位口令摘要校验、超时判负、广播、记谱、悔棋。
// 规则层已落地，这里直接用真实规则（src/rules/index.mjs），不另做 stub。
import test from 'node:test'
import assert from 'node:assert/strict'
import { getRules } from '../src/rules/index.mjs'
import { GameError, createGameService, generateToken } from '../src/host/game.mjs'

const rules = getRules('xiangqi')
const TOKEN_RE = /^[a-z0-9]{18}$/

function createService(options = {}) {
  return createGameService({ rules, minutes: 20, ...options })
}

test('newGame 返回 18 位口令、urlPath 与完整快照', () => {
  const service = createService()
  assert.equal(service.hasGame(), false)
  const created = service.newGame()
  assert.match(created.token, TOKEN_RE)
  assert.equal(created.urlPath, `/?k=${created.token}`)
  const snapshot = created.snapshot
  assert.match(snapshot.gameId, /^xq-\d{8}-[0-9a-f]{4}$/)
  assert.equal(snapshot.status, 'playing')
  assert.equal(snapshot.turn, 'red')
  assert.equal(snapshot.rev, 1)
  assert.equal(snapshot.humanSide, 'red')
  assert.equal(snapshot.agentSide, 'black')
  assert.equal(snapshot.startedAt, null)
  assert.equal(snapshot.deadline, null)
  assert.equal(snapshot.remainingMs, 20 * 60000)
  assert.equal(snapshot.ascii.length, 10)
  assert.match(snapshot.fen, / r$/)
  assert.ok(Array.isArray(snapshot.moves) && snapshot.moves.length === 0)
  assert.equal(service.hasGame(), true)
})

test('口令只存摘要：快照/状态/记谱里没有口令明文', () => {
  const service = createService()
  const created = service.newGame()
  const blob = JSON.stringify(created.snapshot) + JSON.stringify(service.status())
  assert.equal(blob.includes(created.token), false)
  assert.equal(service.recordMarkdown().includes(created.token), false)
  assert.equal(service.recordMarkdown().includes('<token>'), true)
})

test('verifyToken 校验当前口令，restart 后旧口令立刻失效', () => {
  const service = createService()
  const first = service.newGame()
  assert.equal(service.verifyToken(first.token), true)
  assert.equal(service.verifyToken('000000000000000000'), false)
  assert.equal(service.verifyToken(''), false)
  const restarted = service.action('restart')
  assert.match(restarted.token, TOKEN_RE)
  assert.notEqual(restarted.token, first.token)
  assert.notEqual(restarted.snapshot.gameId, first.snapshot.gameId)
  assert.equal(service.verifyToken(first.token), false)
  assert.equal(service.verifyToken(restarted.token), true)
})

test('move 接受 {from,to} / {iccs} / {notation} 三种入参', () => {
  const byIccs = createService()
  byIccs.newGame()
  const a = byIccs.move({ iccs: 'h2e2' }).snapshot
  assert.equal(a.lastMove.iccs, 'h2e2')
  assert.equal(a.lastMove.notation, '炮二平五')
  assert.equal(a.turn, 'black')
  assert.equal(a.moves.length, 1)
  assert.ok(a.startedAt !== null && a.deadline !== null)

  const bySquares = createService()
  bySquares.newGame()
  const b = bySquares.move({ from: 'h2', to: 'e2' }).snapshot
  assert.equal(b.lastMove.iccs, 'h2e2')

  const byNotation = createService()
  byNotation.newGame()
  const c = byNotation.move({ notation: '炮二平五' }).snapshot
  assert.equal(c.lastMove.iccs, 'h2e2')
  assert.equal(c.moves[0].color, 'red')
})

test('非法走子抛 GameError（code/message/status），状态不变', () => {
  const service = createService()
  service.newGame()
  const before = service.snapshot().rev
  assert.throws(
    () => service.move({ from: 'e4', to: 'e5' }),
    (error) => {
      assert.ok(error instanceof GameError)
      assert.equal(error.code, 'EMPTY_SQUARE')
      assert.equal(error.status, 409)
      assert.ok(error.message.length > 0)
      return true
    },
  )
  assert.equal(service.snapshot().rev, before)
  assert.equal(service.snapshot().moves.length, 0)
})

test('轮次校验：不是自己走时 NOT_YOUR_PIECE', () => {
  const service = createService()
  service.newGame()
  service.move({ iccs: 'h2e2' })
  assert.throws(
    () => service.move({ from: 'a0', to: 'a1' }),
    (error) => error.code === 'NOT_YOUR_PIECE',
  )
})

test('20 分钟全局限时：第一手才开始计时，超时方判负', () => {
  let now = 1_700_000_000_000
  const service = createService({ now: () => now })
  service.newGame()
  // 还没落子：时间流逝不判负
  now += 60 * 60000
  assert.equal(service.snapshot().status, 'playing')
  // 第一手开始计时
  service.move({ iccs: 'h2e2' })
  assert.equal(service.snapshot().startedAt, now)
  assert.equal(service.snapshot().deadline, now + 20 * 60000)
  now += 20 * 60000 + 1
  const timedOut = service.snapshot()
  assert.equal(timedOut.status, 'red-win') // 轮到黑方 → 黑方超时负
  assert.equal(timedOut.endReason, 'timeout')
  assert.equal(timedOut.remainingMs, 0)
  assert.throws(() => service.move({ iccs: 'b9c7' }), (error) => error.code === 'GAME_OVER')
})

test('subscribe 广播每次变化，取消订阅后不再收到', () => {
  const service = createService()
  service.newGame()
  const seen = []
  const unsubscribe = service.subscribe((snapshot) => seen.push(snapshot.rev))
  service.move({ iccs: 'h2e2' })
  service.action('undo')
  assert.deepEqual(seen, [2, 3])
  unsubscribe()
  service.move({ iccs: 'h2e2' })
  assert.deepEqual(seen, [2, 3])
})

test('undo / resign / draw 的状态迁移', () => {
  const service = createService()
  service.newGame()
  service.move({ iccs: 'h2e2' })
  const undone = service.action('undo').snapshot
  assert.equal(undone.moves.length, 0)
  assert.equal(undone.turn, 'red')
  assert.equal(undone.startedAt, null)
  assert.equal(undone.fen, rules.toFen(rules.initialBoard()))
  assert.throws(() => service.action('undo'), (error) => error.code === 'NO_MOVES')

  const resign = createService()
  resign.newGame()
  const resigned = resign.action('resign').snapshot
  assert.equal(resigned.status, 'black-win')
  assert.equal(resigned.endReason, 'resign')

  const draw = createService()
  draw.newGame()
  const drawn = draw.action('draw').snapshot
  assert.equal(drawn.status, 'draw')
  assert.equal(drawn.endReason, 'draw')
  assert.throws(() => draw.action('draw'), (error) => error.code === 'GAME_OVER')
  assert.throws(() => service.action('nope'), (error) => error.code === 'BAD_REQUEST')
})

test('legalIndex 由规则层全量生成，结束后为空', () => {
  const service = createService()
  service.newGame()
  const index = service.legalIndex()
  const total = Object.values(index).reduce((sum, list) => sum + list.length, 0)
  assert.equal(total, 44) // 中国象棋初始局面红方 44 步
  assert.ok(index.h2.includes('e2'))
  service.action('resign')
  assert.deepEqual(service.legalIndex(), {})
})

test('recordMarkdown 输出 DESIGN §8 格式并落 <token> 占位', () => {
  const service = createService()
  const created = service.newGame()
  service.move({ iccs: 'h2e2' })
  const markdown = service.recordMarkdown({ baseUrl: 'http://127.0.0.1:5001' })
  assert.match(markdown, /^# 象棋对局 /)
  assert.ok(markdown.includes(created.snapshot.gameId))
  assert.ok(markdown.includes('## 棋盘'))
  assert.ok(markdown.includes('## 着法'))
  assert.ok(markdown.includes('炮二平五'))
  assert.ok(markdown.includes('x-xiangqi-token: <token>'))
  assert.ok(markdown.includes('http://127.0.0.1:5001/api/state'))
  assert.equal(markdown.includes(created.token), false)
})

test('无对局时 snapshot 抛 410，status 不抛错', () => {
  const service = createService()
  assert.throws(
    () => service.snapshot(),
    (error) => error.code === 'NO_GAME' && error.status === 410,
  )
  const status = service.status()
  assert.equal(status.gameId, null)
  assert.equal(status.tokenSet, false)
  assert.equal(service.hasGame(), false)
})

test('generateToken 生成 18 位 [a-z0-9] 且高概率不重复', () => {
  const tokens = new Set()
  for (let i = 0; i < 200; i += 1) {
    const token = generateToken()
    assert.match(token, TOKEN_RE)
    tokens.add(token)
  }
  assert.equal(tokens.size, 200)
})

test('humanSide=black 时 agent 执红，resign 判红方胜', () => {
  const service = createService()
  const created = service.newGame({ humanSide: 'black', minutes: 5 })
  assert.equal(created.snapshot.humanSide, 'black')
  assert.equal(created.snapshot.agentSide, 'red')
  assert.equal(created.snapshot.minutes, 5)
  const resigned = service.action('resign').snapshot
  assert.equal(resigned.status, 'red-win')
})
