#!/usr/bin/env node
// 不经 DSH 直接起服务（本地开发/联调用）。
// 用法：
//   node scripts/dev-server.mjs [--port 5000] [--preview] [--minutes 20] [--help]
// 打印 `http://127.0.0.1:<port>/?k=<token>`；--preview 时放开口令，方便前端联调。
import { join, resolve } from 'node:path'
import { REPO_ROOT, loadConfig } from '../src/host/config.mjs'
import { createGameService } from '../src/host/game.mjs'
import { createTunnelManager, pickLocalPort } from '../src/host/tunnel.mjs'
import { startServer } from '../src/host/server.mjs'
import { getRules } from '../src/rules/index.mjs'

function parseArgs(argv) {
  const options = { port: null, preview: false, minutes: null, tunnel: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--preview') options.preview = true
    else if (arg === '--tunnel') options.tunnel = true
    else if (arg === '--port') options.port = Number(argv[(i += 1)])
    else if (arg.startsWith('--port=')) options.port = Number(arg.slice('--port='.length))
    else if (arg === '--minutes') options.minutes = Number(argv[(i += 1)])
    else if (arg.startsWith('--minutes=')) options.minutes = Number(arg.slice('--minutes='.length))
    else if (arg === '--assets') options.assetsDir = argv[(i += 1)]
  }
  return options
}

function printHelp() {
  console.log(`dsh-xiangqi 本地开发服务器

用法：node scripts/dev-server.mjs [选项]

  --port <n>      指定端口（默认在 5000-5050 里挑空闲口）
  --preview       放开邀请口令，方便前端联调（仅本机用）
  --minutes <n>   全局限时（分钟，默认 20）
  --tunnel        启动后立刻开 cloudflared 隧道
  --assets <dir>  静态目录（默认仓库 web/）
  -h, --help      显示本帮助
`)
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  printHelp()
  process.exit(0)
}

const { config, source, warnings } = loadConfig()
for (const warning of warnings) console.error(`[xiangqi] ${warning}`)
if (source !== 'none') console.error(`[xiangqi] 配置来源：${source}`)
if (Number.isInteger(args.port) && args.port >= 0) config.port = args.port
if (Number.isFinite(args.minutes) && args.minutes > 0) config.minutes = args.minutes
if (config.token) console.error('[xiangqi] 已启用固定口令（XQ_TOKEN / config.token）')

const assetsDir = args.assetsDir
  ? resolve(process.cwd(), args.assetsDir)
  : join(REPO_ROOT, 'web')

const rules = getRules('xiangqi')
let server = null
let tunnel = null
const publicUrl = () => {
  if (tunnel) {
    const status = tunnel.status()
    if (status.status === 'running' && status.url) return status.url
  }
  return server ? server.url : null
}

const service = createGameService({
  rules,
  minutes: config.minutes,
  runtime: () => ({
    port: server ? server.port : null,
    url: publicUrl() || `http://127.0.0.1:${config.port || 5000}`,
    tunnel: tunnel ? tunnel.status() : null,
  }),
})

async function main() {
  const [lo, hi] = config.portRange
  const port = Number.isInteger(config.port) ? config.port : await pickLocalPort(lo, hi, config.host)
  config.port = port
  tunnel = createTunnelManager({
    config,
    log: (line) => console.error(line),
  })
  // 先建局再起服务：这样 server 知道当前口令，/api/state 的邀请 URL 才完整。
  const created = service.newGame({
    humanSide: 'red',
    minutes: config.minutes,
    token: config.token || undefined,
  })
  server = await startServer({
    service,
    tunnel,
    token: created.token,
    port,
    assetsDir,
    preview: args.preview,
    host: config.host,
  })
  const invite = `${server.url}${created.urlPath}`

  console.log('')
  console.log('  象棋对弈站点已启动')
  console.log('  ────────────────────────────────')
  console.log(`  邀请地址：${invite}`)
  if (args.preview) console.log(`  预览地址（免口令）：${server.url}/`)
  console.log(`  静态目录：${assetsDir}`)
  console.log(`  对局编号：${created.snapshot.gameId} · 限时 ${config.minutes} 分钟 · 红先`)
  console.log('  ────────────────────────────────')
  console.log('  Ctrl+C 退出')
  console.log('')

  if (args.tunnel) {
    try {
      const status = await tunnel.start()
      console.log(`  公网地址：${status.url}`)
    } catch (error) {
      console.error(`  [隧道] 启动失败（${error.code || 'ERROR'}）：${error.message}`)
    }
  }
}

let closing = false
async function shutdown(code = 0) {
  if (closing) return
  closing = true
  console.log('\n[xiangqi] 正在关闭…')
  try {
    if (tunnel) await tunnel.stop()
  } catch {
    /* 忽略关闭错误 */
  }
  try {
    if (server) await server.close()
  } catch {
    /* 忽略关闭错误 */
  }
  process.exit(code)
}

process.on('SIGINT', () => {
  void shutdown(0)
})
process.on('SIGTERM', () => {
  void shutdown(0)
})

main().catch((error) => {
  console.error(`[xiangqi] 启动失败：${error && error.message ? error.message : error}`)
  void shutdown(1)
})
