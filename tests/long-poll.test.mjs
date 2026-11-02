// 动态刷新（长轮询 /api/wait）回归：立即返回、局面变化即返回、超时返回当前态。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRules } from '../src/rules/index.mjs'
import { createGameService } from '../src/host/game.mjs'
import { startServer } from '../src/host/server.mjs'

const rules = getRules('xiangqi')

const tunnel = {
  status: () => ({ provider: 'cloudflared', status: 'stopped', url: null, error: null, localPort: null }),
  async start() {
    return { provider: 'cloudflared', status: 'running', url: 'https://example.trycloudflare.com' }
  },
  async stop() {
    return { provider: 'cloudflared', status: 'stopped', url: null }
  },
}

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'xq-wait-'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>象棋</body></html>', 'utf8')
  const service = createGameService({ rules })
  const created = service.newGame()
  const server = await startServer({ service, tunnel, token: created.token, port: 0, assetsDir: dir })
  return { dir, service, created, server, base: server.url, token: created.token }
}

async function teardown(fixture) {
  await fixture.server.close().catch(() => {})
  await rm(fixture.dir, { recursive: true, force: true })
}

async function getJson(base, path, token) {
  const startedAt = Date.now()
  const res = await fetch(base + path, { headers: { 'x-xiangqi-token': token } })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text), elapsed: Date.now() - startedAt }
}

test('长轮询：since 与当前 rev 不同 → 立即返回最新态（含 legal）', async (t) => {
  const fixture = await makeFixture()
  t.after(() => teardown(fixture))
  const res = await getJson(fixture.base, '/api/wait?since=0', fixture.token)
  assert.equal(res.status, 200)
  assert.equal(res.json.snapshot.rev, 1)
  assert.ok(res.json.legal && typeof res.json.legal === 'object', '应同时返回 legal')
  assert.ok(res.elapsed < 1500, `应快速返回，实际 ${res.elapsed}ms`)
})

test('长轮询：挂起等待，人类走子后立刻返回新局面', async (t) => {
  const fixture = await makeFixture()
  t.after(() => teardown(fixture))
  const current = fixture.service.snapshot()
  const waiting = getJson(fixture.base, `/api/wait?since=${current.rev}&timeout=8000`, fixture.token)
  // 100ms 后确认请求还挂着
  await new Promise((resolve) => setTimeout(resolve, 100))
  let settled = false
  waiting.then(() => {
    settled = true
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(settled, false, '局面没变时请求应挂起')

  const move = await fetch(fixture.base + '/api/move', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xiangqi-token': fixture.token },
    body: JSON.stringify({ from: 'h2', to: 'e2' }),
  })
  assert.equal(move.status, 200)

  const res = await waiting
  assert.equal(res.status, 200)
  assert.equal(res.json.snapshot.rev, current.rev + 1, '应返回走子后的新局面')
  assert.equal(res.json.snapshot.lastMove.iccs, 'h2e2')
  assert.ok(res.json.legal && typeof res.json.legal === 'object', '变化回包也应带 legal')
  assert.ok(res.elapsed < 3000, `走子后应尽快返回，实际 ${res.elapsed}ms`)
})

test('长轮询：超时也回当前态（不挂死连接）', async (t) => {
  const fixture = await makeFixture()
  t.after(() => teardown(fixture))
  const current = fixture.service.snapshot()
  const res = await getJson(fixture.base, `/api/wait?since=${current.rev}&timeout=250`, fixture.token)
  assert.equal(res.status, 200)
  assert.equal(res.json.snapshot.rev, current.rev)
  assert.ok(res.elapsed >= 200 && res.elapsed < 3000, `应在超时附近返回，实际 ${res.elapsed}ms`)
})
