// 国际象棋前端（原生 ES module，无构建、无外链）。规则全部在服务端，前端只展示 legal 并提交走子。
import { createSoundKit } from './sound.js'

const FILES = 'abcdefgh'
// 统一用实心字形（♚♛♜♝♞♟），白棋靠 CSS 颜色 + 深色描边区分，浅色格上也看得清
const SOLID = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' }
const GLYPH = { white: SOLID, black: SOLID }
const API = {
  state: '/api/chess/state',
  wait: '/api/chess/wait',
  move: '/api/chess/move',
  newGame: '/api/chess/new',
  action: '/api/chess/action',
  record: '/api/chess/record.md',
}
const STATUS_TEXT = { playing: '进行中', 'white-win': '白方胜', 'black-win': '黑方胜', draw: '和棋' }
const END_TEXT = { checkmate: '将死', resign: '认输', timeout: '超时', stalemate: '逼和', 'fifty-move': '50 回合和棋', insufficient: '子力不足和棋', draw: '和棋' }
const LOW_TIME_MS = 60000

const $ = (id) => document.getElementById(id)
const ui = {
  app: $('app'), board: $('board'), turnDot: $('turn-dot'), turnText: $('turn-text'), turnYou: $('turn-you'),
  timer: $('timer'), hint: $('hint'), btnNew: $('btn-new'), btnResign: $('btn-resign'), btnRecord: $('btn-record'),
  btnSound: $('btn-sound'), recordList: $('record-list'), recordCount: $('record-count'), recordEmpty: $('record-empty'),
  overlay: $('overlay'), overlayTitle: $('overlay-title'), overlayReason: $('overlay-reason'),
  btnAgain: $('btn-again'), btnOverlayRecord: $('btn-overlay-record'), btnOverlayClose: $('btn-overlay-close'),
  promo: $('promo'), promoQ: $('promo-q'), promoR: $('promo-r'), promoB: $('promo-b'), promoN: $('promo-n'), promoCancel: $('promo-cancel'),
  toast: $('toast'), bootNote: $('boot-note'),
}
const store = {
  token: readToken(), snapshot: null, squares: [], selected: null, busy: false, overlayDismissed: false,
  unauthorized: false, watchAbort: null, watchDelay: 400, toastTimer: 0, timerBase: null, tickHandle: 0,
  pendingPromotion: null,
}
const sound = createSoundKit()

function readToken() {
  try {
    const params = new URLSearchParams(window.location.search)
    const raw = params.get('k')
    if (raw && /^[A-Za-z0-9_-]{4,128}$/.test(raw)) {
      params.delete('k')
      const query = params.toString()
      window.history.replaceState(null, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash)
      return raw
    }
  } catch {
    /* 忽略 */
  }
  return null
}

function showToast(message, kind) {
  if (!message) return
  const type = kind === 'error' || kind === 'ok' ? kind : 'info'
  ui.toast.textContent = message
  ui.toast.className = 'toast toast--' + type
  ui.toast.hidden = false
  window.clearTimeout(store.toastTimer)
  store.toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true
  }, type === 'error' ? 3600 : 2400)
}

async function api(path, options = {}) {
  const headers = { accept: 'application/json' }
  if (store.token) headers['x-xiangqi-token'] = store.token
  let body
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(options.body)
  }
  let res
  try {
    res = await fetch(path, { method: options.method || 'GET', headers, body, cache: 'no-store', credentials: 'same-origin', signal: options.signal })
  } catch (error) {
    if (options.signal && options.signal.aborted) throw error
    throw new Error('网络连接失败，请检查网络后重试')
  }
  if (res.status === 401) {
    store.unauthorized = true
    throw new Error('口令无效或已过期')
  }
  const text = await res.text().catch(() => '')
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const message = data && typeof data.message === 'string' ? data.message : '请求失败（HTTP ' + res.status + '）'
    throw new Error(message)
  }
  return data || {}
}

// ---------- 棋盘 ----------
function buildBoard() {
  const fragment = document.createDocumentFragment()
  for (let rank = 7; rank >= 0; rank -= 1) {
    for (let file = 0; file < 8; file += 1) {
      const square = document.createElement('button')
      square.type = 'button'
      square.className = 'sq ' + ((file + rank) % 2 === 0 ? 'sq--dark' : 'sq--light')
      square.dataset.file = String(file)
      square.dataset.rank = String(rank)
      square.setAttribute('role', 'gridcell')
      square.setAttribute('aria-label', FILES[file] + (rank + 1))
      const marker = document.createElement('span')
      marker.className = 'marker'
      marker.hidden = true
      square.appendChild(marker)
      fragment.appendChild(square)
    }
  }
  ui.board.replaceChildren(fragment)
  store.squares = Array.from(ui.board.children)
}

function squareNode(file, rank) {
  return store.squares[(7 - rank) * 8 + file] || null
}

function pieceAt(cells, file, rank) {
  return cells && cells[rank * 8 + file] ? cells[rank * 8 + file] : null
}

function setPiece(square, piece) {
  const existing = square.querySelector('.piece')
  if (!piece) {
    if (existing) existing.remove()
    square.classList.remove('is-taken')
    return
  }
  if (!existing) {
    const span = document.createElement('span')
    span.className = 'piece piece--' + piece.color
    span.textContent = GLYPH[piece.color][piece.type]
    square.appendChild(span)
  } else {
    existing.className = 'piece piece--' + piece.color
    existing.textContent = GLYPH[piece.color][piece.type]
  }
}

function renderSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return
  const prev = store.snapshot
  store.snapshot = snap
  store.timerBase = {
    ms: typeof snap.remainingMs === 'number' ? snap.remainingMs : null,
    at: performance.now(),
    running: snap.status === 'playing' && Array.isArray(snap.moves) && snap.moves.length > 0,
  }
  const cells = Array.isArray(snap.cells) ? snap.cells : []
  for (const square of store.squares) {
    const file = Number(square.dataset.file)
    const rank = Number(square.dataset.rank)
    setPiece(square, pieceAt(cells, file, rank))
  }
  const prevKey = prev ? `${prev.gameId}:${prev.rev}` : ''
  const key = `${snap.gameId}:${snap.rev}`
  if (key !== prevKey && prev) {
    const last = snap.lastMove
    if (last) sound.playMove({ side: last.color === (snap.humanSide || 'white') ? 'human' : 'agent', capture: Array.isArray(last.tags) && last.tags.some((tag) => tag.startsWith('吃')) })
    if (Array.isArray(last && last.tags) && last.tags.some((tag) => tag.includes('将'))) sound.playAlert()
  }
  store.selected = null
  renderMarks()
  renderStatus()
  renderRecord()
  renderOverlay()
  updateControls()
}

function renderMarks() {
  const snap = store.snapshot
  const last = snap && snap.lastMove
  const legal = snap && snap.legal && typeof snap.legal === 'object' ? snap.legal : {}
  const targets = store.selected ? legal[store.selected] || [] : []
  const cells = snap && Array.isArray(snap.cells) ? snap.cells : []
  for (const square of store.squares) {
    const file = Number(square.dataset.file)
    const rank = Number(square.dataset.rank)
    const name = FILES[file] + (rank + 1)
    const isLast = Boolean(last && ((last.from && last.from.file === file && last.from.rank === rank) || (last.to && last.to.file === file && last.to.rank === rank)))
    square.classList.toggle('sq--last', isLast)
    square.classList.toggle('sq--selected', store.selected === name)
    const isTarget = targets.includes(name)
    square.classList.toggle('sq--target', isTarget)
    square.classList.toggle('sq--capture', isTarget && Boolean(pieceAt(cells, file, rank)))
    const marker = square.querySelector('.marker')
    if (marker) marker.hidden = !isTarget
  }
}

function currentRemaining() {
  const base = store.timerBase
  if (!base || base.ms === null) return null
  if (!base.running) return base.ms
  return Math.max(0, base.ms - (performance.now() - base.at))
}

function formatClock(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--:--'
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return pad(Math.floor(total / 60)) + ':' + pad(total % 60)
}

function renderStatus() {
  const snap = store.snapshot
  const text = formatClock(currentRemaining())
  if (ui.timer.textContent !== text) ui.timer.textContent = text
  ui.timer.classList.toggle('is-low', Boolean(snap && snap.status === 'playing' && currentRemaining() !== null && currentRemaining() <= LOW_TIME_MS))
  if (!snap) {
    ui.turnText.textContent = '正在连接…'
    ui.turnYou.hidden = true
    return
  }
  if (snap.status !== 'playing') {
    ui.turnText.textContent = snap.status === 'draw' ? '和棋' : STATUS_TEXT[snap.status] || '对局结束'
    ui.turnYou.hidden = true
    ui.turnDot.className = 'dot'
    ui.hint.textContent = '对局已结束'
    return
  }
  const turn = snap.turn === 'black' ? 'black' : 'white'
  const human = snap.humanSide === 'black' ? 'black' : 'white'
  ui.turnText.textContent = (turn === 'white' ? '白方' : '黑方') + '走棋'
  ui.turnYou.hidden = turn !== human
  ui.turnDot.className = 'dot dot--' + turn
  const inCheck = Array.isArray(snap.lastMove && snap.lastMove.tags) && snap.lastMove.tags.includes('将军')
  ui.hint.textContent = turn === human ? (inCheck ? '被将军！先应将' : '轮到你了：点自己的棋子 → 点亮点落子') : '等待 agent 落子…'
}

function renderRecord() {
  const snap = store.snapshot
  const moves = snap && Array.isArray(snap.moves) ? snap.moves : []
  const fragment = document.createDocumentFragment()
  for (let i = 0; i < moves.length; i += 2) {
    const li = document.createElement('li')
    const no = document.createElement('span')
    no.className = 'no'
    no.textContent = String(Math.floor(i / 2) + 1) + '.'
    const white = document.createElement('span')
    white.textContent = moves[i] ? moves[i].san : '—'
    const black = document.createElement('span')
    black.textContent = moves[i + 1] ? moves[i + 1].san : ''
    li.append(no, white, black)
    fragment.appendChild(li)
  }
  ui.recordList.replaceChildren(fragment)
  ui.recordEmpty.hidden = moves.length > 0
  ui.recordCount.textContent = moves.length + ' 手'
  ui.recordList.scrollTop = ui.recordList.scrollHeight
}

function renderOverlay() {
  const snap = store.snapshot
  const over = Boolean(snap && snap.status !== 'playing')
  if (!over || store.overlayDismissed) {
    ui.overlay.hidden = true
    return
  }
  const human = snap.humanSide === 'black' ? 'black' : 'white'
  const winner = snap.status === 'draw' ? null : snap.status === 'white-win' ? 'white' : 'black'
  ui.overlayTitle.textContent = !winner ? '和棋' : winner === human ? '你赢了' : '你输了'
  ui.overlayReason.textContent =
    (snap.status === 'draw' ? '和棋' : winner === 'white' ? '白方胜' : '黑方胜') +
    (snap.endReason ? ' · ' + (END_TEXT[snap.endReason] || snap.endReason) : '')
  ui.overlay.hidden = false
}

function updateControls() {
  const snap = store.snapshot
  const over = !snap || snap.status !== 'playing'
  ui.btnResign.disabled = over || store.busy
  ui.btnRecord.disabled = !snap || snap.status === 'no-game'
}

// ---------- 交互 ----------
async function doMove(from, to, promotion) {
  if (store.busy) return
  store.busy = true
  updateControls()
  try {
    const body = { from, to }
    if (promotion) body.promotion = promotion
    const data = await api(API.move, { method: 'POST', body })
    if (data.snapshot) renderSnapshot(data.snapshot)
    else await loadState()
  } catch (error) {
    showToast(error.message || '走子失败', 'error')
    await loadState().catch(() => {})
  } finally {
    store.busy = false
    updateControls()
  }
}

function askPromotion(from, to) {
  store.pendingPromotion = { from, to }
  ui.promo.hidden = false
}

function closePromotion() {
  store.pendingPromotion = null
  ui.promo.hidden = true
}

function onBoardClick(event) {
  const square = event.target.closest('.sq')
  if (!square || !store.snapshot) return
  const snap = store.snapshot
  if (snap.status !== 'playing' || store.unauthorized) return
  const file = Number(square.dataset.file)
  const rank = Number(square.dataset.rank)
  const name = FILES[file] + (rank + 1)
  const human = snap.humanSide === 'black' ? 'black' : 'white'
  const piece = pieceAt(snap.cells, file, rank)
  const legal = snap.legal && typeof snap.legal === 'object' ? snap.legal : {}
  if (store.selected) {
    const targets = legal[store.selected] || []
    if (targets.includes(name)) {
      const from = store.selected
      const fromPiece = pieceAt(snap.cells, FILES.indexOf(from[0]), Number(from[1]) - 1)
      const isPromotion = fromPiece && fromPiece.type === 'p' && (rank === 7 || rank === 0)
      if (isPromotion) {
        askPromotion(from, name)
      } else {
        doMove(from, name)
      }
      return
    }
  }
  if (piece && piece.color === human && snap.turn === human) {
    store.selected = name
    renderMarks()
    return
  }
  store.selected = null
  renderMarks()
}

async function loadState() {
  const data = await api(API.state)
  if (data && data.snapshot) renderSnapshot(data.snapshot)
  return data
}

async function startNewGame(fromOverlay) {
  if (store.busy) return
  if (!fromOverlay && store.snapshot && store.snapshot.status === 'playing') {
    if (!window.confirm('开始新局会结束当前对局，旧口令立即失效。继续吗？')) return
  }
  store.busy = true
  try {
    const data = await api(API.newGame, { method: 'POST', body: {} })
    store.overlayDismissed = false
    if (data.snapshot) renderSnapshot(data.snapshot)
    if (data.url) window.history.replaceState(null, '', data.url)
    showToast('新局已开始', 'ok')
  } catch (error) {
    showToast(error.message || '新局失败', 'error')
  } finally {
    store.busy = false
    updateControls()
  }
}

async function runAction(type) {
  if (store.busy) return
  if (type === 'resign' && !window.confirm('确定认输吗？')) return
  store.busy = true
  updateControls()
  try {
    const data = await api(API.action, { method: 'POST', body: { type } })
    if (data.snapshot) renderSnapshot(data.snapshot)
    showToast(type === 'resign' ? '已认输' : '已操作', 'ok')
  } catch (error) {
    showToast(error.message || '操作失败', 'error')
  } finally {
    store.busy = false
    updateControls()
  }
}

async function exportRecord() {
  try {
    const res = await fetch(API.record, { headers: store.token ? { 'x-xiangqi-token': store.token } : {}, credentials: 'same-origin' })
    if (!res.ok) throw new Error('导出失败（HTTP ' + res.status + '）')
    const markdown = await res.text()
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = (store.snapshot && store.snapshot.gameId ? store.snapshot.gameId : 'chess') + '.md'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 3000)
  } catch (error) {
    showToast(error.message || '导出失败', 'error')
  }
}

// ---------- 长轮询 ----------
function stopWatching() {
  if (store.watchAbort) {
    try {
      store.watchAbort.abort()
    } catch {
      /* 忽略 */
    }
    store.watchAbort = null
  }
}

async function watchLoop(controller) {
  while (!controller.signal.aborted) {
    const since = store.snapshot && Number.isFinite(store.snapshot.rev) ? store.snapshot.rev : null
    const path = since === null ? API.wait : API.wait + '?since=' + since
    try {
      const data = await api(path, { signal: controller.signal })
      if (controller.signal.aborted) return
      if (data && data.snapshot) renderSnapshot(data.snapshot)
      store.watchDelay = 400
    } catch (error) {
      if (controller.signal.aborted) return
      if (store.unauthorized) return
      await new Promise((resolve) => window.setTimeout(resolve, store.watchDelay))
      store.watchDelay = Math.min(4000, Math.round(store.watchDelay * 1.8))
    }
  }
}

function startWatching() {
  if (store.unauthorized) return
  stopWatching()
  const controller = new AbortController()
  store.watchAbort = controller
  void watchLoop(controller)
}

// ---------- 启动 ----------
function bindEvents() {
  ui.board.addEventListener('click', onBoardClick)
  ui.btnNew.addEventListener('click', () => startNewGame(false))
  ui.btnResign.addEventListener('click', () => runAction('resign'))
  ui.btnRecord.addEventListener('click', () => exportRecord())
  ui.btnAgain.addEventListener('click', () => startNewGame(true))
  ui.btnOverlayRecord.addEventListener('click', () => exportRecord())
  ui.btnOverlayClose.addEventListener('click', () => {
    store.overlayDismissed = true
    ui.overlay.hidden = true
  })
  for (const [button, piece] of [[ui.promoQ, 'q'], [ui.promoR, 'r'], [ui.promoB, 'b'], [ui.promoN, 'n']]) {
    button.addEventListener('click', () => {
      const pending = store.pendingPromotion
      closePromotion()
      if (pending) doMove(pending.from, pending.to, piece)
    })
  }
  ui.promoCancel.addEventListener('click', closePromotion)
  const unlock = () => sound.unlock()
  document.addEventListener('pointerdown', unlock, { capture: true, passive: true })
  document.addEventListener('keydown', unlock, { capture: true })
  ui.btnSound.addEventListener('click', () => {
    sound.toggle()
    ui.btnSound.textContent = sound.enabled ? '🔊' : '🔇'
    ui.btnSound.setAttribute('aria-pressed', sound.enabled ? 'true' : 'false')
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadState().catch(() => {})
      startWatching()
    }
  })
  window.addEventListener('online', () => {
    loadState().catch(() => {})
    startWatching()
  })
}

function startTicking() {
  window.clearInterval(store.tickHandle)
  store.tickHandle = window.setInterval(() => renderStatus(), 250)
}

function init() {
  if (ui.bootNote) ui.bootNote.remove()
  ui.btnSound.textContent = sound.enabled ? '🔊' : '🔇'
  ui.btnSound.setAttribute('aria-pressed', sound.enabled ? 'true' : 'false')
  buildBoard()
  bindEvents()
  startTicking()
  renderStatus()
  loadState()
    .then(() => startWatching())
    .catch((error) => {
      showToast(error.message || '读取棋局失败', 'error')
      if (!store.unauthorized) startWatching()
    })
}

init()
