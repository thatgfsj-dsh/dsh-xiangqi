// 假隧道二进制：用 node 直接运行本文件来模拟 cloudflared / frpc 的输出。
// 用法（由 tests/tunnel.test.mjs 通过 config.binPath + config.binArgs 注入）：
//   FAKE_PID_FILE=... FAKE_URL=... FAKE_NO_URL=1 FAKE_EXIT_AFTER_MS=100 node fake-tunnel.mjs <args>
import { writeFileSync } from 'node:fs'

const pidFile = process.env.FAKE_PID_FILE
if (pidFile) writeFileSync(pidFile, String(process.pid), 'utf8')

const url = process.env.FAKE_URL || 'https://fake-tunnel.trycloudflare.com'

if (process.env.FAKE_NO_URL !== '1') {
  process.stderr.write('2026-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...\n')
  process.stderr.write('2026-01-01T00:00:01Z INF +--------------------------------------------+\n')
  process.stderr.write(`2026-01-01T00:00:02Z INF |  ${url}  |\n`)
}

if (process.env.FAKE_EXIT_AFTER_MS) {
  setTimeout(() => process.exit(0), Number(process.env.FAKE_EXIT_AFTER_MS))
} else {
  const timer = setInterval(() => {}, 1000)
  const bye = () => {
    clearInterval(timer)
    process.exit(0)
  }
  process.on('SIGTERM', bye)
  process.on('SIGINT', bye)
}
