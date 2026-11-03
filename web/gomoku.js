// 五子棋前端（原生 ES module，无构建、无外链）。规则全部在服务端，前端只负责展示与落子请求。
import { createSoundKit } from './sound.js'

const SIZE = 15
const FILES = 'abcdefghijklmno'
const API = {
  state: '/api/gomoku/state',
  wait: '/api/gomoku/wait',
  move: '/api/gomoku/move',
  newGame: '/api/gomoku/new',
  action: '/api/gomoku/action',
  record: '/api/gomoku/record.md',
}
const STATUS_TEXT = { playing: '进行中', 'black-win': '黑方胜', 'white-win': '白方胜', draw: '和棋' }
const END_TEXT = { five: '五连', resign: '认输', timeout: '超时', draw: '和棋' }
const LOW_TIME_MS = 60000

const $ = (id) => document.getElementById(id)
const ui = {
  app: $('app'), board: $('board'), turnDot: $('turn-dot'), turnText: $('turn-text'), turnYou: $('turn-you'),
  timer: $('timer'), hint: $('hint'), btnNew: $('btn-new'), btnResign: $('btn-resign'), btnRecord: $('btn-record'),
  btnSound: $('btn-sound'), recordList: $('record-list'), recordCount: $('record-count'), recordEmpty: $('record-empty'),
  overlay: $('overlay'), overlayTitle: $('overlay-title'), overlayReason: $('overlay-reason'),
  btnAgain: $('btn-again'), btnOverlayRecord: $('btn-overlay-record'), btnOverlayClose: $('btn-overlay-close'),
  toast: $('toast'), bootNote: $('boot-note'),
}
const store = {
  token: readToken(), snapshot: null, cells: [], busy: false, overlayDismissed: false,
  connected: false, unauthorized: false, watchAbort: null, watchDelay: 400, toastTimer: 0,
  timerBase: null, tickHandle: 0, lastKey: '',
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

// ---------- 渲染 ----------
function buildBoard() {
  const fragment = document.createDocumentFragment()
  for (let rank = SIZE - 1; rank >= 0; rank -= 1) {
    for (let file = 0; file < SIZE; file += 1) {
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.className = 'cell'
      cell.dataset.file = String(file)
      cell.dataset.rank = String(rank)
      cell.setAttribute('role', 'gridcell')
      cell.setAttribute('aria-label', `${FILES[file]}${rank + 1}`)
      const holder = document.createElement('span')
      holder.className = 'stone-placeholder'
      cell.appendChild(holder)
      fragment.appendChild(cell)
    }
  }
  ui.board.replaceChildren(fragment)
  store.cells = Array.from(ui.board.children)
}

function renderSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return
  const prev = store.snapshot
  store.snapshot = snap
  store.timerBase = { ms: typeof snap.remainingMs === 'number' ? snap.remainingMs : null, at: performance.now(), running: snap.status === 'playing' && Array.isArray(snap.moves) && snap.moves.length > 0 }
  const cells = Array.isArray(snap.cells) ? snap.cells : []
  for (const cell of store.cells) {
    const file = Number(cell.dataset.file)
    const rank = Number(cell.dataset.rank)
    const color = cells[rank * SIZE + file] || null
    const existing = cell.querySelector('.stone')
    if (color && !existing) {
      const stone = document.createElement('span')
      stone.className = 'stone stone--' + color
      cell.appendChild(stone)
      cell.classList.add('is-taken')
    } else if (!color && existing) {
      existing.remove()
      cell.classList.remove('is-taken')
    }
    cell.classList.toggle('is-last', Boolean(snap.lastMove && snap.lastMove.file === file && snap.lastMove.rank === rank))
  }
  const prevKey = prev ? `${prev.gameId}:${prev.rev}` : ''
  const key = `${snap.gameId}:${snap.rev}`
  if (key !== prevKey && prev) {
    const last = snap.lastMove
    if (last) sound.playMove({ side: last.color === (snap.humanSide || 'black') ? 'human' : 'agent' })
  }
  renderStatus()
  renderRecord()
  renderOverlay()
  updateControls()
}

function currentRemaining() {
  const base = store.timerBase
  if (!base || base.ms === null) return null
  if (!base.running) return base.ms
  return Math.max(0, base.ms - (performance.now() - base.at))
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
  const turn = snap.turn === 'white' ? 'white' : 'black'
  const human = snap.humanSide === 'white' ? 'white' : 'black'
  ui.turnText.textContent = (turn === 'black' ? '黑方' : '白方') + '落子'
  ui.turnYou.hidden = turn !== human
  ui.turnDot.className = 'dot dot--' + turn
  ui.hint.textContent = turn === human ? '轮到你了：点空点落子' : '等待 agent 落子…'
}

function formatClock(ms) {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return '--:--'
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return pad(Math.floor(total / 60)) + ':' + pad(total % 60)
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
    const black = document.createElement('span')
    black.textContent = moves[i] ? moves[i].iccs : '—'
    const white = document.createElement('span')
    white.textContent = moves[i + 1] ? moves[i + 1].iccs : ''
    li.append(no, black, white)
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
  const human = snap.humanSide === 'white' ? 'white' : 'black'
  const winner = snap.status === 'draw' ? null : snap.status === 'black-win' ? 'black' : 'white'
  ui.overlayTitle.textContent = !winner ? '和棋' : winner === human ? '你赢了' : '你输了'
  ui.overlayReason.textContent = (snap.status === 'draw' ? '双方和棋' : (winner === 'black' ? '黑方胜' : '白方胜')) + (snap.endReason ? ' · ' + (END_TEXT[snap.endReason] || snap.endReason) : '')
  ui.overlay.hidden = false
}

function updateControls() {
  const snap = store.snapshot
  const over = !snap || snap.status !== 'playing'
  ui.btnResign.disabled = over || store.busy
  ui.btnRecord.disabled = !snap || snap.status === 'no-game'
}

// ---------- 交互 ----------
async function doMove(file, rank) {
  if (store.busy) return
  store.busy = true
  updateControls()
  try {
    const data = await api(API.move, { method: 'POST', body: { file, rank } })
    if (data.snapshot) renderSnapshot(data.snapshot)
    else await loadState()
  } catch (error) {
    showToast(error.message || '落子失败', 'error')
    await loadState().catch(() => {})
  } finally {
    store.busy = false
    updateControls()
  }
}

function onBoardClick(event) {
  const cell = event.target.closest('.cell')
  if (!cell || !store.snapshot) return
  if (store.snapshot.status !== 'playing' || store.unauthorized) return
  const human = store.snapshot.humanSide === 'white' ? 'white' : 'black'
  if (store.snapshot.turn !== human) {
    showToast('还没轮到你', 'info')
    return
  }
  if (cell.classList.contains('is-taken')) {
    showToast('这里已经有子了', 'info')
    return
  }
  doMove(Number(cell.dataset.file), Number(cell.dataset.rank))
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
    if (store.token) return
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
    link.download = (store.snapshot && store.snapshot.gameId ? store.snapshot.gameId : 'gomoku') + '.md'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 3000)
  } catch (error) {
    showToast(error.message || '导出失败', 'error')
  }
}

// ---------- 长轮询动态刷新 ----------
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
