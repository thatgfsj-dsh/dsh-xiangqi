// 自动唤醒回归：人类在网页走子后，插件应给「发起对局的 agent」followup 一条消息。
// 用假 ctx 模拟 DSH 的 agents / sessionController / sessions 服务。
import test from 'node:test'
import assert from 'node:assert/strict'

test('人类走子后自动唤醒 agent（followup 一条含着法的用户消息）', async (t) => {
  const followups = []
  const fakeAgent = {
    session: { id: 'sess-test-1' },
    followup(message) {
      followups.push(message)
    },
  }
  const tools = []
  const disposers = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    on() { return () => {} },
    get(name) {
      if (name === 'agents') return { currentInitiator: () => fakeAgent }
      if (name === 'sessionController') {
        return {
          async resolveAgent(sessionId) {
            return sessionId === fakeAgent.session.id ? { agent: fakeAgent } : { error: new Error('unknown session') }
          },
        }
      }
      if (name === 'sessions') return { async flush() { return true } }
      return undefined
    },
  }

  const plugin = await import('../index.js')
  plugin.apply(ctx)

  t.after(async () => {
    for (const dispose of disposers.reverse()) {
      try { await dispose() } catch { /* 忽略 */ }
    }
  })

  const byName = (name) => tools.find((tool) => tool.name === name)
  assert.equal(tools.length, 7, '应注册 7 个工具')

  // 等服务真正绑定端口
  let newGameText = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    newGameText = await byName('xiangqi_new_game').execute({ humanSide: 'red', minutes: 20 })
    if (!newGameText.includes('服务未就绪')) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?k=([A-Za-z0-9_-]+)/.exec(newGameText)
  assert.ok(match, `应返回邀请 URL，实际：${newGameText.split('\n')[0]}`)
  const [, port, token] = match

  assert.equal(followups.length, 0, '刚建局时不应唤醒')

  // 模拟人类在网页上走「炮二平五」
  const res = await fetch(`http://127.0.0.1:${port}/api/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xiangqi-token': token },
    body: JSON.stringify({ from: 'h2', to: 'e2' }),
  })
  assert.equal(res.status, 200)

  // 等 500ms 防抖 + 唤醒
  for (let attempt = 0; attempt < 20 && followups.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  assert.equal(followups.length, 1, '人类走子后应恰好唤醒一次')
  const message = followups[0]
  assert.equal(message.role, 'user')
  assert.ok(typeof message.id === 'string' && message.id.length > 0, '消息要有 id')
  assert.equal(message.source.kind, 'user')
  const text = message.content.map((block) => block.text).join('')
  assert.ok(text.includes('炮二平五'), `唤醒文案应含着法，实际：${text}`)
  assert.ok(text.includes('黑方'), `唤醒文案应说明轮到黑方，实际：${text}`)

  // agent 自己走子（黑方）不应再唤醒
  const moveText = await byName('xiangqi_move').execute({ move: 'h9g7' })
  assert.ok(moveText.includes('走子成功'), moveText)
  await new Promise((resolve) => setTimeout(resolve, 700))
  assert.equal(followups.length, 1, 'agent 自己走子不应触发唤醒')
})

test('换局会丢弃上一局尚未投递的唤醒（避免把旧局结束消息发到新局）', async (t) => {
  const followups = []
  const fakeAgent = {
    session: { id: 'sess-test-2' },
    followup(message) {
      followups.push(message)
    },
  }
  const tools = []
  const disposers = []
  const ctx = {
    tools: { register(definition) { tools.push(definition); return () => {} } },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => {}
    },
    on() { return () => {} },
    get(name) {
      if (name === 'agents') return { currentInitiator: () => fakeAgent }
      if (name === 'sessionController') {
        return {
          async resolveAgent(sessionId) {
            return sessionId === fakeAgent.session.id ? { agent: fakeAgent } : { error: new Error('unknown') }
          },
        }
      }
      if (name === 'sessions') return { async flush() { return true } }
      return undefined
    },
  }
  const plugin = await import('../index.js')
  plugin.apply(ctx)
  t.after(async () => {
    for (const dispose of disposers.reverse()) {
      try { await dispose() } catch { /* 忽略 */ }
    }
  })

  const byName = (name) => tools.find((tool) => tool.name === name)
  let text = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    text = await byName('xiangqi_new_game').execute({ humanSide: 'red', minutes: 20 })
    if (!text.includes('服务未就绪')) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  const match = /http:\/\/127\.0\.0\.1:(\d+)\/\?k=([A-Za-z0-9_-]+)/.exec(text)
  assert.ok(match, '应返回邀请 URL')
  const [, port, token] = match

  // 人类走一步（会排一个 500ms 后的唤醒）
  const res = await fetch(`http://127.0.0.1:${port}/api/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-xiangqi-token': token },
    body: JSON.stringify({ from: 'h2', to: 'e2' }),
  })
  assert.equal(res.status, 200)

  // 500ms 内立刻换局 → 旧唤醒必须被丢弃
  await byName('xiangqi_new_game').execute({ humanSide: 'red', minutes: 20 })
  await new Promise((resolve) => setTimeout(resolve, 900))
  assert.equal(followups.length, 0, '换局后不应再收到上一局的唤醒')
})
