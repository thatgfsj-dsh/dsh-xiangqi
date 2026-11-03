// 五子棋：规则（15×15 / 五连 / 占位）+ 对局服务（口令 / 胜负 / 记谱）+ HTTP 长轮询。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as gomoku from '../src/gomoku/rules.mjs'
import { createGomokuService } from '../src/gomoku/service.mjs'
import { createGameService } from '../src/host/game.mjs'
import { getRules } from '../src/rules/index.mjs'
import { startServer } from '../src/host/server.mjs'

const xiangqiRules = getRules('xiangqi')

test('规则：空棋盘 225 点、黑先、坐标往返', () => {
  const board = gomoku.initialBoard()
  assert.equal(board.cells.length, 225)
  assert.equal(board.turn, 'black')
  assert.equal(gomoku.legalMoves(board).length, 225)
  const sq = gomoku.parseSquare('h8')
  assert.deepEqual(sq, { file: 7, rank: 7 })
  assert.equal(gomoku.squareName(sq), 'h8')
  assert.equal(gomoku.squareName({ file: 0, rank: 0 }), 'a1')
  assert.equal(gomoku.squareName({ file: 14, rank: 14 }), 'o15')
})

test('规则：落子后占位、换手、重复点非法', () => {
  const board = gomoku.initialBoard()
  const move = gomoku.validateMove(board, { iccs: 'h8' })
  assert.equal(move.ok, true)
  const next = gomoku.applyMove(board, move.move)
  assert.equal(next.turn, 'white')
  assert.equal(gomoku.at(next, 7, 7), 'black')
  const again = gomoku.validateMove(next, { iccs: 'h8' })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'OCCUPIED')
})

test('规则：横向/纵向/斜向五连都判胜', () => {
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ]) {
    let board = gomoku.initialBoard()
    const startX = 3
    const startY = 7
    for (let i = 0; i < 4; i += 1) {
      const file = startX + dx * i
      const rank = startY + dy * i
      const verdict = gomoku.validateMove(board, { file, rank })
      assert.equal(verdict.ok, true)
      board = gomoku.applyMove(board, verdict.move)
      // 白方随便下一步，保持轮到黑
      const filler = gomoku.legalMoves(board)[0]
      board = gomoku.applyMove(board, filler)
    }
    const file = startX + dx * 4
    const rank = startY + dy * 4
    const verdict = gomoku.validateMove(board, { file, rank })
    assert.equal(verdict.ok, true)
    board = gomoku.applyMove(board, verdict.move)
    assert.equal(gomoku.statusOf(board, verdict.move), 'black-win', `方向 (${dx},${dy}) 应判黑胜`)
  }
})

test('服务：新局口令 18 位、落子、连五判胜、记谱含棋盘与着法', () => {
  const service = createGomokuService()
  const created = service.newGame()
  assert.match(created.token, /^[a-z0-9]{18}$/)
  assert.equal(created.snapshot.kind, 'gomoku')
  assert.equal(created.snapshot.turn, 'black')
  assert.equal(created.snapshot.humanSide, 'black')
  assert.equal(service.verifyToken(created.token), true)
  assert.equal(service.verifyToken('nope'), false)

  // 黑连成横向 5 子，白在别处应付
  const blackMoves = ['a1', 'b1', 'c1', 'd1', 'e1']
  const whiteMoves = ['a2', 'b2', 'c2', 'd2']
  for (let i = 0; i < blackMoves.length; i += 1) {
    service.move({ iccs: blackMoves[i] })
    if (i < whiteMoves.length) service.move({ iccs: whiteMoves[i] })
  }
  const snap = service.snapshot()
  assert.equal(snap.status, 'black-win')
  assert.equal(snap.endReason, 'five')
  const md = service.recordMarkdown({ baseUrl: 'http://127.0.0.1:5000' })
  assert.ok(md.includes('# 五子棋对局'))
  assert.ok(md.includes('| 手 | 黑方 | 白方 |'))
  assert.ok(md.includes('a1'))
  assert.ok(!md.includes(created.token), '记谱里不能出现口令明文')
})

test('HTTP：/gomoku 页面、状态、落子、长轮询', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xq-gm-'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>xq</body></html>', 'utf8')
  await writeFile(join(dir, 'gomoku.html'), '<!doctype html><html><body>gomoku</body></html>', 'utf8')
  const service = createGameService({ rules: xiangqiRules })
  const created = service.newGame()
  const gm = createGomokuService()
  const gmCreated = gm.newGame()
  const tunnel = {
    status: () => ({ provider: 'cloudflared', status: 'stopped', url: null, error: null, localPort: null }),
    async start() { return { status: 'running', url: 'https://example.trycloudflare.com' } },
    async stop() { return { status: 'stopped', url: null } },
  }
  const server = await startServer({ service, gomoku: gm, tunnel, token: created.token, port: 0, assetsDir: dir })
  t.after(async () => {
    await server.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  const base = server.url
  const token = gmCreated.token

  const page = await fetch(`${base}/gomoku?k=${token}`)
  assert.equal(page.status, 200)
  assert.ok((await page.text()).includes('gomoku'))

  const state = await fetch(`${base}/api/gomoku/state`, { headers: { 'x-xiangqi-token': token } })
  assert.equal(state.status, 200)
  const stateJson = await state.json()
  assert.equal(stateJson.snapshot.gameId, gmCreated.snapshot.gameId)
  assert.equal(stateJson.snapshot.cells.length, 225)

  // 错口令 401
  const bad = await fetch(`${base}/api/gomoku/state`, { headers: { 'x-xiangqi-token': 'x'.repeat(18) } })
  assert.equal(bad.status, 401)

  // 长轮询：挂起 → 落子 → 返回新局面
  const currentRev = stateJson.snapshot.rev
  const waiting = fetch(`${base}/api/gomoku/wait?since=${currentRev}&timeout=5000`, { headers: { 'x-xiangqi-token': token } })
  await new Promise((resolve) => setTimeout(resolve, 120))
  const moved = await fetch(`${base}/api/gomoku/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xiangqi-token': token },
    body: JSON.stringify({ iccs: 'h8' }),
  })
  assert.equal(moved.status, 200)
  const waited = await waiting
  assert.equal(waited.status, 200)
  const waitedJson = await waited.json()
  assert.equal(waitedJson.snapshot.rev, currentRev + 1)
  assert.equal(waitedJson.snapshot.lastMove.iccs, 'h8')
})
