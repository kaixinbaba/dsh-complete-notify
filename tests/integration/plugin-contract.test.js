import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as host from 'dsh-complete-notify'

const packageName = 'dsh-complete-notify'

function makeHostFixture() {
  const listeners = new Map()
  const effects = []
  const routes = []
  const llm = {
    stream: async function* () {
      yield { type: 'text-delta', text: '确定的测试小结' }
    },
  }
  const services = {
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake-model' }) },
  }
  const webServer = {
    register(route) {
      routes.push(route)
      return () => routes.splice(routes.indexOf(route), 1)
    },
  }
  const ctx = {
    on(event, listener) {
      listeners.set(event, listener)
      const dispose = () => listeners.delete(event)
      effects.push(dispose)
      return dispose
    },
    inject(_deps, callback) {
      callback(hostCtx)
    },
    get(service) {
      return services[service]
    },
    effect(effect) {
      const dispose = effect()
      if (typeof dispose === 'function') effects.push(dispose)
      return dispose
    },
  }
  const hostCtx = { ...ctx, webServer }
  return {
    ctx,
    listeners,
    routes,
    dispose() { for (const dispose of effects.splice(0)) dispose() },
  }
}

async function responseFor(route, method, url) {
  const result = { status: null, headers: null, body: '' }
  const response = {
    writeHead(status, headers) { result.status = status; result.headers = headers },
    end(body = '') { result.body += body },
  }
  await route.handler({ method, url }, response)
  return { ...result, json: result.body ? JSON.parse(result.body) : null }
}

test('contract: real host export has canonical shape', () => {
  assert.equal(host.name, packageName)
  assert.equal(typeof host.apply, 'function')
  assert.equal('default' in host, false)
})

test('contract: patch inserts this package exactly once', () => {
  const patch = readFileSync(new URL('../../cordis.patch.yml', import.meta.url), 'utf8')
  assert.equal((patch.match(/^- insert:/gm) ?? []).length, 1)
  assert.deepEqual([...patch.matchAll(/^\s+- id:\s*([^\s#]+)/gm)].map((m) => m[1]), ['complete-notify'])
  assert.match(patch, new RegExp(String.raw`name:\s*[\"']?${packageName}`))
})

test('contract: real client executes module-loader handoff', () => {
  let handoff
  const source = readFileSync(new URL('../../client/client.js', import.meta.url), 'utf8')
  new Function('window', source)({ __ModuleLoader__: { load(value) { handoff = value } } })
  assert.equal(handoff.id, packageName)
  const React = { createElement: (...args) => args, useState: (v) => [v, () => {}], useEffect() {}, useRef: (v) => ({ current: v }) }
  const bundle = handoff.factory((id) => { if (id === 'react') return React; throw new Error(id) })
  assert.equal(typeof bundle.apply, 'function')
  assert.equal(bundle.name, packageName)
})

test('host apply wires listeners and recap route with protocol handling', async () => {
  const fixture = makeHostFixture()
  host.apply(fixture.ctx)
  assert.deepEqual([...fixture.listeners.keys()].sort(), ['agent/status', 'session/event'])
  assert.equal(fixture.routes.length, 1)
  assert.equal(fixture.routes[0].kind, 'exact')
  assert.equal(fixture.routes[0].path, '/dsh-complete-notify/recap')

  fixture.listeners.get('session/event')({ header: { id: 'session-1' } }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  const session = { header: { id: 'session-1' }, events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成测试任务' }] } } }] }
  fixture.listeners.get('agent/status')({ status: 'idle', agent: { id: 'session-1', session } })
  await new Promise((resolve) => setImmediate(resolve))
  const get = await responseFor(fixture.routes[0], 'GET', '/dsh-complete-notify/recap?sessionId=session-1')
  assert.equal(get.status, 200)
  assert.deepEqual(get.json, { ok: true, recap: '确定的测试小结', kind: 'completed' })
  const post = await responseFor(fixture.routes[0], 'POST', '/dsh-complete-notify/recap')
  assert.equal(post.status, 405)
  assert.equal(post.headers.allow, 'GET')
  fixture.dispose()
  assert.equal(fixture.routes.length, 0)
  assert.equal(fixture.listeners.size, 0)
})
