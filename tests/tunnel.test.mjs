// 隧道管理单测（DESIGN §6）：端口真扫、cloudflared stderr 解析、超时、只杀自己的 pid、脱敏、natfrp NOT_CONFIGURED。
// 用假二进制脚本（tests/helpers/fake-tunnel.mjs）模拟真实子进程输出与退出。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTunnelManager, pickLocalPort, redactText } from '../src/host/tunnel.mjs'

const FAKE = fileURLToPath(new URL('./helpers/fake-tunnel.mjs', import.meta.url))

function setFakeEnv(values) {
  const saved = {}
  for (const [key, value] of Object.entries(values)) {
    saved[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = String(value)
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function makeManager(overrides = {}) {
  const logs = []
  const config = {
    port: 5099,
    binPath: process.execPath,
    binArgs: [FAKE],
    proxy: '',
    tunnelTimeoutMs: 5000,
    tunnelStopTimeoutMs: 3000,
    ...overrides,
  }
  const manager = createTunnelManager({ config, log: (line) => logs.push(line) })
  return { manager, logs, config }
}

async function listenBusyPort() {
  const server = createServer()
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
  return { server, port: server.address().port }
}

test('pickLocalPort 真 bind 探测：返回 5000-5050 内的空闲口', async () => {
  const port = await pickLocalPort(5000, 5050)
  assert.ok(port >= 5000 && port <= 5050, `期望 5000-5050，实际 ${port}`)
})

test('pickLocalPort 跳过被占端口；整段占满抛 NO_FREE_PORT', async () => {
  const { server, port } = await listenBusyPort()
  try {
    await assert.rejects(
      pickLocalPort(port, port, '127.0.0.1'),
      (error) => error.code === 'NO_FREE_PORT',
    )
    const next = await pickLocalPort(port + 1, port + 50, '127.0.0.1')
    assert.ok(next > port, `应跳过占用端口，实际 ${next}`)
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise))
  }
})

test('redactText 把口令与公网 URL 替换成占位符', () => {
  const text = 'url=https://abc-def.trycloudflare.com token=supersecrettoken123'
  const redacted = redactText(text, { token: 'supersecrettoken123' })
  assert.equal(redacted.includes('abc-def.trycloudflare.com'), false)
  assert.equal(redacted.includes('supersecrettoken123'), false)
  assert.ok(redacted.includes('<tunnel-url>'))
  assert.ok(redacted.includes('<token>'))
})

test('cloudflared provider：从 stderr 解析 URL，running 后可 stop 且进程退出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xq-tunnel-'))
  const pidFile = join(dir, 'pid.txt')
  const restore = setFakeEnv({
    FAKE_PID_FILE: pidFile,
    FAKE_URL: 'https://abc-def.trycloudflare.com',
    FAKE_NO_URL: undefined,
    FAKE_EXIT_AFTER_MS: undefined,
  })
  const { manager, logs } = makeManager()
  try {
    const status = await manager.start('cloudflared')
    assert.equal(status.status, 'running')
    assert.equal(status.provider, 'cloudflared')
    assert.equal(status.url, 'https://abc-def.trycloudflare.com')
    assert.equal(status.localPort, 5099)
    assert.equal(status.error, null)
    // 日志脱敏：不出现完整 URL
    const allLogs = logs.join('\n')
    assert.equal(allLogs.includes('https://abc-def.trycloudflare.com'), false)
    assert.equal(allLogs.includes('abc-def'), false)
    // 记录的是自己 spawn 的 pid
    assert.ok(existsSync(pidFile))
    const pid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(Number.isInteger(pid) && pid > 0)
    const stopped = await manager.stop()
    assert.equal(stopped.status, 'stopped')
    assert.equal(stopped.url, null)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200))
    assert.throws(() => process.kill(pid, 0), '假隧道进程应已退出')
  } finally {
    restore()
    await manager.stop().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cloudflared 30s 超时：无 URL 判 TUNNEL_TIMEOUT 并杀子进程', async () => {
  const restore = setFakeEnv({ FAKE_NO_URL: '1', FAKE_PID_FILE: undefined, FAKE_EXIT_AFTER_MS: undefined })
  const { manager } = makeManager({ tunnelTimeoutMs: 400 })
  try {
    await assert.rejects(
      manager.start('cloudflared'),
      (error) => error.code === 'TUNNEL_TIMEOUT',
    )
    const status = manager.status()
    assert.equal(status.status, 'error')
    assert.ok(status.error && status.error.includes('公网 URL'))
  } finally {
    restore()
    await manager.stop().catch(() => {})
  }
})

test('隧道进程提前退出：TUNNEL_EXITED', async () => {
  const restore = setFakeEnv({ FAKE_NO_URL: '1', FAKE_EXIT_AFTER_MS: 80, FAKE_PID_FILE: undefined })
  const { manager } = makeManager({ tunnelTimeoutMs: 3000 })
  try {
    await assert.rejects(
      manager.start('cloudflared'),
      (error) => error.code === 'TUNNEL_EXITED',
    )
    assert.equal(manager.status().status, 'error')
  } finally {
    restore()
    await manager.stop().catch(() => {})
  }
})

test('natfrp 缺凭据：NOT_CONFIGURED 并提示改用 cloudflared', async () => {
  const { manager } = makeManager({ natfrp: { token: '', tunnelId: '', clientPath: null } })
  try {
    await assert.rejects(
      manager.start('natfrp'),
      (error) => {
        assert.equal(error.code, 'NOT_CONFIGURED')
        assert.ok(error.message.includes('cloudflared'))
        return true
      },
    )
    const status = manager.status()
    assert.equal(status.status, 'error')
    assert.equal(status.provider, 'natfrp')
  } finally {
    await manager.stop().catch(() => {})
  }
})

test('natfrp 配好客户端：URL 从 stdout/stderr 解析且日志不含密钥', async () => {
  const restore = setFakeEnv({
    FAKE_URL: 'https://frp.example.com',
    FAKE_NO_URL: undefined,
    FAKE_EXIT_AFTER_MS: undefined,
    FAKE_PID_FILE: undefined,
  })
  const { manager, logs } = makeManager({
    natfrp: { token: 'natfrp-secret-token-123456', tunnelId: '42', clientPath: process.execPath },
  })
  try {
    const status = await manager.start('natfrp')
    assert.equal(status.status, 'running')
    assert.equal(status.url, 'https://frp.example.com')
    const allLogs = logs.join('\n')
    assert.equal(allLogs.includes('natfrp-secret-token-123456'), false)
    assert.equal(allLogs.includes('frp.example.com'), false)
  } finally {
    restore()
    await manager.stop().catch(() => {})
  }
})

test('status()/onChange 状态机：stopped → starting → running → stopped', async () => {
  const restore = setFakeEnv({
    FAKE_URL: 'https://abc-def.trycloudflare.com',
    FAKE_NO_URL: undefined,
    FAKE_EXIT_AFTER_MS: undefined,
    FAKE_PID_FILE: undefined,
  })
  const { manager } = makeManager()
  const seen = []
  const unsubscribe = manager.onChange((status) => seen.push(status.status))
  try {
    assert.equal(manager.status().status, 'stopped')
    await manager.start('cloudflared')
    await manager.stop()
    assert.ok(seen.includes('starting'))
    assert.ok(seen.includes('running'))
    assert.equal(manager.status().status, 'stopped')
    unsubscribe()
    const before = seen.length
    await manager.start('cloudflared')
    assert.equal(seen.length, before, '取消订阅后不再收到通知')
  } finally {
    restore()
    await manager.stop().catch(() => {})
  }
})
