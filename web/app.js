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
  state: '/api/state', wait: '/api/wait', move: '/api/move', newGame: '/api/new',
  action: '/api/action', record: '/api/record.md',
}
// 动态刷新：长轮询（服务端挂起最多 25s，局面一变立刻回包）。比 SSE 更抗代理缓冲，
// 公网隧道 / 手机网络下都能稳定收到更新，不需要「先渲染再补拉」的补丁式刷新。
const WATCH_MIN_DELAY = 400
const WATCH_MAX_DELAY = 4000
const LOW_TIME_MS = 60000
const SIDE_LABEL = { red: '红方', black: '黑方' }
const sound = createSoundKit()
const feedback = createFeedback({ sound, showToast, parseFen })
const END_REASON_TEXT = { resign: '认输', timeout: '超时', expired: '超时', checkmate: '将死', stalemate: '困毙', draw: '和棋', forfeit: '判负', abandoned: '中途退出' }
const $ = (id) => document.getElementById(id)
const ui = {
  app: $('app'), stage: $('stage'), board: $('board'), marks: $('layer-marks'), pieces: $('layer-pieces'), turnDot: $('turn-dot'), turnText: $('turn-text'), turnYou: $('turn-you'), timer: $('timer'),
  btnNew: $('btn-new'), btnUndo: $('btn-undo'), btnResign: $('btn-resign'), btnRecord: $('btn-record'), btnSound: $('btn-sound'), recordScroll: $('record-scroll'), recordList: $('record-list'), recordCount: $('record-count'), recordEmpty: $('record-empty'),
  overlay: $('overlay'), overlayTitle: $('overlay-title'), overlayReason: $('overlay-reason'), overlayKicker: $('overlay-kicker'), btnAgain: $('btn-again'), btnOverlayRecord: $('btn-overlay-record'), btnOverlayClose: $('btn-overlay-close'),
  toast: $('toast'), netBanner: $('net-banner'), bootNote: $('boot-note'), boardHint: $('board-hint'),
}
const store = {
  token: readToken(), snapshot: null, legal: Object.create(null),
  board: new Map(), pieceNodes: new Map(), selected: null, busy: false,
  connected: false, unauthorized: false, overlayDismissed: false, moveCount: -1,
  timerBase: null, tickHandle: 0, watchAbort: null, watchTimer: 0, watchDelay: WATCH_MIN_DELAY,
  toastTimer: 0, timeoutProbe: false, animating: false,
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
      signal: options.signal,
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
    clearPicked()
    renderPieces()
    renderMarks()
    renderRecord()
    if (prev !== null) {
      feedback.onSnapshot(prev, snap)
      animateMove(prev, snap)
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
function updateControls() {
  const snap = store.snapshot
  const over = !snap || snap.status !== 'playing'
  ui.btnUndo.disabled = over || store.busy
  ui.btnResign.disabled = over || store.busy
  ui.btnRecord.disabled = !snap || snap.status === 'no-game'
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
  clearPicked()
  store.selected = square
  markPicked(square, true)
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
  markPicked(store.selected, false)
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
    clearPicked()
    if (data.snapshot) applySnapshot(data.snapshot)
    else await loadState()
    renderMarks()
    if (data && typeof data.message === 'string' && data.message) showToast(data.message, 'ok')
  } catch (err) {
    shakePiece(from)
    if (err && err.status === 409) {
      showToast(err.message || '这一步走不了', 'error')
      refreshNow()
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
// ---------- 动态刷新：长轮询 ----------
// 与服务端 /api/wait 配合：请求挂在服务端最多 25s，局面一变立刻返回 {snapshot, legal}。
// 一次响应原子应用（棋盘 + 合法落点 + 棋谱一起换），不做「先渲染再补拉」的补丁式刷新。
function stopWatching() {
  window.clearTimeout(store.watchTimer)
  store.watchTimer = 0
  if (store.watchAbort) {
    try {
      store.watchAbort.abort()
    } catch (err) {
      // 忽略
    }
    store.watchAbort = null
  }
}
function startWatching() {
  if (store.unauthorized) return
  stopWatching()
  const controller = new AbortController()
  store.watchAbort = controller
  store.watchDelay = WATCH_MIN_DELAY
  void watchLoop(controller)
}
async function watchLoop(controller) {
  while (!controller.signal.aborted) {
    const since = store.snapshot && Number.isFinite(store.snapshot.rev) ? store.snapshot.rev : null
    const path = since === null ? API.wait : API.wait + '?since=' + since
    try {
      const data = await api(path, { signal: controller.signal })
      if (controller.signal.aborted) return
      applyState(data)
      setConnected(true)
      store.watchDelay = WATCH_MIN_DELAY
    } catch (err) {
      if (controller.signal.aborted) return
      if (err && err.code === 'UNAUTHORIZED') return
      setConnected(false)
      showBanner('实时连接断开，' + Math.round(store.watchDelay / 1000) + ' 秒后重连…')
      await sleep(store.watchDelay)
      store.watchDelay = Math.min(WATCH_MAX_DELAY, Math.round(store.watchDelay * 1.8))
    }
  }
}
/** 立刻取一次最新状态（走长轮询的「立即返回」分支）。 */
function refreshNow() {
  loadState().catch(() => {})
}
/** 重新开始长轮询（切回前台 / 网络恢复后调用，老的挂起请求先取消）。 */
function restartWatching() {
  if (store.unauthorized) return
  startWatching()
}

// ---------- 落子动画：拿起 → 落下 ----------
/** 目标方格的像素坐标（相对棋盘）。 */
function squarePoint(square) {
  const pos = parseSquare(square)
  if (!pos) return null
  const width = ui.board.clientWidth
  const height = ui.board.clientHeight
  if (!width || !height) return null
  return {
    x: ((VIEW.x + pos.file) / VIEW.w) * width,
    y: ((VIEW.y + (9 - pos.rank)) / VIEW.h) * height,
  }
}
/**
 * 上一手是「从 A 走到 B」时，让 B 点的棋子从 A 点平移过来并轻微落定（FLIP 式动画）。
 * 只在同一局内有上一手时播放；动画结束清理内联样式。
 */
function animateMove(prev, snap) {
  const last = snap && Array.isArray(snap.moves) ? snap.moves[snap.moves.length - 1] : null
  if (!last || !last.from || !last.to) return
  if (prev && prev.gameId && snap.gameId && prev.gameId !== snap.gameId) return
  const toSquare = squareOf(snap.lastMove && snap.lastMove.to)
  const node = toSquare ? store.pieceNodes.get(toSquare) : null
  if (!node || typeof node.animate !== 'function') return
  const from = squarePoint(snapshotToSquare(last.from))
  const to = squarePoint(toSquare)
  if (!from || !to) return
  const dx = Math.round(from.x - to.x)
  const dy = Math.round(from.y - to.y)
  if (dx === 0 && dy === 0) return
  try {
    node.animate(
      [
        {
          transform: 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px)) scale(1.06)',
          filter: 'brightness(1.06)',
          offset: 0,
        },
        { transform: 'translate(-50%, -50%) scale(0.988)', filter: 'brightness(1.02)', offset: 0.82 },
        { transform: 'translate(-50%, -50%) scale(1)', filter: 'brightness(1)', offset: 1 },
      ],
      { duration: 190, easing: 'cubic-bezier(0.22, 0.8, 0.3, 1)' },
    )
  } catch (err) {
    // 动画失败不影响棋局
  }
}
function snapshotToSquare(point) {
  if (!point || typeof point.file !== 'number' || typeof point.rank !== 'number') return null
  return squareName({ file: point.file, rank: point.rank })
}
/** 拿起效果：选中的棋子抬高 + 阴影加深（CSS 类控制，配合 transition）。 */
/** 清掉所有棋子的抬起态（换选/落子/重绘时调用，避免旧棋子一直悬浮）。 */
function clearPicked() {
  for (const node of store.pieceNodes.values()) node.classList.remove('is-picked')
}
function markPicked(square, picked) {
  const node = square ? store.pieceNodes.get(squareOf(square)) : null
  if (!node) return
  node.classList.toggle('is-picked', Boolean(picked))
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
    if (document.visibilityState !== 'visible') return
    refreshNow()
    restartWatching()
  })
  window.addEventListener('online', () => {
    refreshNow()
    restartWatching()
  })
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
  updateControls()
  loadState()
    .then(() => {
      startWatching()
    })
    .catch((err) => {
      reportError(err, '读取棋局失败')
      if (!store.unauthorized) startWatching()
    })
}
init()
