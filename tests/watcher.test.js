import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWatcher, snapOf } from './helpers.js'

test('首次快照只初始化不触发（含粘性 completed 的旧任务）', () => {
  const w = createWatcher()
  const events = w.diff(null, snapOf([{ id: 'a', completed: true }, { id: 'b', running: true }], 'a'))
  assert.equal(events.length, 0)
})

test('当前选中会话 运行→停止 触发 selected 事件', () => {
  const w = createWatcher()
  const prev = snapOf([{ id: 'a', running: true }], 'a')
  w.diff(null, prev)
  const events = w.diff(prev, snapOf([{ id: 'a', running: false }], 'a'))
  assert.equal(events.length, 1)
  assert.equal(events[0].sessionId, 'a')
  assert.equal(events[0].selected, true)
})

test('后台会话完成触发 selected=false，completed 粘性期间不重复', () => {
  const w = createWatcher()
  const prev = snapOf([{ id: 'a', running: true }, { id: 'b' }], 'b')
  w.diff(null, prev)
  const done = snapOf([{ id: 'a', running: false, completed: true }, { id: 'b' }], 'b')
  const events = w.diff(prev, done)
  assert.equal(events.length, 1)
  assert.equal(events[0].sessionId, 'a')
  assert.equal(events[0].selected, false)
  const again = w.diff(done, snapOf([{ id: 'a', running: false, completed: true }, { id: 'b' }], 'b'))
  assert.equal(again.length, 0)
})

test('错过运行边沿时 completed 粘性标记兜底触发一次', () => {
  const w = createWatcher()
  const idle = snapOf([{ id: 'a', running: false }, { id: 'b' }], 'b')
  w.diff(null, idle)
  const events = w.diff(idle, snapOf([{ id: 'a', running: false, completed: true }, { id: 'b' }], 'b'))
  assert.equal(events.length, 1)
  assert.equal(events[0].sessionId, 'a')
})

test('会话重新运行后再次完成会再次触发', () => {
  const w = createWatcher()
  const run1 = snapOf([{ id: 'a', running: true }], 'a')
  const idle1 = snapOf([{ id: 'a', running: false }], 'a')
  w.diff(null, run1)
  assert.equal(w.diff(run1, idle1).length, 1)
  const run2 = snapOf([{ id: 'a', running: true }], 'a')
  w.diff(idle1, run2)
  const events = w.diff(run2, snapOf([{ id: 'a', running: false }], 'a'))
  assert.equal(events.length, 1)
})

test('子代理会话被过滤', () => {
  const w = createWatcher()
  const prev = snapOf([{ id: 'root', running: true }, { id: 'sub', running: true, origin: 'subagent' }], 'root')
  w.diff(null, prev)
  const events = w.diff(prev, snapOf([{ id: 'root', running: false }, { id: 'sub', running: false, origin: 'subagent' }], 'root'))
  assert.equal(events.length, 1)
  assert.equal(events[0].sessionId, 'root')
})

test('多会话同时完成产生多个事件', () => {
  const w = createWatcher()
  const prev = snapOf([{ id: 'a', running: true }, { id: 'b', running: true }], 'a')
  w.diff(null, prev)
  const events = w.diff(prev, snapOf([{ id: 'a', running: false }, { id: 'b', running: false }], 'a'))
  assert.equal(events.length, 2)
})

test('标题取自 displayTitle', () => {
  const w = createWatcher()
  const prev = snapOf([{ id: 'a', running: true, title: '修复登录' }], 'a')
  w.diff(null, prev)
  const events = w.diff(prev, snapOf([{ id: 'a', running: false, title: '修复登录' }], 'a'))
  assert.equal(events[0].title, '修复登录')
})

test('会话从列表移除后状态清理，同 id 重新出现从头开始', () => {
  const w = createWatcher()
  const prev = snapOf([{ id: 'a', running: true }], 'a')
  w.diff(null, prev)
  assert.equal(w.diff(prev, snapOf([{ id: 'a', running: false }], 'a')).length, 1)
  w.diff(snapOf([{ id: 'a', running: false }], 'a'), snapOf([], undefined)) // 移除
  const run = snapOf([{ id: 'a', running: true }], 'a')
  w.diff(null, run)
  const events = w.diff(run, snapOf([{ id: 'a', running: false }], 'a'))
  assert.equal(events.length, 1)
})

test('同一快照重复 diff 不重复触发（StrictMode 双调用安全）', () => {
  const w = createWatcher()
  const prev = snapOf([{ id: 'a', running: true }], 'a')
  const idle = snapOf([{ id: 'a', running: false }], 'a')
  w.diff(null, prev)
  assert.equal(w.diff(prev, idle).length, 1)
  assert.equal(w.diff(idle, idle).length, 0)
})

test('pendingInteraction 出现 → kind:blocked 事件，粘性不重复，清除后再次触发', () => {
  const w = createWatcher()
  const idle = snapOf([{ id: 'a' }], 'a')
  w.diff(null, idle)
  const pending = snapOf([{ id: 'a', pending: true }], 'a')
  const events = w.diff(idle, pending)
  assert.equal(events.length, 1)
  assert.equal(events[0].sessionId, 'a')
  assert.equal(events[0].kind, 'blocked')
  // 粘性：pending 保持期间不重复
  assert.equal(w.diff(pending, snapOf([{ id: 'a', pending: true }], 'a')).length, 0)
  // 清除后可再次触发
  w.diff(pending, idle)
  const again = w.diff(idle, snapOf([{ id: 'a', pending: true }], 'a'))
  assert.equal(again.length, 1)
  assert.equal(again[0].kind, 'blocked')
})

test('首次快照已有 pendingInteraction 不补发（历史阻塞）', () => {
  const w = createWatcher()
  const events = w.diff(null, snapOf([{ id: 'a', pending: true }], 'a'))
  assert.equal(events.length, 0)
  // 之后清除再出现才触发
  const idle = snapOf([{ id: 'a' }], 'a')
  w.diff(snapOf([{ id: 'a', pending: true }], 'a'), idle)
  const events2 = w.diff(idle, snapOf([{ id: 'a', pending: true }], 'a'))
  assert.equal(events2.length, 1)
})

test('子代理的 pendingInteraction 被过滤', () => {
  const w = createWatcher()
  const idle = snapOf([{ id: 'root' }, { id: 'sub', origin: 'subagent' }], 'root')
  w.diff(null, idle)
  const events = w.diff(idle, snapOf([{ id: 'root', pending: true }, { id: 'sub', pending: true, origin: 'subagent' }], 'root'))
  assert.equal(events.length, 1)
  assert.equal(events[0].sessionId, 'root')
})
