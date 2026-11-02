// HTTP 服务单测（DESIGN §5）：鉴权 401、合法 200、非法 409、restart 换 token、
// 静态白名单与路径穿越、SSE 首帧与 rev 推送、/api/tunnel、preview 免口令。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRules } from '../src/rules/index.mjs'
import { createGameService } from '../src/host/game.mjs'
import { resolveAssetPath, startServer } from '../src/host/server.mjs'

const rules = getRules('xiangqi')

function makeTunnelStub() {
  let state = { provider: 'cloudflared', status: 'stopped', url: null, error: null, localPort: null }
  return {
    status: () => ({ ...state }),
    async start() {
      state = { ...state, status: 'running', url: 'https://example.trycloudflare.com' }
      return { ...state }
    },
    async stop() {
      state = { ...state, status: 'stopped', url: null }
      return { ...state }
    },
  }
}

async function makeFixture({ preview = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'xq-server-'))
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body><h1>象棋</h1></body></html>', 'utf8')
  await writeFile(join(dir, 'app.js'), 'console.log("xq")\n', 'utf8')
  await writeFile(join(dir, 'secret.txt'), 'TOP SECRET', 'utf8')
  const service = createGameService({ rules })
  const created = service.newGame()
  const tunnel = makeTunnelStub()
  const server = await startServer({
    service,
    tunnel,
    token: created.token,
    port: 0,
    assetsDir: dir,
    preview,
  })
  return { dir, service, created, tunnel, server, base: server.url }
}

async function teardown(fixture) {
  await fixture.server.close().catch(() => {})
  await rm(fixture.dir, { recursive: true, force: true })
}

async function call(base, path, { token, method = 'GET', body, json = true } = {}) {
  const headers = {}
  if (token) headers['x-xiangqi-token'] = token
  if (body !== undefined && json) headers['content-type'] = 'application/json'
  const res = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { status: res.status, text, json: parsed, headers: res.headers }
}

function rawGet(base, rawPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const url = new URL(base)
    const req = request(
      { hostname: url.hostname, port: url.port, path: rawPath, method: 'GET' },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () =>
          resolvePromise({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }),
        )
      },
    )
    req.on('error', rejectPromise)
    req.end()
  })
}

test('鉴权：无 token / 错 token 一律 401，且不回显 token', async () => {
  const fixture = await makeFixture()
  try {
    const none = await call(fixture.base, '/api/state')
    assert.equal(none.status, 401)
    assert.equal(none.json.ok, false)
    assert.equal(none.json.code, 'UNAUTHORIZED')

    const wrong = await call(fixture.base, '/api/state', { token: 'wrongwrongwrongwrong' })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.text.includes('wrongwrongwrongwrong'), false)
    assert.equal(wrong.text.includes(fixture.created.token), false)

    const ok = await call(fixture.base, '/api/state', { token: fixture.created.token })
    assert.equal(ok.status, 200)
    assert.equal(ok.json.ok, true)
    assert.equal(ok.json.snapshot.gameId, fixture.created.snapshot.gameId)
    assert.equal(ok.json.legal.h2.includes('e2'), true)
    assert.ok(ok.json.tunnel && ok.json.tunnel.status === 'stopped')
    assert.ok(ok.json.invite.url.includes(`k=${fixture.created.token}`))
  } finally {
    await teardown(fixture)
  }
})

test('POST 缺 content-type 返回 400', async () => {
  const fixture = await makeFixture()
  try {
    const res = await call(fixture.base, '/api/move', {
      token: fixture.created.token,
      method: 'POST',
      body: '{"from":"h2","to":"e2"}',
      json: false,
    })
    assert.equal(res.status, 400)
    assert.equal(res.json.code, 'BAD_REQUEST')
  } finally {
    await teardown(fixture)
  }
})

test('合法走子 200；非法走子 409 带 code 与 message', async () => {
  const fixture = await makeFixture()
  try {
    const legal = await call(fixture.base, '/api/move', {
      token: fixture.created.token,
      method: 'POST',
      body: { from: 'h2', to: 'e2' },
    })
    assert.equal(legal.status, 200)
    assert.equal(legal.json.ok, true)
    assert.equal(legal.json.snapshot.lastMove.iccs, 'h2e2')
    assert.equal(legal.json.snapshot.lastMove.notation, '炮二平五')
    assert.equal(legal.json.snapshot.turn, 'black')

    const illegal = await call(fixture.base, '/api/move', {
      token: fixture.created.token,
      method: 'POST',
      body: { from: 'e4', to: 'e5' },
    })
    assert.equal(illegal.status, 409)
    assert.equal(illegal.json.ok, false)
    assert.equal(illegal.json.code, 'EMPTY_SQUARE')
    assert.ok(typeof illegal.json.message === 'string' && illegal.json.message.length > 0)
    assert.equal(illegal.text.includes(fixture.created.token), false)
  } finally {
    await teardown(fixture)
  }
})

test('POST /api/new 换新 token，旧 token 立刻失效', async () => {
  const fixture = await makeFixture()
  try {
    const res = await call(fixture.base, '/api/new', {
      token: fixture.created.token,
      method: 'POST',
      body: { humanSide: 'red', minutes: 10 },
    })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, true)
    assert.ok(res.json.url.includes('?k='))
    const newToken = new URL(res.json.url).searchParams.get('k')
    assert.match(newToken, /^[a-z0-9]{18}$/)
    assert.notEqual(newToken, fixture.created.token)
    assert.ok(res.headers.get('set-cookie').includes('xq='))
    assert.equal(res.json.snapshot.minutes, 10)

    const oldToken = await call(fixture.base, '/api/state', { token: fixture.created.token })
    assert.equal(oldToken.status, 401)
    const fresh = await call(fixture.base, '/api/state', { token: newToken })
    assert.equal(fresh.status, 200)
  } finally {
    await teardown(fixture)
  }
})

test('GET /：正确 ?k= 种 cookie，错口令 401 极简页；cookie 可用于 /api/*', async () => {
  const fixture = await makeFixture()
  try {
    const bad = await call(fixture.base, '/?k=000000000000000000')
    assert.equal(bad.status, 401)
    assert.ok(bad.text.includes('口令无效'))

    const page = await call(fixture.base, `/?k=${fixture.created.token}`)
    assert.equal(page.status, 200)
    assert.ok(page.text.includes('象棋'))
    const cookie = page.headers.get('set-cookie')
    assert.ok(cookie.includes(`xq=${fixture.created.token}`))
    assert.ok(cookie.includes('HttpOnly'))
    assert.ok(cookie.includes('SameSite=Lax'))
    assert.ok(cookie.includes('Path=/'))

    const viaCookie = await fetch(`${fixture.base}/api/state`, {
      headers: { cookie: `xq=${fixture.created.token}` },
    })
    assert.equal(viaCookie.status, 200)
  } finally {
    await teardown(fixture)
  }
})

test('静态资源：白名单后缀可访问，非白名单与路径穿越被拒', async () => {
  const fixture = await makeFixture()
  try {
    const js = await call(fixture.base, '/assets/app.js')
    assert.equal(js.status, 200)
    assert.ok(js.headers.get('content-type').includes('text/javascript'))

    const notWhitelisted = await call(fixture.base, '/assets/secret.txt')
    assert.equal(notWhitelisted.status, 404)

    const traversal = await rawGet(fixture.base, '/assets/%2e%2e/secret.txt')
    assert.equal(traversal.status, 404)
    assert.equal(traversal.body.includes('TOP SECRET'), false)

    const traversal2 = await rawGet(fixture.base, '/assets/..%2fsecret.txt')
    assert.equal(traversal2.status, 404)

    assert.equal(resolveAssetPath(fixture.dir, '/assets/../secret.txt'), null)
    assert.equal(resolveAssetPath(fixture.dir, '/assets/secret.txt'), null)
    assert.equal(resolveAssetPath(fixture.dir, '/assets/app.js') !== null, true)
    assert.equal(resolveAssetPath(fixture.dir, '/etc/passwd'), null)
  } finally {
    await teardown(fixture)
  }
})

test('SSE：连上先推当前快照，走子后按新 rev 再推', async () => {
  const fixture = await makeFixture()
  const controller = new AbortController()
  try {
    const res = await fetch(`${fixture.base}/api/events?k=${fixture.created.token}`, {
      signal: controller.signal,
    })
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').includes('text/event-stream'))
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const nextEvent = async () => {
      while (!buffer.includes('\n\n')) {
        const { value, done } = await reader.read()
        if (done) throw new Error('SSE 连接已关闭')
        buffer += decoder.decode(value, { stream: true })
      }
      const index = buffer.indexOf('\n\n')
      const chunk = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      return chunk
    }

    const first = await nextEvent()
    assert.ok(first.startsWith('data: '))
    const firstSnapshot = JSON.parse(first.slice('data: '.length))
    assert.equal(firstSnapshot.rev, 1)
    assert.equal(firstSnapshot.turn, 'red')

    const moved = await call(fixture.base, '/api/move', {
      token: fixture.created.token,
      method: 'POST',
      body: { from: 'h2', to: 'e2' },
    })
    assert.equal(moved.status, 200)

    const second = await nextEvent()
    const secondSnapshot = JSON.parse(second.slice('data: '.length))
    assert.equal(secondSnapshot.rev, 2)
    assert.equal(secondSnapshot.lastMove.iccs, 'h2e2')
  } finally {
    controller.abort()
    await teardown(fixture)
  }
})

test('/api/record.md 返回 Markdown 且不含口令', async () => {
  const fixture = await makeFixture()
  try {
    await call(fixture.base, '/api/move', {
      token: fixture.created.token,
      method: 'POST',
      body: { iccs: 'h2e2' },
    })
    const res = await call(fixture.base, '/api/record.md', { token: fixture.created.token })
    assert.equal(res.status, 200)
    assert.ok(res.headers.get('content-type').includes('text/markdown'))
    assert.ok(res.text.includes('# 象棋对局'))
    assert.ok(res.text.includes('炮二平五'))
    assert.ok(res.text.includes('<token>'))
    assert.equal(res.text.includes(fixture.created.token), false)
  } finally {
    await teardown(fixture)
  }
})

test('/api/tunnel：GET 状态、POST start/stop/status、非法 action 400', async () => {
  const fixture = await makeFixture()
  try {
    const initial = await call(fixture.base, '/api/tunnel', { token: fixture.created.token })
    assert.equal(initial.status, 200)
    assert.equal(initial.json.provider, 'cloudflared')
    assert.equal(initial.json.status, 'stopped')
    assert.equal(initial.json.localPort, fixture.server.port)

    const started = await call(fixture.base, '/api/tunnel', {
      token: fixture.created.token,
      method: 'POST',
      body: { action: 'start', provider: 'cloudflared' },
    })
    assert.equal(started.status, 200)
    assert.equal(started.json.ok, true)
    assert.equal(started.json.status, 'running')
    assert.equal(started.json.url, 'https://example.trycloudflare.com')

    const stopped = await call(fixture.base, '/api/tunnel', {
      token: fixture.created.token,
      method: 'POST',
      body: { action: 'stop' },
    })
    assert.equal(stopped.status, 200)
    assert.equal(stopped.json.status, 'stopped')

    const bad = await call(fixture.base, '/api/tunnel', {
      token: fixture.created.token,
      method: 'POST',
      body: { action: 'bogus' },
    })
    assert.equal(bad.status, 400)
  } finally {
    await teardown(fixture)
  }
})

test('preview=true 时免口令访问页面与 API', async () => {
  const fixture = await makeFixture({ preview: true })
  try {
    const page = await call(fixture.base, '/')
    assert.equal(page.status, 200)
    const state = await call(fixture.base, '/api/state')
    assert.equal(state.status, 200)
    assert.equal(state.json.ok, true)
  } finally {
    await teardown(fixture)
  }
})

test('未知路径 404；方法不允许 405', async () => {
  const fixture = await makeFixture()
  try {
    const missing = await call(fixture.base, '/nope', { token: fixture.created.token })
    assert.equal(missing.status, 404)
    const wrongMethod = await call(fixture.base, '/api/state', {
      token: fixture.created.token,
      method: 'POST',
      body: {},
    })
    assert.equal(wrongMethod.status, 405)
  } finally {
    await teardown(fixture)
  }
})
