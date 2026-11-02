// dsh-xiangqi 对弈前端（原生 ES module，无构建、无第三方库、无外链资源）。
// 规则全部由服务端裁决：本文件只负责展示 snapshot / legal、收集点击并发请求。
import {
  BOARD_RATIO,
  VIEW,
  BOARD,
  createPieceElement,
  parseFen,
  parseSquare,
  pointOf,
  squareName,
} from './pieces.js'
import { createSoundKit } from './sound.js'
import { createFeedback } from './feedback.js'
import { createRecordView } from './record-view.js'
const API = {
  state: '/api/state', move: '/api/move', newGame: '/api/new', action: '/api/action',
  events: '/api/events', record: '/api/record.md', tunnel: '/api/tunnel',
}
const SSE_MIN_DELAY = 1000
const SSE_MAX_DELAY = 30000
const LOW_TIME_MS = 60000
const TUNNEL_POLL_MS = 40000
const SIDE_LABEL = { red: '红方', black: '黑方' }
const sound = createSoundKit()
const feedback = createFeedback({ sound, showToast, parseFen })
const TUNNEL_TEXT = { stopped: '穿透未开启', starting: '穿透启动中…', running: '穿透已开启', error: '穿透出错', unavailable: '穿透不可用' }
const END_REASON_TEXT = { resign: '认输', timeout: '超时', expired: '超时', checkmate: '将死', stalemate: '困毙', draw: '和棋', forfeit: '判负', abandoned: '中途退出' }
const $ = (id) => document.getElementById(id)
const ui = {
  app: $('app'), stage: $('stage'), board: $('board'), marks: $('layer-marks'), pieces: $('layer-pieces'), turnDot: $('turn-dot'), turnText: $('turn-text'), turnYou: $('turn-you'), timer: $('timer'),
  btnNew: $('btn-new'), btnUndo: $('btn-undo'), btnResign: $('btn-resign'), btnRecord: $('btn-record'), btnSound: $('btn-sound'), btnTunnel: $('btn-tunnel'), recordScroll: $('record-scroll'), recordList: $('record-list'), recordCount: $('record-count'), recordEmpty: $('record-empty'),
  tunnelDot: $('tunnel-dot'), tunnelStatus: $('tunnel-status'), tunnelProvider: $('tunnel-provider'), tunnelToggle: $('btn-tunnel-toggle'), tunnelUrlRow: $('tunnel-url-row'), tunnelUrl: $('tunnel-url'), btnCopy: $('btn-copy'), tunnelHint: $('tunnel-hint'),
  overlay: $('overlay'), overlayTitle: $('overlay-title'), overlayReason: $('overlay-reason'), overlayKicker: $('overlay-kicker'), btnAgain: $('btn-again'), btnOverlayRecord: $('btn-overlay-record'), btnOverlayClose: $('btn-overlay-close'),
  toast: $('toast'), netBanner: $('net-banner'), bootNote: $('boot-note'), boardHint: $('board-hint'),
}
const store = {
  token: readToken(), snapshot: null, legal: Object.create(null), tunnel: null,
  board: new Map(), pieceNodes: new Map(), selected: null, busy: false, tunnelBusy: false,
  connected: false, unauthorized: false, overlayDismissed: false, legalPending: false, moveCount: -1,
  timerBase: null, tickHandle: 0, eventsAbort: null, retryTimer: 0, retryDelay: SSE_MIN_DELAY,
  pollTimer: 0, stateRefreshTimer: 0, toastTimer: 0, timeoutProbe: false,
}
class ApiError extends Error {
  constructor(info) {
    super(info && info.message ? info.message : '请求失败')
    this.name = 'ApiError'
    this.code = (info && info.code) || 'ERROR'
    this.status = (info && info.status) || 0
    this.network = Boolean(info && info.network)
  }
}
// ---------- 基础工具 ----------
function readToken() {
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('k')
    if (raw && /^[A-Za-z0-9_-]{4,128}$/.test(raw)) {
      // 口令用一次即从地址栏与历史里抹掉，后续靠 HttpOnly cookie / 请求头
      params.delete('k')
      const query = params.toString()
      const clean = window.location.pathname + (query ? '?' + query : '') + window.location.hash
      try { window.history.replaceState({}, '', clean) } catch (err) { /* 忽略 */ }
      return raw
    }
  } catch (err) {
    // 地址栏异常时按无口令处理
  }
  return ''
}
function sideLabel(side) {
  return side === 'black' ? SIDE_LABEL.black : SIDE_LABEL.red
}
function formatClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--:--'
  const total = Math.max(0, Math.ceil(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0')
}
function squareOf(value) {
  if (typeof value === 'string') return parseSquare(value) ? value : null
  if (value && typeof value === 'object') return squareName(value)
  return null
}
const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms))
const HTTP_TEXT = { 400: '请求格式不对，已被服务端拒绝', 401: '口令无效或已过期', 403: '没有权限执行这个操作', 404: '接口不存在（服务端版本可能不匹配）', 409: '这一步现在走不了', 410: '对局已结束', 429: '操作太频繁，请稍后再试' }
function defaultHttpMessage(status) {
  if (HTTP_TEXT[status]) return HTTP_TEXT[status]
  if (status >= 500) return '服务端出错了，请稍后重试'
  return '请求失败（HTTP ' + status + '）'
}
// ---------- 网络层 ----------
async function api(path, options = {}) {
  const method = options.method || 'GET'
  const headers = { accept: 'application/json' }
  if (store.token) headers['x-xiangqi-token'] = store.token
  let payload
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(options.body)
  }
  let res
  try {
    res = await fetch(path, {
      method,
      headers,
      body: payload,
      cache: 'no-store',
      credentials: 'same-origin',
    })
  } catch (err) {
    throw new ApiError({ code: 'NETWORK', message: '网络连接失败，请检查网络后重试', network: true })
  }
  const text = await res.text().catch(() => '')
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch (err) {
      data = null
    }
  }
  if (res.status === 401) {
    markUnauthorized()
    throw new ApiError({ code: 'UNAUTHORIZED', message: '口令无效或已过期', status: 401 })
  }
  if (!res.ok) {
    const message = data && typeof data.message === 'string' && data.message
      ? data.message
      : defaultHttpMessage(res.status)
    throw new ApiError({ code: data && data.code, message, status: res.status })
  }
  return data && typeof data === 'object' ? data : {}
}
async function loadState() {
  const data = await api(API.state)
  applyState(data)
  return data
}
function queueStateRefresh(delay = 120) {
  window.clearTimeout(store.stateRefreshTimer)
  store.stateRefreshTimer = window.setTimeout(() => loadState().catch(() => {}), delay)
}
// ---------- 状态应用 ----------
function normalizeLegal(raw) {
  const out = Object.create(null)
  for (const key of Object.keys(raw)) {
    if (!parseSquare(key)) continue
    const list = raw[key]
    if (!Array.isArray(list)) continue
    const targets = []
    for (const item of list) {
      if (typeof item === 'string' && parseSquare(item) && !targets.includes(item)) targets.push(item)
    }
    out[key] = targets
  }
  return out
}
function applyState(data) {
  if (!data || typeof data !== 'object') return
  if (data.legal && typeof data.legal === 'object') {
    store.legal = normalizeLegal(data.legal)
    store.legalPending = false
  }
  if (data.tunnel && typeof data.tunnel === 'object') {
    store.tunnel = data.tunnel
    renderTunnel()
  }
  if (data.snapshot && typeof data.snapshot === 'object') applySnapshot(data.snapshot)
  else if (data.fen || data.rev !== undefined) applySnapshot(data)
  if (store.selected) renderMarks()
}
function makeTimerBase(snap) {
  let ms = typeof snap.remainingMs === 'number' && Number.isFinite(snap.remainingMs) ? snap.remainingMs : null
  if (ms === null && typeof snap.deadline === 'number' && Number.isFinite(snap.deadline)) {
    ms = Math.max(0, snap.deadline - Date.now())
  }
  const moves = Array.isArray(snap.moves) ? snap.moves : []
  const running = snap.status === 'playing' && moves.length > 0 && ms !== null && ms > 0
  return { ms, at: performance.now(), running }
}
function applySnapshot(snap) {
  if (!snap || typeof snap !== 'object') return
  const prev = store.snapshot
  const prevRev = prev ? prev.rev : null
  const prevFen = prev ? prev.fen : null
  store.snapshot = snap
  store.timerBase = makeTimerBase(snap)
  const changed = prevRev !== snap.rev || prevFen !== snap.fen
  if (changed) {
    const parsed = parseFen(snap.fen)
    store.board = parsed.pieces
    store.selected = null
    renderPieces()
    renderMarks()
    renderRecord()
    if (prev !== null) {
      store.legalPending = true
      queueStateRefresh()
      feedback.onSnapshot(prev, snap)
    }
  }
  renderTurn()
  renderTimer()
  renderOverlay()
  updateControls()
}
// ---------- 渲染 ----------
function currentRemaining() {
  const base = store.timerBase
  if (!base || base.ms === null) return null
  if (!base.running) return base.ms
  return Math.max(0, base.ms - (performance.now() - base.at))
}
function renderTurn() {
  const snap = store.snapshot
  if (!snap) {
    ui.turnText.textContent = '正在连接…'
    ui.turnYou.hidden = true
    ui.turnDot.className = 'dot dot--turn'
    ui.boardHint.textContent = '点自己的棋子 → 点亮点落子'
    return
  }
  if (snap.status !== 'playing') {
    const idle = snap.status === 'no-game'
    ui.turnText.textContent = idle ? '等待开局' : '对局结束'
    ui.turnYou.hidden = true
    ui.turnDot.className = 'dot dot--turn dot--done'
    ui.boardHint.textContent = idle ? '还没有开局：让 agent 开一局，或点「新局」' : '对局已结束'
    return
  }
  const turn = snap.turn === 'black' ? 'black' : 'red'
  const human = snap.humanSide === 'black' ? 'black' : 'red'
  const isYou = turn === human
  ui.turnText.textContent = sideLabel(turn) + '走棋'
  ui.turnYou.hidden = !isYou
  ui.turnDot.className = 'dot dot--turn ' + (turn === 'red' ? 'dot--red' : 'dot--black')
  ui.boardHint.textContent = isYou ? '轮到你了：点自己的棋子 → 点亮点落子' : '等待 agent 落子…'
}
function renderTimer() {
  const remaining = currentRemaining()
  const text = formatClock(remaining)
  if (ui.timer.textContent !== text) ui.timer.textContent = text
  const snap = store.snapshot
  const playing = Boolean(snap && snap.status === 'playing')
  const low = playing && remaining !== null && remaining <= LOW_TIME_MS
  ui.timer.classList.toggle('is-low', low)
  ui.timer.classList.toggle('is-idle', !playing)
  if (remaining !== null) ui.timer.setAttribute('aria-label', '剩余时间 ' + text)
}
function renderPieces() {
  const fragment = document.createDocumentFragment()
  const next = new Map()
  for (const [square, piece] of store.board) {
    let node = store.pieceNodes.get(square)
    if (!node || node.dataset.color !== piece.color || node.dataset.type !== piece.type) {
      node = createPieceElement(piece, square)
    }
    const pt = pointOf(square)
    if (pt) {
      node.style.left = pt.left.toFixed(4) + '%'
      node.style.top = pt.top.toFixed(4) + '%'
    }
    next.set(square, node)
    fragment.appendChild(node)
  }
  store.pieceNodes = next
  ui.pieces.replaceChildren(fragment)
  syncSelectedPiece()
  const snap = store.snapshot
  const last = snap && snap.lastMove
  const to = last && squareOf(last.to)
  const node = to ? store.pieceNodes.get(to) : null
  if (node) {
    node.classList.remove('is-moved')
    void node.offsetWidth
    node.classList.add('is-moved')
    window.setTimeout(() => node.classList.remove('is-moved'), 420)
  }
}
function makeMark(className, square) {
  const node = document.createElement('div')
  node.className = 'mark ' + className
  const pt = pointOf(square)
  if (pt) {
    node.style.left = pt.left.toFixed(4) + '%'
    node.style.top = pt.top.toFixed(4) + '%'
  }
  return node
}
function renderMarks() {
  const fragment = document.createDocumentFragment()
  const snap = store.snapshot
  const last = snap && snap.lastMove
  if (last) {
    for (const value of [last.from, last.to]) {
      const sq = squareOf(value)
      if (sq) fragment.appendChild(makeMark('mark--last', sq))
    }
  }
  if (store.selected) {
    fragment.appendChild(makeMark('mark--selected', store.selected))
    const targets = store.legal[store.selected] || []
    for (const target of targets) {
      fragment.appendChild(makeMark(store.board.has(target) ? 'mark--ring' : 'mark--dot', target))
    }
  }
  ui.marks.replaceChildren(fragment)
  syncSelectedPiece()
}
function syncSelectedPiece() {
  for (const [square, node] of store.pieceNodes) {
    node.classList.toggle('is-selected', square === store.selected)
  }
}
function notationOf(move) {
  if (move && typeof move.notation === 'string' && move.notation) return move.notation
  if (move && typeof move.iccs === 'string' && move.iccs) return move.iccs
  return ''
}
const recordView = createRecordView({ ui, store, notationOf })
function renderRecord() {
  recordView.render()
}
function endReason(snap) {
  const raw = snap.endReason
  if (typeof raw === 'string' && raw.trim()) {
    const key = raw.trim().toLowerCase()
    if (END_REASON_TEXT[key]) return END_REASON_TEXT[key]
    if (/[\u4e00-\u9fff]/.test(raw)) return raw.trim()
  }
  for (const value of [snap.reason, snap.statusText, snap.resultText, snap.result]) {
    if (typeof value === 'string' && value.trim() && /[\u4e00-\u9fff]/.test(value)) return value.trim()
  }
  if (snap.status === 'draw') return '和棋'
  if (snap.status === 'no-game') return ''
  if (typeof snap.remainingMs === 'number' && snap.remainingMs <= 0) return '超时'
  if (snap.status === 'red-win' || snap.status === 'black-win') return '将死'
  return ''
}
function renderOverlay() {
  const snap = store.snapshot
  const over = Boolean(snap && snap.status !== 'playing')
  if (!over) {
    store.overlayDismissed = false
    ui.overlay.hidden = true
    return
  }
  if (store.overlayDismissed) {
    ui.overlay.hidden = true
    return
  }
  const human = snap.humanSide === 'black' ? 'black' : 'red'
  const noGame = snap.status === 'no-game'
  const winner = snap.status === 'red-win' ? 'red' : snap.status === 'black-win' ? 'black' : null
  const reason = endReason(snap)
  ui.overlayKicker.textContent = noGame ? '尚未开局' : '对局结束'
  if (noGame) {
    ui.overlayTitle.textContent = '暂无对局'
    ui.overlayReason.textContent = '在 DSH 里让 agent 用 xiangqi_new_game 开一局，或点「新局」。'
  } else if (!winner) {
    ui.overlayTitle.textContent = '和棋'
    ui.overlayReason.textContent = reason ? '双方' + reason : '双方和棋'
  } else {
    ui.overlayTitle.textContent = winner === human ? '你赢了' : '你输了'
    ui.overlayReason.textContent = sideLabel(winner) + '胜' + (reason ? ' · ' + reason : '')
  }
  ui.overlay.hidden = false
}
function renderTunnel() {
  const tunnel = store.tunnel && typeof store.tunnel === 'object' ? store.tunnel : null
  const status = tunnel && typeof tunnel.status === 'string' ? tunnel.status : 'stopped'
  const dotStatus = ['starting', 'running', 'error', 'unavailable'].includes(status) ? status : 'stopped'
  ui.tunnelDot.className = 'dot dot--tunnel dot--' + dotStatus
  ui.tunnelStatus.textContent = TUNNEL_TEXT[status] || TUNNEL_TEXT.stopped
  const url = tunnel && typeof tunnel.url === 'string' ? tunnel.url : ''
  ui.tunnelUrlRow.hidden = !(status === 'running' && url)
  if (ui.tunnelUrl.textContent !== url) ui.tunnelUrl.textContent = url
  ui.tunnelToggle.textContent = status === 'running' || status === 'starting' ? '关闭' : '开启'
  ui.btnTunnel.setAttribute('aria-expanded', status === 'running' ? 'true' : 'false')
  ui.tunnelProvider.disabled = status === 'starting' || status === 'running'
  if (tunnel && typeof tunnel.provider === 'string' && tunnel.provider !== ui.tunnelProvider.value) {
    if (tunnel.provider === 'cloudflared' || tunnel.provider === 'natfrp') ui.tunnelProvider.value = tunnel.provider
  }
  let hint
  if (status === 'running') hint = '公网地址已就绪：把带口令的完整链接发给对方即可。'
  else if (status === 'starting') hint = '正在启动隧道，拿到公网地址后会自动显示…'
  else if (status === 'error' || status === 'unavailable') hint = tunnel && typeof tunnel.error === 'string' && tunnel.error
    ? tunnel.error
    : '隧道不可用，请查看 DSH 日志，或换一个提供方再试。'
  else hint = '未开启。点「开启」由插件拉起 cloudflared quick tunnel，或在 DSH 里让 agent 执行 xiangqi_tunnel start。'
  if (ui.tunnelHint.textContent !== hint) ui.tunnelHint.textContent = hint
}
function updateControls() {
  const snap = store.snapshot
  const over = !snap || snap.status !== 'playing'
  ui.btnUndo.disabled = over || store.busy
  ui.btnResign.disabled = over || store.busy
  ui.btnRecord.disabled = !snap || snap.status === 'no-game'
  ui.tunnelToggle.disabled = store.tunnelBusy
  ui.btnCopy.disabled = ui.tunnelUrlRow.hidden
  ui.app.setAttribute('aria-busy', store.busy ? 'true' : 'false')
}
// ---------- 提示 / 连接状态 ----------
function showToast(message, kind) {
  if (!message) return
  const type = kind === 'error' || kind === 'ok' ? kind : 'info'
  ui.toast.textContent = message
  ui.toast.className = 'toast toast--' + type + ' is-visible'
  ui.toast.hidden = false
  window.clearTimeout(store.toastTimer)
  store.toastTimer = window.setTimeout(() => {
    ui.toast.classList.remove('is-visible')
    window.setTimeout(() => {
      ui.toast.hidden = true
    }, 240)
  }, type === 'error' ? 4200 : 3000)
}
function showBanner(text, isError) {
  ui.netBanner.textContent = text
  ui.netBanner.classList.toggle('is-error', Boolean(isError))
  ui.netBanner.hidden = false
}
function hideBanner() {
  ui.netBanner.hidden = true
  ui.netBanner.textContent = ''
}
function setConnected(connected) {
  store.connected = connected
  if (store.unauthorized) return
  if (connected) hideBanner()
  else showBanner('实时连接断开，正在自动重连…')
}
function markUnauthorized() {
  if (store.unauthorized) return
  store.unauthorized = true
  stopEvents()
  showBanner('口令无效或已过期：请让 agent 重新生成邀请链接，或刷新带口令的链接。', true)
  ui.turnText.textContent = '口令无效'
  ui.turnYou.hidden = true
  ui.turnDot.className = 'dot dot--turn dot--done'
  ui.boardHint.textContent = '口令无效，无法走子'
}
function reportError(err, fallback) {
  if (err && err.network) {
    showBanner('网络连接失败，恢复后会自动重连…')
    showToast(fallback + '：网络异常', 'error')
    queueStateRefresh(1500)
    return
  }
  if (err && err.code === 'UNAUTHORIZED') return
  const message = err && typeof err.message === 'string' && err.message ? err.message : fallback
  showToast(message, 'error')
}
// ---------- 交互：点选走子 ----------
function squareFromPoint(clientX, clientY) {
  const rect = ui.board.getBoundingClientRect()
  if (!rect.width || !rect.height) return null
  const x = VIEW.x + ((clientX - rect.left) / rect.width) * VIEW.w
  const y = VIEW.y + ((clientY - rect.top) / rect.height) * VIEW.h
  const file = Math.round(x)
  const rank = 9 - Math.round(y)
  if (file < 0 || file > 8 || rank < 0 || rank > 9) return null
  if (Math.abs(x - file) > 0.5 || Math.abs(y - (9 - rank)) > 0.5) return null
  return squareName({ file, rank })
}
function onBoardClick(event) {
  const square = squareFromPoint(event.clientX, event.clientY)
  if (!square) clearSelection()
  else handleSquare(square)
}
function handleSquare(square) {
  const snap = store.snapshot
  if (!snap) return
  if (store.unauthorized) {
    showToast('口令无效，无法操作', 'error')
    return
  }
  if (snap.status !== 'playing') {
    showToast(snap.status === 'no-game' ? '还没有开局，点「新局」或让 agent 开一局' : '对局已结束，点「再来一局」或「新局」', 'info')
    return
  }
  if (store.busy) return
  if (store.legalPending) {
    showToast('正在同步棋局，请稍候…', 'info')
    return
  }
  const human = snap.humanSide === 'black' ? 'black' : 'red'
  const piece = store.board.get(square)
  if (store.selected) {
    const targets = store.legal[store.selected] || []
    if (targets.includes(square)) {
      doMove(store.selected, square)
      return
    }
  }
  if (piece && piece.color === human) {
    if (snap.turn !== human) {
      showToast('还没轮到你走，请等 ' + sideLabel(snap.turn) + ' 落子', 'info')
      return
    }
    const targets = store.legal[square]
    if (!targets || targets.length === 0) {
      showToast('这个棋子现在没有合法走法', 'info')
      return
    }
    selectSquare(square)
    return
  }
  if (piece && piece.color !== human) {
    showToast('这是对方的棋子', 'info')
    return
  }
  if (store.selected) {
    clearSelection()
    return
  }
  if (snap.turn !== human) {
    showToast('现在轮到' + sideLabel(snap.turn) + '走棋', 'info')
    return
  }
  showToast('点自己的棋子，再点绿色圆点落子', 'info')
}
function selectSquare(square) {
  store.selected = square
  renderMarks()
  if (navigator.vibrate) {
    try {
      navigator.vibrate(8)
    } catch (err) {
      // 忽略：部分浏览器禁用震动
    }
  }
}
function clearSelection() {
  if (!store.selected) return
  store.selected = null
  renderMarks()
}
function shakePiece(square) {
  const node = square ? store.pieceNodes.get(square) : null
  if (!node) return
  node.classList.remove('is-shake')
  void node.offsetWidth
  node.classList.add('is-shake')
  window.setTimeout(() => node.classList.remove('is-shake'), 520)
}
async function doMove(from, to) {
  if (store.busy) return
  store.busy = true
  updateControls()
  try {
    const data = await api(API.move, { method: 'POST', body: { from, to } })
    store.selected = null
    if (data.snapshot) applySnapshot(data.snapshot)
    else await loadState()
    renderMarks()
    if (data && typeof data.message === 'string' && data.message) showToast(data.message, 'ok')
  } catch (err) {
    shakePiece(from)
    if (err && err.status === 409) {
      showToast(err.message || '这一步走不了', 'error')
      queueStateRefresh(0)
    } else {
      reportError(err, '走子失败')
    }
  } finally {
    store.busy = false
    updateControls()
  }
}
// ---------- 操作：新局 / 悔棋 / 认输 / 导出 ----------
async function startNewGame(fromOverlay) {
  if (store.busy) return
  const snap = store.snapshot
  const playing = Boolean(snap && snap.status === 'playing')
  if (playing && !fromOverlay) {
    const ok = window.confirm('开始新局会结束当前对局，旧口令立即失效。继续吗？')
    if (!ok) return
  }
  store.busy = true
  updateControls()
  try {
    const body = {}
    if (snap && snap.humanSide) body.humanSide = snap.humanSide
    if (snap && Number(snap.minutes) > 0) body.minutes = Number(snap.minutes)
    const data = await api(API.newGame, { method: 'POST', body })
    const url = data && typeof data.url === 'string' ? data.url : ''
    if (url) {
      // 服务端对该响应已 Set-Cookie；这里只清掉地址栏口令，不把新口令写进历史
      window.location.replace('/')
      return
    }
    store.overlayDismissed = false
    if (data && data.snapshot) applySnapshot(data.snapshot)
    await loadState()
    showToast('新局已开始', 'ok')
  } catch (err) {
    reportError(err, '新局创建失败')
  } finally {
    store.busy = false
    updateControls()
  }
}
async function runAction(type) {
  if (store.busy) return
  if (store.unauthorized) {
    showToast('口令无效，无法操作', 'error')
    return
  }
  if (type === 'resign') {
    const ok = window.confirm('确定认输吗？本局立即结束。')
    if (!ok) return
  }
  store.busy = true
  updateControls()
  try {
    const data = await api(API.action, { method: 'POST', body: { type } })
    if (data.snapshot) applySnapshot(data.snapshot)
    else await loadState()
    if (data && typeof data.message === 'string' && data.message) showToast(data.message, 'ok')
    else if (type === 'undo') showToast('已悔棋', 'ok')
  } catch (err) {
    reportError(err, type === 'undo' ? '悔棋失败' : '操作失败')
  } finally {
    store.busy = false
    updateControls()
  }
}
function recordFileName() {
  const snap = store.snapshot
  const raw = snap && typeof snap.gameId === 'string' ? snap.gameId : 'record'
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '') || 'record'
  return 'xiangqi-' + safe + '.md'
}
async function exportRecord() {
  if (!store.snapshot) {
    showToast('还没有棋谱可导出', 'info')
    return
  }
  const headers = { accept: 'text/markdown' }
  if (store.token) headers['x-xiangqi-token'] = store.token
  let text
  try {
    const res = await fetch(API.record, { headers, cache: 'no-store', credentials: 'same-origin' })
    if (res.status === 401) {
      markUnauthorized()
      return
    }
    if (!res.ok) {
      throw new ApiError({ code: 'HTTP_' + res.status, message: defaultHttpMessage(res.status), status: res.status })
    }
    text = await res.text()
  } catch (err) {
    reportError(err, '导出记谱失败')
    return
  }
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl
  link.download = recordFileName()
  link.rel = 'noopener'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 3000)
  showToast('记谱已开始下载', 'ok')
}
// ---------- 内网穿透 ----------
async function refreshTunnel() {
  try {
    const data = await api(API.tunnel)
    const state = data && data.tunnel && typeof data.tunnel === 'object' ? data.tunnel : data
    if (state && typeof state === 'object') {
      store.tunnel = state
      renderTunnel()
    }
    return state
  } catch (err) {
    return null
  }
}
async function toggleTunnel() {
  if (store.tunnelBusy) return
  if (store.unauthorized) {
    showToast('口令无效，无法操作', 'error')
    return
  }
  const status = store.tunnel && store.tunnel.status
  const action = status === 'running' || status === 'starting' ? 'stop' : 'start'
  store.tunnelBusy = true
  updateControls()
  try {
    const body = { action }
    if (action === 'start' && ui.tunnelProvider.value) body.provider = ui.tunnelProvider.value
    const data = await api(API.tunnel, { method: 'POST', body })
    const state = data && data.tunnel && typeof data.tunnel === 'object' ? data.tunnel : data
    if (state && typeof state === 'object' && (state.status || state.provider)) {
      store.tunnel = state
      renderTunnel()
    } else {
      await refreshTunnel()
    }
    if (action === 'start') await pollTunnel()
    else showToast('穿透已关闭', 'ok')
  } catch (err) {
    reportError(err, action === 'start' ? '开启穿透失败' : '关闭穿透失败')
    await refreshTunnel()
  } finally {
    store.tunnelBusy = false
    updateControls()
  }
}
async function pollTunnel() {
  const startedAt = Date.now()
  while (Date.now() - startedAt < TUNNEL_POLL_MS) {
    await sleep(1200)
    const state = await refreshTunnel()
    if (!state) return
    if (state.status === 'running') {
      showToast('穿透已开启', 'ok')
      return
    }
    if (state.status === 'error') {
      showToast(typeof state.error === 'string' && state.error ? state.error : '隧道启动失败', 'error')
      return
    }
    if (state.status === 'stopped') return
  }
  showToast('隧道仍在启动，可稍后再点「穿透」查看状态', 'info')
}
function legacyCopy(text) {
  try {
    const input = document.createElement('textarea')
    input.value = text
    input.setAttribute('readonly', 'readonly')
    input.style.position = 'fixed'
    input.style.opacity = '0'
    document.body.appendChild(input)
    input.select()
    const ok = document.execCommand('copy')
    input.remove()
    return Boolean(ok)
  } catch (err) {
    return false
  }
}
async function copyTunnelUrl() {
  const url = ui.tunnelUrl.textContent || ''
  if (!url) return
  let ok = false
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(url)
      ok = true
    }
  } catch (err) {
    ok = false
  }
  if (!ok) ok = legacyCopy(url)
  showToast(ok ? '公网地址已复制' : '复制失败，请长按地址手动复制', ok ? 'ok' : 'error')
}
// ---------- SSE：指数退避重连 ----------
function stopEvents() {
  window.clearTimeout(store.retryTimer)
  store.retryTimer = 0
  if (store.eventsAbort) {
    try {
      store.eventsAbort.abort()
    } catch (err) {
      // 忽略
    }
    store.eventsAbort = null
  }
}
function handleEventChunk(chunk) {
  if (!chunk) return
  const dataLines = []
  for (const raw of chunk.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s+/, ''))
  }
  if (dataLines.length === 0) return
  const text = dataLines.join('\n').trim()
  if (!text) return
  let payload
  try {
    payload = JSON.parse(text)
  } catch (err) {
    return
  }
  if (payload && typeof payload === 'object' && payload.snapshot) applyState(payload)
  else if (payload && typeof payload === 'object' && (payload.fen || payload.rev !== undefined)) applySnapshot(payload)
}
async function readEventStream(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const result = await reader.read()
    if (result.done) return
    buffer += decoder.decode(result.value, { stream: true })
    let index = buffer.indexOf('\n\n')
    while (index >= 0) {
      handleEventChunk(buffer.slice(0, index))
      buffer = buffer.slice(index + 2)
      index = buffer.indexOf('\n\n')
    }
    if (buffer.length > 262144) buffer = ''
  }
}
function scheduleReconnect() {
  if (store.unauthorized) return
  const delay = store.retryDelay
  store.retryDelay = Math.min(SSE_MAX_DELAY, Math.round(store.retryDelay * 2))
  showBanner('实时连接断开，' + Math.round(delay / 1000) + ' 秒后重连…')
  window.clearTimeout(store.retryTimer)
  store.retryTimer = window.setTimeout(() => {
    connectEvents()
  }, delay)
}
async function connectEvents() {
  if (store.unauthorized) return
  stopEvents()
  const controller = new AbortController()
  store.eventsAbort = controller
  const headers = { accept: 'text/event-stream' }
  if (store.token) headers['x-xiangqi-token'] = store.token
  try {
    const res = await fetch(API.events, {
      headers,
      cache: 'no-store',
      credentials: 'same-origin',
      signal: controller.signal,
    })
    if (res.status === 401) {
      markUnauthorized()
      return
    }
    if (!res.ok) throw new Error('事件流返回 HTTP ' + res.status)
    if (!res.body) throw new Error('浏览器不支持流式读取')
    store.retryDelay = SSE_MIN_DELAY
    setConnected(true)
    await readEventStream(res.body)
    throw new Error('事件流结束')
  } catch (err) {
    if (controller.signal.aborted) return
    setConnected(false)
    scheduleReconnect()
  }
}
function ensurePolling() {
  if (store.pollTimer) return
  store.pollTimer = window.setInterval(() => {
    if (store.connected || store.unauthorized) return
    loadState().catch(() => {})
  }, 5000)
}
// ---------- 尺寸自适应 ----------
let fitPending = false
function scheduleFit() {
  if (fitPending) return
  fitPending = true
  window.requestAnimationFrame(() => {
    fitPending = false
    fitBoard()
  })
}
function fitBoard() {
  const stage = ui.stage
  const board = ui.board
  if (!stage || !board) return
  const styles = window.getComputedStyle(stage)
  const padX = (parseFloat(styles.paddingLeft) || 0) + (parseFloat(styles.paddingRight) || 0)
  const padY = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0)
  const hint = ui.boardHint
  const hintH = hint && hint.offsetHeight ? hint.offsetHeight + 6 : 0
  const availW = stage.clientWidth - padX
  const availH = stage.clientHeight - padY - hintH
  if (availW <= 0 || availH <= 0) return
  const height = Math.max(200, Math.min(availH, availW / BOARD_RATIO))
  const width = height * BOARD_RATIO
  board.style.width = Math.round(width) + 'px'
  board.style.height = Math.round(height) + 'px'
  board.style.setProperty('--piece-font', Math.round(width * 0.058) + 'px')
}
function watchSize() {
  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(() => scheduleFit())
    observer.observe(ui.stage)
  }
  window.addEventListener('resize', scheduleFit)
  window.addEventListener('orientationchange', () => { window.setTimeout(scheduleFit, 150) })
  scheduleFit()
}
// ---------- 定时器 ----------
function startTicking() {
  window.clearInterval(store.tickHandle)
  store.tickHandle = window.setInterval(() => {
    renderTimer()
    const snap = store.snapshot
    const remaining = currentRemaining()
    if (snap && snap.status === 'playing' && remaining !== null && remaining <= 0 && !store.timeoutProbe) {
      store.timeoutProbe = true
      window.setTimeout(() => {
        store.timeoutProbe = false
        loadState().catch(() => {})
      }, 800)
    }
  }, 250)
}
// ---------- 事件绑定与启动 ----------
function onKeyDown(event) {
  if (event.key !== 'Escape' || ui.overlay.hidden) return
  store.overlayDismissed = true
  ui.overlay.hidden = true
}
function bindEvents() {
  ui.board.addEventListener('click', onBoardClick)
  ui.btnNew.addEventListener('click', () => startNewGame(false))
  ui.btnUndo.addEventListener('click', () => runAction('undo'))
  ui.btnResign.addEventListener('click', () => runAction('resign'))
  ui.btnRecord.addEventListener('click', () => exportRecord())
  ui.btnTunnel.addEventListener('click', () => toggleTunnel())
  ui.tunnelToggle.addEventListener('click', () => toggleTunnel())
  ui.btnCopy.addEventListener('click', () => copyTunnelUrl())
  ui.btnAgain.addEventListener('click', () => startNewGame(true))
  ui.btnOverlayRecord.addEventListener('click', () => exportRecord())
  ui.btnOverlayClose.addEventListener('click', () => {
    store.overlayDismissed = true
    ui.overlay.hidden = true
  })
  // 音效需要一次用户手势才能解锁（浏览器自动播放策略）
  const unlockAudio = () => sound.unlock()
  document.addEventListener('pointerdown', unlockAudio, { capture: true, passive: true })
  document.addEventListener('keydown', unlockAudio, { capture: true })
  if (ui.btnSound) {
    ui.btnSound.addEventListener('click', () => {
      sound.toggle()
      feedback.renderSoundButton(ui.btnSound)
      if (sound.enabled) sound.playMove({ side: 'human' })
    })
  }
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { loadState().catch(() => {}); if (!store.connected) connectEvents() }
  })
  window.addEventListener('online', () => { loadState().catch(() => {}); connectEvents() })
  window.addEventListener('offline', () => showBanner('网络已断开，恢复后会自动重连…'))
}
function init() {
  if (ui.bootNote) ui.bootNote.remove()
  bindEvents()
  feedback.renderSoundButton(ui.btnSound)
  startTicking()
  watchSize()
  renderTurn()
  renderTimer()
  renderTunnel()
  updateControls()
  ensurePolling()
  loadState()
    .then(() => {
      connectEvents()
    })
    .catch((err) => {
      reportError(err, '读取棋局失败')
      if (!store.unauthorized) connectEvents()
    })
}
init()
