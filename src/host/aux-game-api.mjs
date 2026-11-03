/**
 * 附加棋种（五子棋 / 国际象棋）的 HTTP 适配层：
 * 把「鉴权、状态载荷、长轮询等待、页面路由、move/new/action/record」这些
 * 与象棋同构的逻辑收在一处，避免 server.mjs 因重复代码膨胀到 1000 行以上。
 *
 * 依赖由 server.mjs 注入（cookie / JSON 收发 / 基础 URL 等）。
 */
export function createAuxGameApi({ kind, service, pageFile, apiPrefix, preview, deps }) {
  const {
    parseCookies,
    constantEqual,
    pageSessionValid,
    sendJson,
    sendText,
    requireJson,
    readJson,
    currentBaseUrl,
    cookieHeader,
    pageSessionCookie,
    handleGameError,
    unauthorizedPage,
  } = deps

  const waiters = new Set()
  let token = typeof service.token === 'string' ? service.token : null

  function authorize(req, url) {
    if (preview) return true
    const candidates = []
    const header = req.headers['x-xiangqi-token']
    if (typeof header === 'string' && header) candidates.push(header)
    const queryToken = url.searchParams.get('k')
    if (queryToken) candidates.push(queryToken)
    const cookieToken = parseCookies(req.headers.cookie).xq
    if (cookieToken) candidates.push(cookieToken)
    for (const candidate of candidates) {
      if (typeof service.verifyToken === 'function' && service.verifyToken(candidate)) return true
      if (token && constantEqual(candidate, token)) return true
    }
    return pageSessionValid(req)
  }

  function requireAuth(req, res, url) {
    if (authorize(req, url)) return true
    sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '口令无效或已失效' })
    return false
  }

  function payload(snapshot) {
    return { ok: true, snapshot: snapshot || service.snapshot() }
  }

  function finishWaiter(waiter, snapshot) {
    if (!waiters.delete(waiter)) return
    if (waiter.timer) clearTimeout(waiter.timer)
    if (typeof waiter.req.removeListener === 'function') {
      waiter.req.removeListener('close', waiter.onClose)
      waiter.req.removeListener('error', waiter.onClose)
    }
    try {
      sendJson(waiter.res, 200, payload(snapshot))
    } catch {
      /* 客户端已断开 */
    }
  }

  function handleWait(req, res, url) {
    let current
    try {
      current = service.snapshot()
    } catch (error) {
      handleGameError(res, error)
      return
    }
    const sinceText = url.searchParams.get('since')
    const sinceRev = sinceText === null ? null : Number(sinceText)
    const timeoutRaw = Number(url.searchParams.get('timeout'))
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 30000) : 25000
    if (sinceRev === null || !Number.isFinite(sinceRev) || current.rev !== sinceRev) {
      sendJson(res, 200, payload(current))
      return
    }
    const waiter = { req, res, gameId: current.gameId, rev: current.rev, timer: null, onClose: null }
    waiter.onClose = () => {
      if (waiters.delete(waiter) && waiter.timer) clearTimeout(waiter.timer)
    }
    req.on('close', waiter.onClose)
    req.on('error', waiter.onClose)
    waiter.timer = setTimeout(() => finishWaiter(waiter, null), timeoutMs)
    if (typeof waiter.timer.unref === 'function') waiter.timer.unref()
    waiters.add(waiter)
  }

  /** 页面路由：`/gomoku`、`/chess`；校验口令或会话 cookie 后发对应 html。 */
  function handlePage(req, res, url, method) {
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '只支持 GET' })
      return
    }
    const queryToken = url.searchParams.get('k')
    const cookieToken = parseCookies(req.headers.cookie).xq
    const tokenValid =
      (queryToken && typeof service.verifyToken === 'function' && service.verifyToken(queryToken)) ||
      (cookieToken && typeof service.verifyToken === 'function' && service.verifyToken(cookieToken))
    const valid = preview || tokenValid || pageSessionValid(req)
    if (!valid) {
      sendText(res, 401, unauthorizedPage, 'text/html; charset=utf-8', { 'Cache-Control': 'no-store' })
      return
    }
    const cookies = [pageSessionCookie(req)]
    if (tokenValid && queryToken) cookies.push(cookieHeader(queryToken))
    deps.sendPage(res, { setCookie: cookies, name: pageFile })
  }

  async function handleApi(req, res, pathname, url, method) {
    if (!requireAuth(req, res, url)) return
    try {
      if (pathname === `${apiPrefix}/state` && method === 'GET') {
        const snapshot = service.snapshot()
        const invite = token ? { url: `${currentBaseUrl()}${pagePath()}?k=${token}`, tokenSet: true } : { url: null, tokenSet: Boolean(snapshot) }
        sendJson(res, 200, { ...payload(snapshot), invite })
        return
      }
      if (pathname === `${apiPrefix}/wait` && method === 'GET') {
        handleWait(req, res, url)
        return
      }
      if (pathname === `${apiPrefix}/move` && method === 'POST') {
        if (!requireJson(req, res)) return
        const body = await readJson(req)
        sendJson(res, 200, payload(service.move(body).snapshot))
        return
      }
      if (pathname === `${apiPrefix}/new` && method === 'POST') {
        if (!requireJson(req, res)) return
        const body = await readJson(req)
        const options = {}
        if (body.humanSide === 'black' || body.humanSide === 'white' || body.humanSide === 'red') options.humanSide = body.humanSide
        const minutes = Number(body.minutes)
        if (Number.isFinite(minutes) && minutes > 0) options.minutes = Math.min(minutes, 24 * 60)
        const created = service.newGame(options)
        token = created.token
        sendJson(
          res,
          200,
          { ...payload(created.snapshot), url: `${currentBaseUrl()}${created.urlPath}` },
          { 'Set-Cookie': [cookieHeader(created.token), pageSessionCookie(req)] },
        )
        return
      }
      if (pathname === `${apiPrefix}/action` && method === 'POST') {
        if (!requireJson(req, res)) return
        const body = await readJson(req)
        const result = service.action(body.type)
        const data = payload(result.snapshot)
        const headers = {}
        if (result.token) {
          token = result.token
          data.url = `${currentBaseUrl()}${result.urlPath}`
          headers['Set-Cookie'] = [cookieHeader(result.token), pageSessionCookie(req)]
        } else {
          headers['Set-Cookie'] = pageSessionCookie(req)
        }
        sendJson(res, 200, data, headers)
        return
      }
      if (pathname === `${apiPrefix}/record.md` && method === 'GET') {
        sendText(res, 200, service.recordMarkdown({ baseUrl: currentBaseUrl() }), 'text/markdown; charset=utf-8')
        return
      }
      sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: '路径不存在' })
    } catch (error) {
      handleGameError(res, error)
    }
  }

  // 订阅局面变化，唤醒长轮询等待者
  if (typeof service.subscribe === 'function') {
    service.subscribe((snapshot) => {
      for (const waiting of [...waiters]) {
        if (snapshot.gameId !== waiting.gameId || snapshot.rev !== waiting.rev) {
          finishWaiter(waiting, snapshot)
        }
      }
    })
  }

  function pagePath() {
    return `/${kind}`
  }

  return {
    get token() {
      return token
    },
    setToken(value) {
      token = typeof value === 'string' && value ? value : token
    },
    handlePage,
    handleApi,
    close() {
      for (const waiting of [...waiters]) {
        if (waiting.timer) clearTimeout(waiting.timer)
        if (typeof waiting.req.removeListener === 'function') {
          waiting.req.removeListener('close', waiting.onClose)
          waiting.req.removeListener('error', waiting.onClose)
        }
        try {
          waiting.res.end()
        } catch {
          /* 忽略 */
        }
      }
      waiters.clear()
    },
  }
}

export default createAuxGameApi
