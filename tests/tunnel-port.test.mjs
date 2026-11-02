// 回归：隧道必须使用「HTTP 服务实际绑定的端口」，而不是自己再挑一个口。
// 背景：线上出现过「站点在 61350、隧道指向 5000 → 公网 502」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTunnelManager } from '../src/host/tunnel.mjs'

function makeFakeBinary(dir) {
  const bin = join(dir, 'fake-cloudflared.mjs')
  const argvFile = join(dir, 'argv.json')
  const source = [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)))`,
    "process.stderr.write('INF |  https://fake-port.trycloudflare.com  |\\n')",
    'setInterval(() => {}, 1000)',
    "process.on('SIGTERM', () => process.exit(0))",
  ].join('\n')
  writeFileSync(bin, source, 'utf8')
  return { bin, argvFile }
}

const baseConfig = (bin) => ({
  host: '127.0.0.1',
  port: 5000,
  portRange: [5000, 5050],
  proxy: '',
  binPath: process.execPath,
  binArgs: [bin],
  tunnelTimeoutMs: 8000,
  tunnelStopTimeoutMs: 3000,
  natfrp: {},
  provider: 'cloudflared',
})

test('隧道使用调用方传入的真实端口（不是 config.port / 重新挑口）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xq-tunnel-port-'))
  const { bin, argvFile } = makeFakeBinary(dir)
  const manager = createTunnelManager({ config: baseConfig(bin) })
  try {
    const status = await manager.start('cloudflared', { port: 61350 })
    assert.equal(status.status, 'running')
    assert.equal(status.localPort, 61350, '状态里的 localPort 必须是真实端口')
    const argv = JSON.parse(readFileSync(argvFile, 'utf8'))
    assert.ok(
      argv.includes('http://127.0.0.1:61350'),
      `cloudflared 参数应指向真实端口，实际：${argv.join(' ')}`,
    )
    assert.ok(
      !argv.includes('http://127.0.0.1:5000'),
      '不得回退到 config.port 或重新挑选的端口',
    )
  } finally {
    await manager.stop()
  }
})

test('未传端口时才回退到端口区间挑选', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'xq-tunnel-port-'))
  const { bin, argvFile } = makeFakeBinary(dir)
  const manager = createTunnelManager({ config: baseConfig(bin) })
  try {
    const status = await manager.start('cloudflared')
    assert.equal(status.status, 'running')
    const argv = JSON.parse(readFileSync(argvFile, 'utf8'))
    const target = argv.find((item) => item.startsWith('http://127.0.0.1:'))
    assert.ok(target, '应有 --url 目标')
    const port = Number(target.split(':').pop())
    assert.ok(port >= 5000 && port <= 5050, `回退端口应在 5000-5050，实际 ${port}`)
  } finally {
    await manager.stop()
  }
})
