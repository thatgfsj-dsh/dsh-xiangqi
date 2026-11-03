// 国际象棋：规则（perft / 易位 / 吃过路兵 / 升变 / 将死）+ 对局服务 + HTTP 长轮询。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as chess from '../src/chess/rules.mjs'
import { createChessService } from '../src/chess/service.mjs'
import { createGameService } from '../src/host/game.mjs'
import { getRules } from '../src/rules/index.mjs'
import { startServer } from '../src/host/server.mjs'

const xiangqiRules = getRules('xiangqi')

function perft(board, depth) {
  if (depth === 0) return 1
  let total = 0
  for (const move of chess.legalMoves(board)) total += perft(chess.applyMove(board, move), depth - 1)
  return total
}

function moveBy(board, iccs) {
  const verdict = chess.validateMove(board, { iccs })
  assert.equal(verdict.ok, true, `着法 ${iccs} 应合法`)
  return verdict.move
}

test('规则：初始局面 20 步，perft(1/2/3) = 20/400/8902', () => {
  const board = chess.initialBoard()
  assert.equal(chess.legalMoves(board).length, 20)
  assert.equal(perft(board, 1), 20)
  assert.equal(perft(board, 2), 400)
  assert.equal(perft(board, 3), 8902)
})

test('规则：王车易位（短易位）与车同步移动', () => {
  const board = chess.fromFen('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1')
  const verdict = chess.validateMove(board, { iccs: 'e1g1' })
  assert.equal(verdict.ok, true)
  const next = chess.applyMove(board, verdict.move)
  assert.equal(chess.at(next, 6, 0).type, 'k')
  assert.equal(chess.at(next, 5, 0).type, 'r')
  assert.equal(chess.at(next, 7, 0), null)
  assert.equal(chess.notation(board, verdict.move), 'O-O')
})

test('规则：吃过路兵', () => {
  const board = chess.fromFen('8/8/8/3pP3/8/8/8/4K2k w - d6 0 2')
  const verdict = chess.validateMove(board, { iccs: 'e5d6' })
  assert.equal(verdict.ok, true)
  const next = chess.applyMove(board, verdict.move)
  assert.equal(chess.at(next, 3, 4), null, '被吃的兵应消失（d5）')
  assert.equal(chess.at(next, 3, 5).type, 'p', '白兵应落在 d6')
  assert.equal(chess.at(next, 3, 5).color, 'white')
})

test('规则：兵升变（默认后，可指定车/象/马）', () => {
  const board = chess.fromFen('8/4P3/8/8/8/8/8/4K2k w - - 0 1')
  const queen = chess.validateMove(board, { iccs: 'e7e8q' })
  assert.equal(queen.ok, true)
  assert.equal(chess.applyMove(board, queen.move).cells[60].type, 'q')
  const knight = chess.validateMove(board, { iccs: 'e7e8n' })
  assert.equal(knight.ok, true)
  assert.equal(chess.applyMove(board, knight.move).cells[60].type, 'n')
})

test('规则：将死（愚人杀）与 SAN 后缀', () => {
  let board = chess.initialBoard()
  const sequence = ['f2f3', 'e7e5', 'g2g4']
  for (const iccs of sequence) board = chess.applyMove(board, moveBy(board, iccs))
  const mate = chess.validateMove(board, { san: 'Qh4#' })
  assert.equal(mate.ok, true, 'Qh4# 应可识别')
  const next = chess.applyMove(board, mate.move)
  const result = chess.statusOf(next)
  assert.equal(result.status, 'black-win')
  assert.equal(result.reason, 'checkmate')
  assert.equal(chess.notation(board, mate.move), 'Qh4#')
})

test('规则：逼和（stalemate）判和棋', () => {
  const board = chess.fromFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')
  const result = chess.statusOf(board)
  assert.equal(result.status, 'draw')
  assert.equal(result.reason, 'stalemate')
})

test('服务：新局/走子/SAN/记谱/口令校验', () => {
  const service = createChessService()
  const created = service.newGame()
  assert.match(created.token, /^[a-z0-9]{18}$/)
  assert.equal(created.snapshot.kind, 'chess')
  assert.equal(created.snapshot.turn, 'white')
  assert.equal(service.verifyToken(created.token), true)
  assert.equal(service.verifyToken('nope'), false)
  const after = service.move({ iccs: 'e2e4' })
  assert.equal(after.snapshot.lastMove.san, 'e4')
  assert.equal(after.snapshot.moves.length, 1)
  const md = service.recordMarkdown({ baseUrl: 'http://127.0.0.1:5000' })
  assert.ok(md.includes('# 国际象棋对局'))
  assert.ok(md.includes('| 回合 | 白方 | 黑方 |'))
  assert.ok(!md.includes(created.token), '记谱不能出现口令明文')
})

test('HTTP：/chess 页面、状态、走子、长轮询', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'xq-ch-'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>xq</body></html>', 'utf8')
  await writeFile(join(dir, 'chess.html'), '<!doctype html><html><body>chess</body></html>', 'utf8')
  const service = createGameService({ rules: xiangqiRules })
  const created = service.newGame()
  const ch = createChessService()
  const chCreated = ch.newGame()
  const tunnel = {
    status: () => ({ provider: 'cloudflared', status: 'stopped', url: null, error: null, localPort: null }),
    async start() { return { status: 'running', url: 'https://example.trycloudflare.com' } },
    async stop() { return { status: 'stopped', url: null } },
  }
  const server = await startServer({ service, chess: ch, tunnel, token: created.token, port: 0, assetsDir: dir })
  t.after(async () => {
    await server.close().catch(() => {})
    await rm(dir, { recursive: true, force: true })
  })
  const base = server.url
  const token = chCreated.token

  const page = await fetch(`${base}/chess?k=${token}`)
  assert.equal(page.status, 200)
  assert.ok((await page.text()).includes('chess'))

  const state = await fetch(`${base}/api/chess/state`, { headers: { 'x-xiangqi-token': token } })
  assert.equal(state.status, 200)
  const stateJson = await state.json()
  assert.equal(stateJson.snapshot.gameId, chCreated.snapshot.gameId)
  assert.equal(stateJson.snapshot.cells.length, 64)

  const bad = await fetch(`${base}/api/chess/state`, { headers: { 'x-xiangqi-token': 'x'.repeat(18) } })
  assert.equal(bad.status, 401)

  const currentRev = stateJson.snapshot.rev
  const waiting = fetch(`${base}/api/chess/wait?since=${currentRev}&timeout=5000`, { headers: { 'x-xiangqi-token': token } })
  await new Promise((resolve) => setTimeout(resolve, 120))
  const moved = await fetch(`${base}/api/chess/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xiangqi-token': token },
    body: JSON.stringify({ iccs: 'e2e4' }),
  })
  assert.equal(moved.status, 200)
  const waited = await waiting
  assert.equal(waited.status, 200)
  const waitedJson = await waited.json()
  assert.equal(waitedJson.snapshot.rev, currentRev + 1)
  assert.equal(waitedJson.snapshot.lastMove.san, 'e4')
})
