// 回归：浏览器会话 cookie 必须与「邀请口令」解耦。
// 背景：agent 重新开一局会轮换口令；若页面只靠口令 cookie，换局后立刻 401，
// 表现为「agent 能动，但用户页面不再自动更新」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from '../src/host/server.mjs'
import { createGameService } from '../src/host/game.mjs'
import { getRules } from '../src/rules/index.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ASSETS = join(ROOT, 'web')

function parseSetCookies(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean)
  return raw
}

test('换局轮换口令后，浏览器会话 cookie 仍能拉状态与页面', async (t) => {
  const service = createGameService({ rules: getRules('xiangqi') })
  const first = service.newGame({ humanSide: 'red', minutes: 20 })
  const server = await startServer({
    service,
    tunnel: null,
    token: null,
    port: 0,
    assetsDir: ASSETS,
    preview: false,
    host: '127.0.0.1',
    unref: false,
  })
  t.after(async () => {
    await server.close()
  })
  const base = `http://127.0.0.1:${server.port}`

  // 首次用邀请口令进页面，拿到 Set-Cookie
  const page = await fetch(`${base}/?k=${first.token}`)
  assert.equal(page.status, 200)
  const cookies = parseSetCookies(page)
  assert.ok(cookies.some((line) => line.startsWith('xq=')), '应种口令 cookie')
  const sidCookie = cookies.find((line) => line.startsWith('xq_sid='))
  assert.ok(sidCookie, '应种浏览器会话 cookie')
  const sid = sidCookie.split(';')[0]

  // 只有会话 cookie 也能拉状态
  const stateBefore = await fetch(`${base}/api/state`, { headers: { cookie: sid } })
  assert.equal(stateBefore.status, 200)
  assert.equal((await stateBefore.json()).snapshot.gameId, first.snapshot.gameId)

  // agent 重开一局 → 口令轮换
  const second = service.newGame({ humanSide: 'red', minutes: 20 })
  server.setToken(second.token)
  assert.notEqual(second.token, first.token)

  // 旧口令立即失效
  const oldToken = await fetch(`${base}/api/state`, { headers: { 'x-xiangqi-token': first.token } })
  assert.equal(oldToken.status, 401, '旧 token 应 401')

  // 会话 cookie 仍然可用，且看到的是新局
  const stateAfter = await fetch(`${base}/api/state`, { headers: { cookie: sid } })
  assert.equal(stateAfter.status, 200, '会话 cookie 应不受口令轮换影响')
  const payload = await stateAfter.json()
  assert.equal(payload.snapshot.gameId, second.snapshot.gameId, '应看到新局')

  // 页面同样可用（不刷新 URL 也能继续）
  const pageAfter = await fetch(`${base}/`, { headers: { cookie: sid } })
  assert.equal(pageAfter.status, 200)
})
