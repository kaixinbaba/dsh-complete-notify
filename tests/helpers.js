// 在 Node 中加载同一份 client/client.js：
//   - stub `window.__ModuleLoader__` 捕获工厂；
//   - stub `require('react')` 提供无操作 hooks；
//   - 工厂顶层只定义函数/常量、不做 DOM 访问，因此可安全执行；
//   - 通过 exports.__test 拿到纯状态机 createWatcher。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('../client/client.js', import.meta.url)), 'utf8')

let handoff = null
const windowStub = {
  __ModuleLoader__: {
    load: (h) => { handoff = h },
  },
}

const run = new Function('window', source)
run(windowStub)

if (handoff === null) throw new Error('client bundle did not register a factory')

const requireStub = (spec) => {
  if (spec === 'react') {
    return {
      createElement: (...args) => args,
      Fragment: Symbol('fragment'),
      useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
      useEffect: () => {},
      useRef: (init) => ({ current: init }),
    }
  }
  throw new Error('unexpected require in test: ' + spec)
}

const bundle = handoff.factory(requireStub)

export const createWatcher = bundle.__test.createWatcher
export const summarizeRun = bundle.__test.summarizeRun
export const formatDuration = bundle.__test.formatDuration
export const formatTokens = bundle.__test.formatTokens
export const buildStatsLine = bundle.__test.buildStatsLine
export const cleanRecap = bundle.__test.cleanRecap
export const lastAnswerText = bundle.__test.lastAnswerText
export const inferKind = bundle.__test.inferKind
export const kindMeta = bundle.__test.kindMeta
export const emitTest = bundle.__test.emitTest
export const onTest = bundle.__test.onTest

/** 简体中文文案 stub（t('key') → 值）。 */
export const tZh = (key) => ({
  unitMin: '分',
  unitSec: '秒',
  doneTitle: '任务完成',
  blockedTitle: '等待你的反馈',
  abortedTitle: '任务已中断',
  errorTitle: '任务失败',
  maxTokensTitle: '达到 token 上限',
})[key] ?? key

/** 构造会话列表快照（SessionListState 的最小形态）。 */
export function snapOf(entries, current) {
  const ids = []
  const byId = {}
  for (const e of entries) {
    ids.push(e.id)
    byId[e.id] = {
      id: e.id,
      displayTitle: e.title || e.id,
      running: e.running === true,
      ...(e.completed === true ? { completed: true } : {}),
      ...(e.origin ? { origin: e.origin } : {}),
    }
  }
  return { ids, byId, current }
}
