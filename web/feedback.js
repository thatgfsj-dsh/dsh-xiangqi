// 前端反馈：音效开关按钮状态 + 落子音效 + 招数提示（将军/将军抽车/将死…）。
// 从 app.js 拆出，避免单文件超过 1000 行；依赖由调用方注入（sound kit / showToast / parseFen）。

/** 数一下棋盘上还有多少子（用于判断这一手是否吃子）。 */
function pieceCountOf(parseFen, fen) {
  try {
    const parsed = parseFen(fen)
    return parsed && parsed.pieces ? parsed.pieces.size : 0
  } catch (err) {
    return 0
  }
}

/**
 * @param {object} deps
 * @param {{enabled:boolean, unlock:Function, toggle:Function, playMove:Function, playEnd:Function, playAlert:Function}} deps.sound
 * @param {(message:string, kind?:string)=>void} deps.showToast
 * @param {(fen:string)=>any} deps.parseFen
 */
export function createFeedback({ sound, showToast, parseFen }) {
  /** 音效开关按钮状态（🔊 / 🔇 + aria-pressed）。 */
  function renderSoundButton(btn) {
    if (!btn) return
    btn.textContent = sound.enabled ? '🔊' : '🔇'
    btn.setAttribute('aria-pressed', sound.enabled ? 'true' : 'false')
    btn.title = sound.enabled ? '音效：开（点击关闭）' : '音效：关（点击开启）'
  }

  /** 招数提示：将军 / 将军抽车 / 将死 等用提示音 + toast 提醒。 */
  function announceTags(tags) {
    if (!Array.isArray(tags) || tags.length === 0) return
    const hit = tags.find((tag) => typeof tag === 'string' && tag.includes('将'))
    if (!hit) return
    sound.playAlert()
    showToast(hit === '将死' ? '将死！' : `${hit}！`, 'error')
  }

  /**
   * 按快照差异播放音效并提示招数：
   * - 新增一手：人类/agent 两种音色，吃子另有脆响；
   * - 状态从 playing 变为结束：胜负提示音。
   */
  function onSnapshot(prev, snap) {
    if (!prev) return
    if (prev.gameId && snap.gameId && prev.gameId !== snap.gameId) return // 换局不出声
    const prevMoves = Array.isArray(prev.moves) ? prev.moves.length : 0
    const nextMoves = Array.isArray(snap.moves) ? snap.moves.length : 0
    if (nextMoves > prevMoves) {
      const last = snap.moves[nextMoves - 1] || snap.lastMove || {}
      const humanSide = snap.humanSide || 'red'
      const side = last.color ? (last.color === humanSide ? 'human' : 'agent') : 'human'
      const capture = pieceCountOf(parseFen, snap.fen) < pieceCountOf(parseFen, prev.fen)
      sound.playMove({ side, capture })
      announceTags(last.tags)
    }
    if (prev.status === 'playing' && snap.status && snap.status !== 'playing') {
      const humanSide = snap.humanSide || 'red'
      sound.playEnd({ win: snap.status === `${humanSide}-win` })
    }
  }

  return { renderSoundButton, announceTags, onSnapshot }
}

export default createFeedback
