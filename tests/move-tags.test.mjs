// 招数标签（将军 / 将军抽车 / 双将 / 吃子 / 应将 / 过河 / 捉双）回归。
import test from 'node:test'
import assert from 'node:assert/strict'
import { fromFen, moveTags } from '../src/rules/xiangqi.mjs'

const START = 'rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR r'

test('吃子：炮打底马 → 吃马', () => {
  const tags = moveTags(fromFen(START), { from: 'b2', to: 'b9' })
  assert.ok(tags.includes('吃马'), `实际标签：${JSON.stringify(tags)}`)
})

test('普通着法：既不吃子也不将军 → 无标签', () => {
  const tags = moveTags(fromFen('4k4/9/9/9/9/9/9/9/9/K3R4 r'), { from: 'e0', to: 'd0' })
  assert.deepEqual(tags, [])
})

test('将军：车沉底照将', () => {
  const tags = moveTags(fromFen('4k4/9/9/9/9/9/9/9/9/K3R4 r'), { from: 'e0', to: 'e8' })
  assert.ok(tags.includes('将军'), `实际标签：${JSON.stringify(tags)}`)
})

test('将军抽车：马落点同时将 + 捉车', () => {
  const tags = moveTags(fromFen('4k4/5r3/9/9/2N6/9/9/9/9/K8 r'), { from: 'c5', to: 'd7' })
  assert.ok(tags.includes('将军抽车'), `实际标签：${JSON.stringify(tags)}`)
})

test('双将：马走开后车照 + 马将', () => {
  const tags = moveTags(fromFen('4k4/9/9/9/2N6/9/9/9/4R4/K8 r'), { from: 'c5', to: 'd7' })
  assert.ok(tags.includes('双将'), `实际标签：${JSON.stringify(tags)}`)
})

test('应将：被将军时走子解将', () => {
  const tags = moveTags(fromFen('k8/4r4/9/9/9/9/9/9/9/4K4 r'), { from: 'e0', to: 'd0' })
  assert.ok(tags.includes('应将'), `实际标签：${JSON.stringify(tags)}`)
})

test('过河：兵从己方半场过河打标签', () => {
  const tags = moveTags(fromFen('4k4/9/9/9/9/P8/9/9/9/K8 r'), { from: 'a4', to: 'a5' })
  assert.ok(tags.includes('兵过河'), `实际标签：${JSON.stringify(tags)}`)
})

test('捉双：马同时捉两车', () => {
  const tags = moveTags(fromFen('4k4/r3r4/9/9/1N7/9/9/9/9/1K7 r'), { from: 'b5', to: 'c7' })
  assert.ok(tags.includes('捉双'), `实际标签：${JSON.stringify(tags)}`)
})
