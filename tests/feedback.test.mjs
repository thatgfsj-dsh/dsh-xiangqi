// 前端反馈逻辑回归（音效/招数提示），不依赖 DOM：注入假 sound / showToast / parseFen。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createFeedback } from '../web/feedback.js'

function makeHarness() {
  const calls = { move: [], end: [], alert: 0, toast: [] }
  const sound = {
    enabled: true,
    playMove: (detail) => calls.move.push(detail),
    playEnd: (detail) => calls.end.push(detail),
    playAlert: () => {
      calls.alert += 1
    },
  }
  const showToast = (message, kind) => calls.toast.push({ message, kind })
  const parseFen = (fen) => ({ pieces: new Map((fen || '').split('').filter((ch) => /[rnbakcp]/i.test(ch)).map((ch, i) => [i, ch])) })
  const feedback = createFeedback({ sound, showToast, parseFen })
  return { feedback, calls }
}

const snap = (over = {}) => ({
  gameId: 'g1',
  status: 'playing',
  humanSide: 'red',
  fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR b',
  moves: [{ n: 1, color: 'red', notation: '炮二平五', iccs: 'h2e2', tags: [] }],
  ...over,
})

test('人类落子：播放人类音色，不弹提示', () => {
  const { feedback, calls } = makeHarness()
  feedback.onSnapshot(snap({}), snap({ rev: 2, moves: [...snap({}).moves, { n: 2, color: 'black', notation: '马8进7', tags: [] }] }))
  assert.equal(calls.move.length, 1)
  assert.equal(calls.move[0].side, 'agent')
  assert.equal(calls.alert, 0)
})

test('agent 走子带「将军」标签 → 提示音 + toast', () => {
  const { feedback, calls } = makeHarness()
  const prev = snap({})
  const next = snap({
    moves: [...prev.moves, { n: 2, color: 'black', notation: '炮8平5', tags: ['将军'] }],
  })
  feedback.onSnapshot(prev, next)
  assert.equal(calls.move.length, 1)
  assert.equal(calls.move[0].side, 'agent')
  assert.equal(calls.alert, 1)
  assert.equal(calls.toast.length, 1)
  assert.equal(calls.toast[0].message, '将军！')
})

test('吃子音效：子力数量减少时 capture=true', () => {
  const { feedback, calls } = makeHarness()
  const prev = snap({})
  const next = snap({
    fen: 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR b',
    moves: [...prev.moves, { n: 2, color: 'black', notation: '象3进5', tags: ['吃车'] }],
  })
  // 让子力数真的变少
  next.fen = 'nbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C2C4/9/RNBAKABNR b'
  feedback.onSnapshot(prev, next)
  assert.equal(calls.move[0].capture, true)
})

test('换局不播音效', () => {
  const { feedback, calls } = makeHarness()
  const prev = snap({ gameId: 'g1' })
  const next = snap({ gameId: 'g2', moves: [{ n: 1, color: 'red', notation: '兵七进一', tags: [] }] })
  feedback.onSnapshot(prev, next)
  assert.equal(calls.move.length, 0)
  assert.equal(calls.end.length, 0)
})

test('对局结束：按人类方胜负播放结束音', () => {
  const { feedback, calls } = makeHarness()
  const prev = snap({})
  const next = snap({ status: 'black-win', endReason: 'resign', moves: prev.moves })
  feedback.onSnapshot(prev, next)
  assert.equal(calls.end.length, 1)
  assert.equal(calls.end[0].win, false)
})

test('音效按钮状态与 aria-pressed 同步', () => {
  const { feedback } = makeHarness()
  const btn = {
    textContent: '',
    attrs: {},
    setAttribute(name, value) {
      this.attrs[name] = String(value)
    },
  }
  feedback.renderSoundButton(btn)
  assert.equal(btn.textContent, '🔊')
  assert.equal(btn.attrs['aria-pressed'], 'true')
})
