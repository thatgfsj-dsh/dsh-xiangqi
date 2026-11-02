// HTTP 服务（node:http，零第三方依赖）。契约见 docs/DESIGN.md §5。
//
// - 同源路由：GET /、/assets/*、/api/*；POST /api/{move,new,action,tunnel}。
// - 鉴权：/api/* 需要 x-xiangqi-token 头、?k= 或 cookie xq（三选一）；POST 还要求
//   content-type: application/json。失败 401 {ok:false,code:'UNAUTHORIZED'}，绝不回显口令。
// - GET / 用 ?k= 或 cookie 校验；带正确 ?k= 时种 HttpOnly cookie。
// - /api/state 额外返回 legal 索引（规则层 legalMoves 全量生成，前端只展示）。
// - /api/events：SSE，连上先推当前快照，之后 rev 变化推送，25s 心跳注释行。
// - /assets/*：只服务 assetsDir 下白名单后缀，拒绝 .. 穿越与非法后缀。
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, resolve, sep } from 'node:path'
import { timingSafeEqual } from 'node:crypto'

const ASSET_SUFFIXES = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.png', '.ico'])
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}
const MAX_BODY_BYTES = 64 * 1024
const MAX_SSE_CLIENTS = 64
const SSE_HEARTBEAT_MS = 25000

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

const MINIMAL_401 = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>口令无效 · 象棋</title>
<style>body{font-family:system-ui,sans-serif;background:#1b1b1f;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:22rem;padding:2rem;text-align:center}p{color:#aaa;line-height:1.7}</style>
</head><body><main><h1>口令无效</h1><p>这个邀请链接已失效。请让 agent 重新创建一局，并用新的邀请链接打开。</p></main></body></html>`

/** 对局/服务错误（server 层只需要 code/message/status 三个字段）。 */
function isGameError(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    typeof error.code === 'string' &&
    typeof error.status === 'number'
  )
}

function constantEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length === 0 || b.length === 0) return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function parseCookies(header) {
  const out = {}
  if (typeof header !== 'string' || !header) return out
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) out[key] = value
  }
  return out
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8')
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': payload.length,
    ...extraHeaders,
  })
  res.end(payload)
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8', extraHeaders = {}) {
  const payload = Buffer.from(text, 'utf8')
  res.writeHead(status, {
    ...BASE_HEADERS,
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Content-Length': payload.length,
    ...extraHeaders,
  })
  res.end(payload)
}

function cookieHeader(token) {
  return `xq=${token}; HttpOnly; SameSite=Lax; Path=/`
}

function readBody(req) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        const error = new Error('请求体过大')
        error.code = 'PAYLOAD_TOO_LARGE'
        error.status = 413
        rejectPromise(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => rejectPromise(error))
  })
}

async function readJson(req) {
  const raw = await readBody(req)
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      const error = new Error('请求体必须是 JSON 对象')
      error.code = 'BAD_REQUEST'
      error.status = 400
      throw error
    }
    return parsed
  } catch (error) {
    if (error.code === 'BAD_REQUEST') throw error
    const bad = new Error('请求体不是合法 JSON')
    bad.code = 'BAD_REQUEST'
    bad.status = 400
    throw bad
  }
}

/** 静态资源解析：拒绝 ..、非法后缀、越界路径；返回绝对路径或 null。 */
export function resolveAssetPath(assetsDir, pathname) {
  if (typeof assetsDir !== 'string' || !assetsDir) return null
  let relative = String(pathname || '')
  if (relative.startsWith('/assets/')) relative = relative.slice('/assets/'.length)
  else if (relative.startsWith('/assets')) relative = ''
  else return null
  if (!relative) return null
  let decoded
  try {
    decoded = decodeURIComponent(relative)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const segments = decoded.split(/[\\/]+/).filter(Boolean)
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  const suffix = extname(decoded).toLowerCase()
  if (!ASSET_SUFFIXES.has(suffix)) return null
  const root = resolve(assetsDir)
  const full = resolve(root, ...segments)
  if (full !== root && !full.startsWith(root + sep)) return null
  return full
}

/**
 * 启动 HTTP 服务。
 * @param {object} options
 * @param {object} options.service createGameService() 的返回值
 * @param {object|null} [options.tunnel] createTunnelManager() 的返回值
 * @param {string|null} [options.token] 初始口令（无对局时用于兼容校验）
 * @param {number} [options.port=0] 0 = 由系统分配
 * @param {string} [options.assetsDir] web/ 目录
 * @param {boolean} [options.preview=false] 放开口令（仅本地预览）
 * @param {string} [options.host='127.0.0.1']
 * @param {boolean} [options.unref=false] 不阻止进程退出（DSH --help 冒烟用）
 */
export async function startServer({
  service,
  tunnel = null,
  token = null,
  port = 0,
  assetsDir = null,
  preview = false,
  host = '127.0.0.1',
  unref = false,
} = {}) {
  if (!service) throw new TypeError('startServer: 缺少 service')
  let knownToken = typeof token === 'string' && token ? token : null
  let actualPort = 0
  let closed = false
  const sseClients = new Set()

  const localBaseUrl = () => `http://127.0.0.1:${actualPort}`

  function tunnelStatus() {
    if (!tunnel || typeof tunnel.status !== 'function') {
      return {
        provider: null,
        status: 'unavailable',
        url: null,
        error: '未配置隧道管理器',
        localPort: actualPort,
      }
    }
    try {
      const status = tunnel.status() || {}
      return {
        provider: status.provider ?? null,
        status: status.status || 'stopped',
        url: status.url ?? null,
        error: status.error ?? null,
        localPort: status.localPort ?? actualPort,
      }
    } catch (error) {
      return {
        provider: null,
        status: 'error',
        url: null,
        error: error.message || '隧道状态读取失败',
        localPort: actualPort,
      }
    }
  }

  function currentBaseUrl() {
    const status = tunnelStatus()
    if (status.status === 'running' && status.url) return status.url
    return localBaseUrl()
  }

  function authorize(req, url) {
    if (preview) return true
    const header = req.headers['x-xiangqi-token']
    const candidates = []
    if (typeof header === 'string' && header) candidates.push(header)
    const queryToken = url.searchParams.get('k')
    if (queryToken) candidates.push(queryToken)
    const cookieToken = parseCookies(req.headers.cookie).xq
    if (cookieToken) candidates.push(cookieToken)
    for (const candidate of candidates) {
      if (typeof service.verifyToken === 'function') {
        if (service.verifyToken(candidate)) return true
      } else if (knownToken && constantEqual(candidate, knownToken)) {
        return true
      }
    }
    return false
  }

  function requireAuth(req, res, url) {
    if (authorize(req, url)) return true
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '口令无效或已失效' })
    return false
  }

  function requireJson(req, res) {
    const type = req.headers['content-type']
    if (typeof type === 'string' && type.toLowerCase().includes('application/json')) return true
    sendJson(res, 400, {
      ok: false,
      code: 'BAD_REQUEST',
      message: 'POST 请求需要 content-type: application/json',
    })
    return false
  }

  function handleGameError(res, error) {
    if (isGameError(error)) {
      sendJson(res, error.status, { ok: false, code: error.code, message: error.message })
      return
    }
    console.error('[xiangqi] 请求处理失败：', error && error.message ? error.message : error)
    sendJson(res, 500, { ok: false, code: 'INTERNAL', message: '服务器内部错误' })
  }

  function sendPage(res, { setCookie = null } = {}) {
    const file = assetsDir ? resolve(assetsDir, 'index.html') : null
    if (!file) {
      sendText(res, 503, 'web/ 前端尚未就绪：缺少 index.html', 'text/plain; charset=utf-8')
      return
    }
    readFile(file)
      .then((buffer) => {
        const headers = {
          ...BASE_HEADERS,
          'Content-Type': CONTENT_TYPES['.html'],
          'Cache-Control': 'no-store',
        }
        if (setCookie) headers['Set-Cookie'] = setCookie
        res.writeHead(200, headers)
        res.end(buffer)
      })
      .catch(() => {
        sendText(res, 503, 'web/ 前端尚未就绪：index.html 不可读', 'text/plain; charset=utf-8')
      })
  }

  async function handleAsset(req, res, pathname) {
    const file = resolveAssetPath(assetsDir, pathname)
    if (!file) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '资源不存在' })
      return
    }
    try {
      const buffer = await readFile(file)
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': CONTENT_TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Length': buffer.length,
      })
      res.end(buffer)
    } catch {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '资源不存在' })
    }
  }

  function sendSse(res, payload) {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  function handleEvents(req, res) {
    if (sseClients.size >= MAX_SSE_CLIENTS) {
      sendJson(res, 503, { ok: false, code: 'TOO_MANY_CLIENTS', message: 'SSE 连接过多' })
      return
    }
    res.writeHead(200, {
      ...BASE_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()
    const client = { res, lastKey: '', tokenAtConnect: knownToken }
    sseClients.add(client)
    try {
      const snapshot = service.snapshot()
      client.lastKey = `${snapshot.gameId}:${snapshot.rev}`
      sendSse(res, snapshot)
    } catch (error) {
      sendSse(res, {
        ok: false,
        code: isGameError(error) ? error.code : 'INTERNAL',
        message: isGameError(error) ? error.message : '读取局面失败',
      })
    }
    const cleanup = () => {
      sseClients.delete(client)
      try {
        res.end()
      } catch {
        /* 已断开 */
      }
    }
    req.on('close', cleanup)
    req.on('error', cleanup)
  }

  const unsubscribe = service.subscribe((snapshot) => {
    for (const client of [...sseClients]) {
      // 口令轮换后旧连接立即失效（与 DESIGN「旧 token 立即失效」一致）
      if (knownToken && client.tokenAtConnect !== knownToken) {
        sseClients.delete(client)
        try {
          client.res.end()
        } catch {
          /* 已断开 */
        }
        continue
      }
      const key = `${snapshot.gameId}:${snapshot.rev}`
      if (key === client.lastKey) continue
      client.lastKey = key
      try {
        sendSse(client.res, snapshot)
      } catch {
        sseClients.delete(client)
      }
    }
  })

  const heartbeat = setInterval(() => {
    for (const client of [...sseClients]) {
      try {
        client.res.write(': ping\n\n')
      } catch {
        sseClients.delete(client)
      }
    }
  }, SSE_HEARTBEAT_MS)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()

  async function handleRequest(req, res) {
    let url
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
    } catch {
      sendJson(res, 400, { ok: false, code: 'BAD_REQUEST', message: '非法请求 URL' })
      return
    }
    const pathname = url.pathname
    const method = req.method || 'GET'

    // --- 页面 ---
    if (pathname === '/' || pathname === '/index.html') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 GET' })
        return
      }
      const queryToken = url.searchParams.get('k')
      const cookieToken = parseCookies(req.headers.cookie).xq
      let valid = preview
      let setCookie = null
      if (typeof service.verifyToken === 'function') {
        if (queryToken && service.verifyToken(queryToken)) {
          valid = true
          setCookie = cookieHeader(queryToken)
        } else if (cookieToken && service.verifyToken(cookieToken)) {
          valid = true
        }
      } else if (knownToken) {
        if (queryToken && constantEqual(queryToken, knownToken)) {
          valid = true
          setCookie = cookieHeader(queryToken)
        } else if (cookieToken && constantEqual(cookieToken, knownToken)) {
          valid = true
        }
      }
      if (!valid) {
        sendText(res, 401, MINIMAL_401, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' })
        return
      }
      sendPage(res, { setCookie })
      return
    }

    // --- 静态资源 ---
    if (pathname.startsWith('/assets/') || pathname === '/favicon.ico') {
      if (pathname === '/favicon.ico') {
        await handleAsset(req, res, '/assets/favicon.ico')
        return
      }
      await handleAsset(req, res, pathname)
      return
    }

    // --- API ---
    if (!pathname.startsWith('/api/')) {
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '路径不存在' })
      return
    }

    if (!requireAuth(req, res, url)) return

    try {
      if (pathname === '/api/state' && method === 'GET') {
        const snapshot = service.snapshot()
        const legal = typeof service.legalIndex === 'function' ? service.legalIndex() : {}
        const tStatus = tunnelStatus()
        const invite = knownToken
          ? { url: `${currentBaseUrl()}/?k=${knownToken}`, tokenSet: true }
          : { url: null, tokenSet: Boolean(snapshot) }
        sendJson(res, 200, { ok: true, snapshot, tunnel: tStatus, invite, legal })
        return
      }

      if (pathname === '/api/move' && method === 'POST') {
        if (!requireJson(req, res)) return
        const body = await readJson(req)
        const result = service.move(body)
        sendJson(res, 200, { ok: true, snapshot: result.snapshot })
        return
      }

      if (pathname === '/api/new' && method === 'POST') {
        if (!requireJson(req, res)) return
        const body = await readJson(req)
        const humanSide = body.humanSide === 'black' ? 'black' : body.humanSide === 'red' ? 'red' : undefined
        const minutes = Number(body.minutes)
        const options = {}
        if (humanSide) options.humanSide = humanSide
        if (Number.isFinite(minutes) && minutes > 0) options.minutes = Math.min(minutes, 24 * 60)
        const created = service.newGame(options)
        knownToken = created.token
        sendJson(
          res,
          200,
          {
            ok: true,
            snapshot: created.snapshot,
            url: `${currentBaseUrl()}${created.urlPath}`,
          },
          { 'Set-Cookie': cookieHeader(created.token) },
        )
        return
      }

      if (pathname === '/api/action' && method === 'POST') {
        if (!requireJson(req, res)) return
        const body = await readJson(req)
        const result = service.action(body.type)
        const payload = { ok: true, snapshot: result.snapshot }
        const headers = {}
        if (result.token) {
          knownToken = result.token
          payload.url = `${currentBaseUrl()}${result.urlPath}`
          headers['Set-Cookie'] = cookieHeader(result.token)
        }
        sendJson(res, 200, payload, headers)
        return
      }

      if (pathname === '/api/events' && method === 'GET') {
        handleEvents(req, res)
        return
      }

      if (pathname === '/api/record.md' && method === 'GET') {
        const markdown = service.recordMarkdown({ baseUrl: currentBaseUrl() })
        sendText(res, 200, markdown, 'text/markdown; charset=utf-8')
        return
      }

      if (pathname === '/api/tunnel' && method === 'GET') {
        sendJson(res, 200, { ok: true, ...tunnelStatus() })
        return
      }

      if (pathname === '/api/tunnel' && method === 'POST') {
        if (!requireJson(req, res)) return
        const body = await readJson(req)
        const action = String(body.action || 'status')
        if (!tunnel || typeof tunnel.start !== 'function') {
          sendJson(res, 200, {
            ok: false,
            provider: null,
            status: 'unavailable',
            url: null,
            error: '未配置隧道管理器',
            localPort: actualPort,
          })
          return
        }
        try {
          if (action === 'start') {
            await tunnel.start(body.provider, { port: actualPort })
          } else if (action === 'stop') {
            await tunnel.stop()
          } else if (action !== 'status') {
            sendJson(res, 400, {
              ok: false,
              code: 'BAD_REQUEST',
              message: 'action 只支持 start / stop / status',
            })
            return
          }
          const status = tunnelStatus()
          sendJson(res, 200, { ok: status.status === 'running' || action !== 'start', ...status })
        } catch (error) {
          const status = tunnelStatus()
          sendJson(res, 200, {
            ok: false,
            ...status,
            error: (error && error.message) || status.error || '隧道操作失败',
            code: (error && error.code) || status.status || 'TUNNEL_ERROR',
          })
        }
        return
      }

      // 已知路径但方法不对
      const known = new Set([
        '/api/state',
        '/api/move',
        '/api/new',
        '/api/action',
        '/api/events',
        '/api/record.md',
        '/api/tunnel',
      ])
      if (known.has(pathname)) {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '方法不允许' })
        return
      }
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '接口不存在' })
    } catch (error) {
      handleGameError(res, error)
    }
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      handleGameError(res, error)
    })
  })

  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(port, host, () => {
      server.removeListener('error', rejectPromise)
      resolvePromise()
    })
  })

  const address = server.address()
  actualPort = typeof address === 'object' && address ? address.port : port
  if (unref && typeof server.unref === 'function') server.unref()

  return {
    port: actualPort,
    url: localBaseUrl(),
    server,
    /** 宿主层新建/重开对局后把新口令同步给 server（用于 /api/state 的邀请 URL）。 */
    setToken(value) {
      knownToken = typeof value === 'string' && value ? value : knownToken
    },
    close() {
      if (closed) return Promise.resolve()
      closed = true
      clearInterval(heartbeat)
      unsubscribe()
      for (const client of [...sseClients]) {
        try {
          client.res.end()
        } catch {
          /* 忽略 */
        }
      }
      sseClients.clear()
      return new Promise((resolvePromise) => {
        server.close(() => resolvePromise())
      })
    },
  }
}

export default startServer
