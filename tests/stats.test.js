import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeRun, formatDuration, formatTokens, buildStatsLine, cleanRecap, lastAnswerText, inferKind, kindMeta, tZh } from './helpers.js'

/** 构造最小会话快照。 */
function snap({ timings, nodes }) {
  const turnTimings = new Map()
  if (timings) for (const [turn, tm] of Object.entries(timings)) turnTimings.set(Number(turn), tm)
  return { turnTimings, nodes: nodes ?? [] }
}

function assistant({ turn, tokens, toolCalls = 0 }) {
  const blocks = []
  for (let i = 0; i < toolCalls; i++) blocks.push({ kind: 'tool-call', callId: 'c' + i, name: 'bash', argsRaw: '{}' })
  if (blocks.length === 0) blocks.push({ kind: 'text', text: 'ok' })
  return {
    kind: 'assistant', turn, seq: 1, time: 0, step: 1, blocks,
    ...(tokens ? { usage: { inputTokens: tokens.in, outputTokens: tokens.out } } : {}),
  }
}

test('summarizeRun：取最后一轮，汇总时长/token/steps', () => {
  const s = snap({
    timings: {
      1: { startTime: 1000, endTime: 6000 },      // 5s
      2: { startTime: 6000, endTime: 13000 },     // 7s —— 应选中这轮
    },
    nodes: [
      assistant({ turn: 1, tokens: { in: 100, out: 50 }, toolCalls: 1 }),
      assistant({ turn: 2, tokens: { in: 300, out: 120 }, toolCalls: 3 }),
      assistant({ turn: 2, tokens: { in: 80, out: 40 } }),
    ],
  })
  const r = summarizeRun(s)
  assert.equal(r.durationMs, 7000)
  assert.equal(r.tokens, 300 + 120 + 80 + 40)
  assert.equal(r.steps, 3)
})

test('summarizeRun：无 usage 时 tokens 为 0，不影响 steps', () => {
  const s = snap({ timings: { 1: { startTime: 0, endTime: 2000 } }, nodes: [assistant({ turn: 1, toolCalls: 2 })] })
  const r = summarizeRun(s)
  assert.equal(r.tokens, 0)
  assert.equal(r.steps, 2)
})

test('summarizeRun：无已结束 timing 时退回最大 turn，durationMs 为 null', () => {
  const s = snap({
    timings: { 1: { startTime: 0 } }, // 无 endTime
    nodes: [assistant({ turn: 3, tokens: { in: 10, out: 5 } })],
  })
  const r = summarizeRun(s)
  assert.equal(r.durationMs, null)
  assert.equal(r.tokens, 15)
  assert.equal(r.steps, 0)
})

test('summarizeRun：空快照/无节点返回 null', () => {
  assert.equal(summarizeRun(null), null)
  assert.equal(summarizeRun({ turnTimings: new Map(), nodes: [] }), null)
})

test('formatDuration / formatTokens', () => {
  assert.equal(formatDuration(30_000, tZh), '30秒')
  assert.equal(formatDuration(125_000, tZh), '2分 5秒')
  assert.equal(formatDuration(120_000, tZh), '2分')
  assert.equal(formatDuration(null, tZh), null)
  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1234), '1.2k')
  assert.equal(formatTokens(2000), '2k')
})

test('buildStatsLine：按可用字段拼接', () => {
  const line = buildStatsLine({ durationMs: 125_000, tokens: 1234, steps: 3 }, tZh)
  assert.equal(line, '⏱ 2分 5秒 · ⚡ 1.2k tokens · 🔧 3 steps')
  assert.equal(buildStatsLine({ tokens: 0, steps: 0, durationMs: null }, tZh), '')
  assert.equal(buildStatsLine(null, tZh), '')
})

test('client cleanRecap：清洗 + 50 字截断', () => {
  assert.equal(cleanRecap('**完成** 了登录修复。'), '完成 了登录修复。')
  assert.equal(cleanRecap('见 [链接](https://x)'), '见 链接')
  assert.equal(cleanRecap(''), '')
  const out = cleanRecap('好'.repeat(80))
  assert.equal(out.length, 51)
  assert.ok(out.endsWith('…'))
})

test('client lastAnswerText：取快照最后一条 assistant 消息文本', () => {
  const snapshot = {
    nodes: [
      { kind: 'assistant', turn: 1, blocks: [{ kind: 'text', text: '第一轮' }] },
      { kind: 'tool-call', turn: 1, callId: 'c', name: 'bash' },
      { kind: 'assistant', turn: 1, blocks: [{ kind: 'tool-call', callId: 'c2', name: 'read' }, { kind: 'text', text: '最终回答' }] },
    ],
  }
  assert.equal(lastAnswerText(snapshot), '最终回答')
  assert.equal(lastAnswerText({ nodes: [] }), '')
  assert.equal(lastAnswerText(null), '')
})

test('client inferKind：按最后一轮节点推断状态', () => {
  const node = (kind, extra = {}) => Object.assign({ kind, turn: 1, seq: 1, time: 0 }, extra)
  assert.equal(inferKind({ nodes: [node('turn-error', { message: 'x' })] }), 'error')
  assert.equal(inferKind({ nodes: [node('turn-max-tokens')] }), 'max-tokens')
  assert.equal(inferKind({ nodes: [node('assistant', { blocks: [], interrupted: true })] }), 'aborted')
  assert.equal(inferKind({ nodes: [node('assistant', { blocks: [] })] }), 'unknown')
  assert.equal(inferKind({ nodes: [] }), 'unknown')
  assert.equal(inferKind(null), 'unknown')
})

test('client kindMeta：completed 兜底 + 各状态颜色', () => {
  assert.equal(kindMeta('completed', tZh).label, '任务完成')
  assert.equal(kindMeta('blocked', tZh).label, '等待你的反馈')
  assert.equal(kindMeta('blocked', tZh).color, '#facc15')
  assert.equal(kindMeta('aborted', tZh).color, '#f87171')
  assert.equal(kindMeta('unknown', tZh).label, '任务完成') // 兜底 completed
  assert.equal(kindMeta(undefined, tZh).color, '#4ade80')
})
