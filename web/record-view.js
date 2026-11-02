// 棋谱列表渲染（含招数徽标：将军 / 将军抽车 / 吃车 …）。
// 从 app.js 拆出以控制单文件行数；依赖由调用方注入。

/** 把一步棋写入单元格：记谱 + 招数徽标。 */
function appendMoveCell(container, text, tags) {
  if (!text) return
  container.appendChild(document.createTextNode(text))
  if (!Array.isArray(tags)) return
  for (const tag of tags) {
    if (typeof tag !== 'string' || !tag) continue
    const badge = document.createElement('span')
    badge.className = 'record-tag' + (tag.includes('将') ? ' record-tag--check' : '')
    badge.textContent = tag
    container.appendChild(badge)
  }
}

/**
 * @param {object} deps
 * @param {object} deps.ui 元素引用
 * @param {object} deps.store 前端状态
 * @param {(move:object)=>string} deps.notationOf 取一步棋的记谱文本
 */
export function createRecordView({ ui, store, notationOf }) {
  function render() {
    const snap = store.snapshot
    const moves = snap && Array.isArray(snap.moves) ? snap.moves : []
    const rows = []
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i] && typeof moves[i] === 'object' ? moves[i] : {}
      const turnNo = Math.floor(i / 2) + 1
      const isRed = typeof move.color === 'string' ? move.color !== 'black' : i % 2 === 0
      const text = notationOf(move)
      const tags = Array.isArray(move.tags) ? move.tags : []
      if (isRed) {
        rows.push({ no: turnNo, red: text, redTags: tags, black: '', blackTags: [] })
      } else {
        const last = rows[rows.length - 1]
        if (last && last.no === turnNo && !last.black) {
          last.black = text
          last.blackTags = tags
        } else {
          rows.push({ no: turnNo, red: '', redTags: [], black: text, blackTags: tags })
        }
      }
    }
    const fragment = document.createDocumentFragment()
    for (const row of rows) {
      const li = document.createElement('li')
      const no = document.createElement('span')
      no.className = 'record-no'
      no.textContent = String(row.no) + '.'
      const red = document.createElement('span')
      red.className = 'record-red'
      appendMoveCell(red, row.red, row.redTags)
      const black = document.createElement('span')
      black.className = 'record-black'
      appendMoveCell(black, row.black, row.blackTags)
      li.append(no, red, black)
      fragment.appendChild(li)
    }
    if (fragment.lastChild) fragment.lastChild.classList.add('is-latest')
    ui.recordList.replaceChildren(fragment)
    ui.recordEmpty.hidden = moves.length > 0
    ui.recordCount.textContent = moves.length + ' 手'
    if (moves.length !== store.moveCount) {
      store.moveCount = moves.length
      ui.recordScroll.scrollTop = ui.recordScroll.scrollHeight
    }
  }
  return { render }
}

export default createRecordView
