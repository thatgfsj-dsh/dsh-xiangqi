// 招数解说短语（进车捉马 / 平炮打马 / 进炮吃马 / 进车将军）回归。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fromFen } from '../src/rules/xiangqi.mjs'
import { moveComment } from '../src/rules/index.mjs'

const START = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR r'

test('吃子解说：进炮吃马', () => {
  assert.equal(moveComment(fromFen(START), { from: 'b2', to: 'b9' }), '进炮吃马')
})

test('捉子解说：进车捉马', () => {
  const fen = '3k5/9/9/9/4n4/9/9/9/9/K3R4 r'
  assert.equal(moveComment(fromFen(fen), { from: 'e0', to: 'e2' }), '进车捉马')
})

test('炮打解说：平炮打马', () => {
  const fen = '3k5/9/9/9/9/9/9/1CP1n4/9/K8 r'
  assert.equal(moveComment(fromFen(fen), { from: 'b2', to: 'a2' }), '平炮打马')
})

test('将军解说：进车将军', () => {
  const fen = '4k4/9/9/9/9/9/9/9/9/K3R4 r'
  assert.equal(moveComment(fromFen(fen), { from: 'e0', to: 'e8' }), '进车将军')
})

test('平淡着法没有解说', () => {
  const fen = '4k4/9/9/9/9/9/9/9/9/K3R4 r'
  assert.equal(moveComment(fromFen(fen), { from: 'e0', to: 'd0' }), '')
})
