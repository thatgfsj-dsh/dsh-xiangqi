// 内网穿透管理（DESIGN §6）：pickLocalPort(5000,5050) 真 bind 探测；
// cloudflared quick tunnel（stderr 解析 trycloudflare URL，30s 超时，走系统代理）；
// natfrp（SakuraFrp）：本机没有带 sakura 定制的 frpc，凭据/客户端缺失一律 NOT_CONFIGURED。
//
// 安全：日志一律先脱敏（token / 公网 URL 替换为占位符）；stop() 只终止自己 spawn 的
// 那个子进程（记 pid，Windows 兜底 taskkill /PID <pid> /T /F），绝不按进程名杀。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join, resolve, sep } from 'node:path'
import { REPO_ROOT } from './config.mjs'

const TRYCLOUDFLARE_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const ANY_URL_RE = /https?:\/\/[^\s"'<>]+/i

/** 隧道错误：带 code，便于 HTTP 层与工具层给出人话原因。 */
export class TunnelError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'TunnelError'
    this.code = code
  }
}

/** 端口是否真的可 bind（真扫，不看端口号）。 */
function probePort(port, host) {
  return new Promise((resolvePromise) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', () => resolvePromise(false))
    probe.listen({ port, host, exclusive: true }, () => {
      probe.close(() => resolvePromise(true))
    })
  })
}

/**
 * 从 start 起扫描 [start, end]，返回第一个能 bind 的端口。
 * 本机 5000-5050 里 5040/TCP 等可能已被系统服务占用，必须靠 bind 探测跳过。
 */
export async function pickLocalPort(start = 5000, end = 5050, host = '127.0.0.1') {
  const from = Number.isInteger(Number(start)) ? Number(start) : 5000
  const to = Number.isInteger(Number(end)) ? Number(end) : 5050
  for (let port = from; port <= to; port += 1) {
    // eslint-disable-next-line no-await-in-loop -- 顺序探测，命中即返回
    if (await probePort(port, host)) return port
  }
  throw new TunnelError('NO_FREE_PORT', `${from}-${to} 之间没有空闲端口`)
}

/** 脱敏：token 与公网 URL 一律不落日志。 */
export function redactText(text, { token = null, url = null } = {}) {
  let out = String(text == null ? '' : text)
  if (url) out = out.split(url).join('<tunnel-url>')
  out = out.replace(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi, '<tunnel-url>')
  out = out.replace(/https?:\/\/[^\s"'<>]+/gi, '<tunnel-url>')
  if (token) out = out.split(token).join('<token>')
  // natfrp 的 `token:tunnelId` 形态
  out = out.replace(/\b[a-z0-9]{16,}:[0-9]+\b/gi, '<token>:<tunnelId>')
  return out
}

function findOnPath(names) {
  const pathValue = process.env.PATH || process.env.Path || ''
  const dirs = pathValue.split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const dir of dirs) {
    for (const name of names) {
      for (const extension of extensions) {
        const full = join(dir, `${name}${extension}`)
        if (existsSync(full)) return full
      }
    }
  }
  return null
}

/** 仓库外挂 bin 目录（相对仓库根推导，不在源码里写死本机绝对路径）。 */
function localBinDir() {
  return resolve(REPO_ROOT, '..', 'tunnel', 'bin')
}

function resolveBinary(kind, config) {
  if (kind === 'cloudflared') {
    if (config.binPath) {
      if (existsSync(config.binPath) || !/[\\/]/.test(config.binPath)) return config.binPath
      throw new TunnelError('TUNNEL_BIN_NOT_FOUND', `cloudflared 不存在：${config.binPath}`)
    }
    const onPath = findOnPath(['cloudflared'])
    if (onPath) return onPath
    const local = join(localBinDir(), 'cloudflared.exe')
    if (existsSync(local)) return local
    throw new TunnelError(
      'TUNNEL_BIN_NOT_FOUND',
      '找不到 cloudflared：请把可执行文件放进 PATH，或用 XQ_CLOUDFLARED / config.binPath 指定',
    )
  }
  if (config.natfrp.clientPath) return config.natfrp.clientPath
  const onPath = findOnPath(['frpc'])
  if (onPath) return onPath
  const local = join(localBinDir(), 'frpc.exe')
  if (existsSync(local)) return local
  return null
}

function buildEnv(proxy) {
  const env = { ...process.env }
  if (typeof proxy === 'string' && proxy.trim()) {
    env.HTTPS_PROXY = proxy
    env.HTTP_PROXY = proxy
    env.https_proxy = proxy
    env.http_proxy = proxy
  }
  return env
}

function normalizeProvider(provider) {
  return provider === 'natfrp' ? 'natfrp' : 'cloudflared'
}

/** 按行切分流。 */
function lineReader(onLine) {
  let buffer = ''
  return (chunk) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line) onLine(line)
      index = buffer.indexOf('\n')
    }
  }
}

/** 等子进程退出，超时后升级为强杀（Windows 用 taskkill /PID <自己的 pid> /T /F）。 */
function killChild(child, { timeoutMs = 5000, pid = null } = {}) {
  if (!child) return Promise.resolve()
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolvePromise()
    }
    child.once('exit', finish)
    try {
      child.kill('SIGTERM')
    } catch {
      finish()
      return
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform === 'win32' && pid) {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          })
          killer.once('exit', finish)
          killer.once('error', finish)
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        finish()
      }
      setTimeout(finish, 500).unref?.()
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * 创建隧道管理器。
 * @param {object} options
 * @param {object} [options.config] loadConfig() 的 config（会读 config.port 指向本地服务）
 * @param {(line: string) => void} [options.log] 日志回调（已脱敏）
 */
export function createTunnelManager({ config = {}, log = () => {} } = {}) {
  const timeoutMs = Number(config.tunnelTimeoutMs) > 0 ? Number(config.tunnelTimeoutMs) : 30000
  const stopTimeoutMs =
    Number(config.tunnelStopTimeoutMs) > 0 ? Number(config.tunnelStopTimeoutMs) : 5000
  const listeners = new Set()

  const state = {
    provider: normalizeProvider(config.provider),
    status: 'stopped',
    url: null,
    error: null,
    localPort: Number.isInteger(config.port) ? config.port : null,
    child: null,
    pid: null,
    startedAt: null,
    starting: null,
    stopRequested: false,
  }

  function status() {
    return {
      provider: state.provider,
      status: state.status,
      url: state.url,
      error: state.error,
      localPort: state.localPort,
      pid: state.pid,
      startedAt: state.startedAt,
    }
  }

  function notify() {
    const snapshot = status()
    for (const fn of [...listeners]) {
      try {
        fn(snapshot)
      } catch {
        /* 订阅者异常不影响状态机 */
      }
    }
  }

  function onChange(fn) {
    if (typeof fn !== 'function') throw new TypeError('onChange: 需要函数')
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  function fail(code, message) {
    state.status = 'error'
    state.error = message
    state.url = null
    state.pid = null
    state.child = null
    notify()
    return new TunnelError(code, message)
  }

  async function resolvePort() {
    if (Number.isInteger(config.port) && config.port > 0) return config.port
    const [lo, hi] = Array.isArray(config.portRange) ? config.portRange : [5000, 5050]
    return pickLocalPort(lo, hi, config.host || '127.0.0.1')
  }

  async function spawnAndWait(bin, args, { pattern, provider, port = null }) {
    state.localPort = port ?? (await resolvePort())
    const env = buildEnv(config.proxy)
    log(`[xiangqi] 启动隧道 ${provider}：本地端口 ${state.localPort}`)
    const child = spawn(bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    state.child = child
    state.pid = child.pid ?? null
    state.startedAt = Date.now()

    const onStderr = lineReader((line) => {
      if (pattern.test(line)) return
      if (/(error|err|fail|warn)/i.test(line)) {
        log(`[xiangqi] ${provider}: ${redactText(line, { token: natfrpToken(), url: state.url })}`)
      }
    })
    const onStdout = lineReader(() => {})
    child.stderr?.on('data', onStderr)
    child.stdout?.on('data', onStdout)

    // 找到 URL 之后仍要盯着退出事件，避免状态长期停在 running
    child.once('exit', (code) => {
      if (state.child !== child) return
      state.child = null
      state.pid = null
      if (state.status === 'running') {
        state.status = 'error'
        state.error = `隧道进程已退出（code=${code}）`
        state.url = null
        notify()
      }
    })

    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const finish = (error, url) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.stderr?.removeListener('data', onStderr)
        child.stdout?.removeListener('data', onStdout)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        if (error) rejectPromise(error)
        else resolvePromise(url)
      }
      const scan = (line) => {
        const match = pattern.exec(line)
        if (match) finish(null, match[0])
      }
      child.stderr?.on('data', lineReader(scan))
      child.stdout?.on('data', lineReader(scan))
      const onError = (error) =>
        finish(new TunnelError('TUNNEL_SPAWN_FAILED', `隧道进程启动失败：${error.message}`))
      const onExit = (code) =>
        finish(
          new TunnelError('TUNNEL_EXITED', `隧道进程在给出公网 URL 前退出（code=${code}）`),
        )
      child.once('error', onError)
      child.once('exit', onExit)
      const timer = setTimeout(
        () =>
          finish(
            new TunnelError(
              'TUNNEL_TIMEOUT',
              `${provider} 在 ${timeoutMs}ms 内没有给出公网 URL`,
            ),
          ),
        timeoutMs,
      )
      if (typeof timer.unref === 'function') timer.unref()
    })
  }

  function natfrpToken() {
    return config.natfrp && config.natfrp.token ? config.natfrp.token : null
  }

  async function doStart(provider, options = {}) {
    const explicitPort = Number.isInteger(options.port) && options.port > 0 ? options.port : null
    state.stopRequested = false
    state.status = 'starting'
    state.error = null
    state.url = null
    notify()
    let child = null
    try {
      let url
      if (provider === 'natfrp') {
        const natfrp = config.natfrp || {}
        if (!natfrp.token || !natfrp.tunnelId) {
          throw new TunnelError(
            'NOT_CONFIGURED',
            'natfrp 未配置：缺少访问密钥或隧道 ID（config.natfrp.token / tunnelId）。请改用 cloudflared。',
          )
        }
        const clientPath = resolveBinary('natfrp', config)
        if (!clientPath) {
          throw new TunnelError(
            'NOT_CONFIGURED',
            'natfrp 未配置：找不到 SakuraFrp 定制版 frpc 客户端（config.natfrp.clientPath）。请改用 cloudflared。',
          )
        }
        const template = Array.isArray(natfrp.args) ? natfrp.args : ['-f', '{token}:{tunnelId}']
        const args = [
          ...(Array.isArray(config.binArgs) ? config.binArgs : []),
          ...template.map((item) =>
            String(item).replace('{token}', natfrp.token).replace('{tunnelId}', natfrp.tunnelId),
          ),
        ]
        url = await spawnAndWait(clientPath, args, { pattern: ANY_URL_RE, provider })
      } else {
        const bin = resolveBinary('cloudflared', config)
        // 端口必须与真正在监听的 HTTP 服务一致：优先用调用方传入的实际绑定端口，
        // 避免「隧道指向 5000、站点实际在 61350」这类 502。
        const port = explicitPort ?? (await resolvePort())
        state.localPort = port
        const args = [
          ...(Array.isArray(config.binArgs) ? config.binArgs : []),
          'tunnel',
          '--no-autoupdate',
          '--url',
          `http://127.0.0.1:${port}`,
        ]
        url = await spawnAndWait(bin, args, { pattern: TRYCLOUDFLARE_RE, provider, port })
      }
      child = state.child
      state.status = 'running'
      state.url = url
      state.error = null
      state.pid = child ? child.pid ?? null : state.pid
      log(`[xiangqi] 隧道已就绪：<tunnel-url>（${provider}）`)
      notify()
      return status()
    } catch (error) {
      const running = state.child
      if (running) await killChild(running, { timeoutMs: stopTimeoutMs, pid: state.pid })
      if (state.stopRequested) {
        state.status = 'stopped'
        state.error = null
        notify()
        throw new TunnelError('TUNNEL_STOPPED', '隧道已停止')
      }
      throw fail(error.code || 'TUNNEL_ERROR', error.message || '隧道启动失败')
    }
  }

  async function start(provider, options = {}) {
    const wanted = normalizeProvider(provider || config.provider || 'cloudflared')
    if (state.status === 'running' && state.provider === wanted) return status()
    if (state.starting) {
      await state.starting.catch(() => {})
    }
    if (state.child) await stop()
    state.provider = wanted
    const promise = doStart(wanted, options)
    state.starting = promise
    try {
      return await promise
    } finally {
      if (state.starting === promise) state.starting = null
    }
  }

  async function stop() {
    state.stopRequested = true
    const child = state.child
    const pid = state.pid
    state.child = null
    state.pid = null
    if (child) await killChild(child, { timeoutMs: stopTimeoutMs, pid })
    if (state.starting) await state.starting.catch(() => {})
    state.status = 'stopped'
    state.url = null
    state.error = null
    state.startedAt = null
    log('[xiangqi] 隧道已关闭')
    notify()
    return status()
  }

  return {
    start,
    stop,
    status,
    onChange,
    pickLocalPort: (from, to) => pickLocalPort(from, to, config.host || '127.0.0.1'),
  }
}

export default createTunnelManager
