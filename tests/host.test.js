import { test } from 'node:test'
import assert from 'node:assert/strict'
import { __test } from '../lib/index.js'

const { cleanRecap, lastAnswerText } = __test

test('host cleanRecap：去 markdown 噪音 + 折叠空白', () => {
  assert.equal(cleanRecap('  **修复** 了 `登录` bug  '), '修复 了 登录 bug')
})

test('host cleanRecap：链接转链接文字', () => {
  assert.equal(cleanRecap('见 [README](https://x) 文档'), '见 README 文档')
})

test('host cleanRecap：空 / 纯空白返回空串', () => {
  assert.equal(cleanRecap(''), '')
  assert.equal(cleanRecap('   '), '')
  assert.equal(cleanRecap(undefined), '')
})

test('host cleanRecap：超过 50 字截断加省略号', () => {
  const out = cleanRecap('结'.repeat(60))
  assert.equal(out.length, 50 + 1)
  assert.ok(out.endsWith('…'))
})

test('host lastAnswerText：倒序取最后一条 assistant/message 的纯文本', () => {
  const session = {
    events: [
      { type: 'user/message', data: {} },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一轮回答' }] } } },
      { type: 'tool/call', data: {} },
      {
        type: 'assistant/message',
        data: {
          message: {
            content: [
              { type: 'text', text: '最终回答第一段' },
              { type: 'tool-call', callId: 'c', name: 'bash', argsRaw: '{}' },
              { type: 'text', text: '最终回答第二段' },
            ],
          },
        },
      },
    ],
  }
  assert.equal(lastAnswerText(session), '最终回答第一段\n最终回答第二段')
})

test('host lastAnswerText：无 assistant 文本返回空串', () => {
  assert.equal(lastAnswerText({ events: [] }), '')
  assert.equal(lastAnswerText(null), '')
  assert.equal(lastAnswerText({ events: [{ type: 'user/message', data: {} }] }), '')
})
