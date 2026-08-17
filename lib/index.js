// Host half of dsh-complete-notify.
//
// 职责：任务完成（根 agent 回到 idle）时，异步调用 LLM 生成 ≤50 字的
// 「小结」（recap），缓存到内存；通过 webserver 路由
//   GET /dsh-complete-notify/recap?sessionId=<id> → { ok, recap: string|null }
// 供客户端在 toast 显示时拉取（客户端先显示「回答前 50 字」的降级小结，
// LLM 小结就绪后升级）。
//
// 纯函数（cleanRecap / lastAnswerText）通过 exports.__test 暴露给
// node --test 单测（tests/host.test.js 直接 import 本模块）。

export const name = 'dsh-complete-notify'

const RECAP_MAX = 50
const RECAP_CACHE_MAX = 200

/** sessionId -> recap 文本 */
const recaps = new Map()

/** 清洗文本为 ≤50 字的一句话小结（去 markdown 噪音、折叠空白、截断加省略号）。 */
function cleanRecap(text) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  let s = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接 → 链接文字
    .replace(/[#>*`~_|]/g, ' ')              // markdown 噪音
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= RECAP_MAX) return s
  return s.slice(0, RECAP_MAX) + '…'
}

/** 从会话事件里倒序取最后一条 assistant/message 的纯文本内容。 */
function lastAnswerText(session) {
  const events = (session && session.events) || []
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (!ev || ev.type !== 'assistant/message') continue
    const data = ev.data
    const msg = data && data.message
    if (!msg || !Array.isArray(msg.content)) continue
    const texts = msg.content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

async function computeRecap(ctx, sessionId, answer) {
  try {
    const llm = ctx.get('llm')
    const defaultModel = ctx.get('agentDefaultModel')
    if (llm === undefined || defaultModel === undefined) return
    const sel = defaultModel.currentSelection()
    if (!sel || typeof sel.provider !== 'string' || typeof sel.model !== 'string') return
    const prompt = '请用不超过50个字的一句话小结以下任务的完成结果，直接给小结本身，不要任何前缀、引号或解释：\n\n' + answer
    const messages = [{
      id: 'complete-notify-recap-' + sessionId + '-' + Date.now(),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }]
    let out = ''
    for await (const chunk of llm.stream({
      provider: sel.provider,
      model: sel.model,
      messages,
      temperature: 0.2,
      maxTokens: 100,
    })) {
      if (chunk.type === 'text-delta') out += chunk.text
      if (out.length > 200) break
    }
    const recap = cleanRecap(out)
    if (recap) {
      recaps.set(sessionId, recap)
      if (recaps.size > RECAP_CACHE_MAX) {
        const oldest = recaps.keys().next().value
        recaps.delete(oldest)
      }
    }
  } catch (err) {
    // 静默：小结失败不影响提醒
  }
}

function sendJson(response, status, payload) {
  try {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(payload))
  } catch (err) {
    /* 连接已关闭等 */
  }
}

export function apply(ctx) {
  // 1) 根 agent 空闲（整轮运行结束）时，为对应会话异步生成 recap（一次运行一次调用）
  ctx.on('agent/status', (payload) => {
    if (!payload || payload.status !== 'idle') return
    const agent = payload.agent
    if (!agent) return
    const session = agent.session
    if (!session) return
    if (session.header && session.header.origin === 'subagent') return
    const sessionId = agent.id || (session.header && session.header.id)
    if (!sessionId) return
    const answer = lastAnswerText(session)
    if (!answer) return
    computeRecap(ctx, sessionId, answer)
  })

  // 2) 客户端拉取小结的路由
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-complete-notify/recap',
      handler: async (request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' })
          response.end()
          return
        }
        try {
          const url = new URL(request.url || '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId') || ''
          const recap = recaps.get(sessionId) || null
          sendJson(response, 200, { ok: true, recap })
        } catch (err) {
          sendJson(response, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
        }
      },
    }), 'dsh-complete-notify: recap route')
  }
}

// 单测钩子（宿主加载器会忽略额外导出）
export const __test = { cleanRecap, lastAnswerText }
