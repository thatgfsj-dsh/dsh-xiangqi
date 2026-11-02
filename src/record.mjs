/**
 * 记谱 Markdown 渲染（docs/DESIGN.md §8）。
 * 只接受对局快照，不读文件、不发网络请求；口令/域名一律脱敏为占位符。
 */

const PLACEHOLDER_BASE = '<base>'
const PLACEHOLDER_TOKEN = '<token>'

const STATUS_TEXT = {
  idle: '未开始',
  playing: '进行中',
  'red-win': '红方胜',
  'black-win': '黑方胜',
  draw: '和棋',
  expired: '超时',
}

const TURN_TEXT = { red: '红方', black: '黑方' }

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 毫秒 -> mm:ss（负数按 00:00）。 */
export function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00'
  const total = Math.floor(ms / 1000)
  return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
}

function displayStatus(snapshot) {
  const status = snapshot?.status ?? 'idle'
  if (status === 'playing' && Number.isFinite(snapshot?.remainingMs) && snapshot.remainingMs <= 0) return '超时'
  if (status === 'playing' && snapshot?.expired) return '超时'
  return STATUS_TEXT[status] || status
}

function displayTurn(snapshot) {
  if (snapshot?.status && snapshot.status !== 'playing') return '已结束'
  return TURN_TEXT[snapshot?.turn] || '未知'
}

/** 着法附带的招数标签（将军抽车 / 将死 / 吃车 …）。 */
function tagsText(move) {
  if (!move || !Array.isArray(move.tags) || move.tags.length === 0) return ''
  return ' ' + move.tags.join('·')
}

function movesTable(moves) {
  const rows = []
  const list = Array.isArray(moves) ? moves : []
  for (let i = 0; i < list.length; i += 2) {
    const red = list[i]
    const black = list[i + 1]
    const round = Math.floor(i / 2) + 1
    rows.push(
      `| ${round} | ${red ? (red.notation || '') + tagsText(red) : '—'} | ${
        black ? (black.notation || '') + tagsText(black) : '—'
      } |`,
    )
  }
  return [
    '| 回合 | 红方 | 黑方 |',
    '|---:|---|---|',
    ...rows,
  ]
}

function boardBlock(snapshot) {
  const ascii = Array.isArray(snapshot?.ascii) && snapshot.ascii.length > 0
    ? snapshot.ascii
    : []
  if (ascii.length === 0) return ['（棋盘不可用）']
  return ['```text', ...ascii, '```']
}

function headerLine(snapshot) {
  const red = snapshot?.humanSide === 'red' ? '人类' : 'agent'
  const black = snapshot?.humanSide === 'black' ? '人类' : 'agent'
  const id = snapshot?.gameId || 'unsaved'
  return `# 象棋对局 ${id} · 红方：${red} · 黑方：${black}`
}

/**
 * 渲染记谱 Markdown。
 * @param {object} snapshot 对局快照（见 DESIGN §4）
 * @param {object} [options] { base, token, playerLabel }
 * @returns {string}
 */
export function renderRecordMd(snapshot, options = {}) {
  const input = snapshot && typeof snapshot === 'object' && snapshot.snapshot ? snapshot.snapshot : snapshot
  const opts = snapshot && typeof snapshot === 'object' && snapshot.snapshot ? snapshot : options
  const snap = input || {}
  const base = opts.base || PLACEHOLDER_BASE
  const token = opts.token || PLACEHOLDER_TOKEN
  const lines = []

  lines.push(headerLine(snap))
  lines.push('')
  lines.push(`- 状态：${displayStatus(snap)} · 轮到：${displayTurn(snap)} · 剩余：${formatRemaining(snap.remainingMs)}`)
  lines.push(`- FEN：\`${snap.fen || '—'}\``)
  if (snap.lastMove && (snap.lastMove.notation || snap.lastMove.iccs)) {
    const last = snap.lastMove
    lines.push(`- 最近一手：${last.notation || last.iccs}（${last.iccs || ''}）${tagsText(last).trim() ? ' · ' + last.tags.join('·') : ''}`)
  } else {
    lines.push('- 最近一手：—（尚未落子）')
  }
  lines.push('')
  lines.push('## 棋盘')
  lines.push('')
  lines.push(...boardBlock(snap))
  lines.push('')
  lines.push('## 着法')
  lines.push('')
  lines.push(...movesTable(snap.moves))
  lines.push('')
  lines.push('## 给 agent 的下一步（可直接复制）')
  lines.push('')
  lines.push(`- 拉当前局面：\`GET ${base}/api/state\`，请求头 \`x-xiangqi-token: ${token}\``)
  lines.push('- 走子：`POST ' + base + '/api/move`，body `{"from":"h2","to":"e2"}`（也接受 `{"iccs":"h2e2"}`）')
  lines.push(`- 记谱：\`GET ${base}/api/record.md\`，请求头 \`x-xiangqi-token: ${token}\``)
  lines.push('- 轮到自己时再走子；非法走法会返回 `{ok:false,code,message}`，按 message 修正。')
  lines.push('')
  return lines.join('\n')
}

export default renderRecordMd
