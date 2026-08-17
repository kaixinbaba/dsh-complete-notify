window.__ModuleLoader__.load({ id: "dsh-complete-notify", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
'use strict'

/**
 * dsh-complete-notify client:
 *
 * 任务完成时给「音效 + 小弹窗」提醒，纯浏览器方案：
 *   - 完成检测：shell.overlay 的标准 prop `useSessions`（会话列表快照，
 *     每条会话带 running / completed / current，与官方运行指示灯同源）；
 *   - 音效：Web Audio API 合成双音「叮咚」，零音频文件（首次用户手势解锁）；
 *   - 页面可见 → 右上角 toast；页面在后台 → 系统通知（Web Notification）
 *     + 标题闪烁兜底；
 *   - 设置页：设置 → 任务完成通知（总开关/音效/系统通知/音量/测试按钮），
 *     localStorage 持久化。
 *
 * 完成检测是一个纯状态机（createWatcher），通过 exports.__test 暴露给
 * node --test 单测（tests/ 下用 stub window/require 执行本文件）。
 */

const React = require('react')
const h = React.createElement
const { useState, useEffect, useRef } = React

const NS = 'complete-notify'
const STORAGE_KEY = 'dsh.completeNotify.v1'
const DEFAULT_CFG = { enabled: true, sound: true, systemNotify: true, volume: 0.6 }
const TOAST_MS = 5000       // 页面可见时的 toast 停留
const TOAST_MS_BG = 30000   // 后台完成、用户稍后回来也能看到的停留
const MAX_TOASTS = 3

// ---------- 文案（zh/en，经 locale 服务注册） ----------
const zh = {
  navLabel: '任务完成通知',
  overlayLabel: '任务完成通知',
  doneTitle: '任务完成',
  blockedTitle: '等待你的反馈',
  abortedTitle: '任务已中断',
  errorTitle: '任务失败',
  maxTokensTitle: '达到 token 上限',
  close: '关闭',
  clickHint: '点击打开会话',
  testBody: '这是一条测试通知',
  intro: '任务完成时播放提示音并弹出小通知；页面在后台时改用系统通知。设置保存在当前浏览器。',
  enableLabel: '启用提醒',
  soundLabel: '提示音',
  systemLabel: '系统通知（页面在后台时）',
  volumeLabel: '音量',
  unitMin: '分',
  unitSec: '秒',
  testSound: '测试音效',
  testNotify: '测试通知',
  testPreview: '状态预览',
  testComplete: '测试完成',
  testBlocked: '测试阻塞',
  testAborted: '测试中断',
  testToastTitle: '测试会话',
  testToastRecap: '这是一条测试小结，用于预览不同状态的提醒效果。',
  permGranted: '系统通知权限：已授权',
  permDenied: '系统通知权限：已拒绝（在浏览器地址栏左侧的站点设置中开启）',
  permDefault: '系统通知权限：未授权 —— 点击「测试通知」完成授权',
  permUnsupported: '当前浏览器不支持系统通知',
}
const en = {
  navLabel: 'Completion Notify',
  overlayLabel: 'Completion Notify',
  doneTitle: 'Task completed',
  blockedTitle: 'Waiting for your input',
  abortedTitle: 'Task interrupted',
  errorTitle: 'Task failed',
  maxTokensTitle: 'Token limit reached',
  close: 'Close',
  clickHint: 'Click to open session',
  testBody: 'This is a test notification',
  intro: 'Play a sound and show a small popup when a task completes (a system notification while the page is in the background). Settings persist in this browser.',
  enableLabel: 'Enable alerts',
  soundLabel: 'Sound',
  systemLabel: 'System notification (page in background)',
  volumeLabel: 'Volume',
  unitMin: 'm',
  unitSec: 's',
  testSound: 'Test sound',
  testNotify: 'Test notification',
  testPreview: 'State preview',
  testComplete: 'Test completed',
  testBlocked: 'Test blocked',
  testAborted: 'Test interrupted',
  testToastTitle: 'Test session',
  testToastRecap: 'A test recap to preview the state color.',
  permGranted: 'Notification permission: granted',
  permDenied: 'Notification permission: denied (enable it in the site settings beside the address bar)',
  permDefault: 'Notification permission: not granted — click "Test notification" to grant it',
  permUnsupported: 'This browser does not support system notifications',
}

// ---------- 配置（localStorage 持久化） ----------
function getCfg() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return Object.assign({}, DEFAULT_CFG)
    return Object.assign({}, DEFAULT_CFG, JSON.parse(raw))
  } catch (err) {
    return Object.assign({}, DEFAULT_CFG)
  }
}
function setCfg(patch) {
  const next = Object.assign({}, getCfg(), patch)
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch (err) {}
  return next
}

// ---------- 完成检测状态机（纯逻辑，可单测） ----------
//
// 输入：上一次 / 本次会话列表快照（{ ids, byId, current }）。
// 输出：本次应该提醒的完成事件 [{ sessionId, title, selected }]。
//
// 规则：
//  1. 会话 running: true → false 边缘 = 完成（当前选中会话的完成只有这条信号）；
//  2. `completed` 粘性标记出现 = 「未选中时完成」的兜底信号（运行时保证只在
//     非选中会话上置位、选中后清除）；
//  3. `pendingInteraction` 出现（提问/审批挂起）= 阻塞，发出 kind: 'blocked'
//     事件（agent 可能仍在运行等待，不能只靠 running 边缘）；
//  4. 首次快照（prev == null）只初始化、不触发（不补发历史完成/历史阻塞）；
//  5. notified / pending 集合按 sessionId 去重；会话重新 running 时重置，
//     允许下次再提醒；阻塞清除后可再次触发；
//  6. origin === 'subagent' 的子代理会话过滤。
function createWatcher() {
  const state = new Map() // sessionId -> { wasRunning, notified, pending }
  return {
    diff(prev, next) {
      const events = []
      if (next === null || next === undefined) return events
      const byId = next.byId || {}
      const ids = next.ids || []
      const current = next.current
      const seen = new Set()
      for (const id of ids) {
        seen.add(id)
        const entry = byId[id]
        if (entry === undefined) continue
        if (entry.origin === 'subagent') continue
        let st = state.get(id)
        if (st === undefined) st = { wasRunning: false, notified: false, pending: false }
        if (entry.running === true) {
          // 重新开跑 = 新的完成周期
          st.wasRunning = true
          st.notified = false
        } else if (prev === null || prev === undefined) {
          // 首次快照：初始化；已粘性完成的旧任务预标记为已通知
          st.wasRunning = false
          if (entry.completed === true) st.notified = true
        } else {
          const justFinished = st.wasRunning === true
          st.wasRunning = false
          if (st.notified === false && (justFinished || entry.completed === true)) {
            st.notified = true
            events.push({
              sessionId: id,
              title: entry.displayTitle || id,
              selected: id === current,
            })
          }
        }
        // 阻塞边缘：pendingInteraction 出现 → 等待反馈（提问/审批挂起）
        const pending = entry.pendingInteraction !== undefined && entry.pendingInteraction !== null
        if (prev === null || prev === undefined) {
          st.pending = pending // 首次快照只记录，不补发历史阻塞
        } else if (pending && !st.pending) {
          st.pending = true
          events.push({
            sessionId: id,
            title: entry.displayTitle || id,
            selected: id === current,
            kind: 'blocked',
          })
        } else if (!pending && st.pending) {
          st.pending = false
        }
        state.set(id, st)
      }
      // 清理已从列表消失的会话
      for (const id of Array.from(state.keys())) if (!seen.has(id)) state.delete(id)
      return events
    },
  }
}

// ---------- 音效（Web Audio 合成，零音频文件） ----------
let audioCtx = null
function ensureAudio() {
  if (audioCtx === null) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (Ctor === undefined) return null
    try { audioCtx = new Ctor() } catch (err) { audioCtx = null }
  }
  return audioCtx
}
/** 在用户手势里调用：创建/恢复 AudioContext（Chromium 自动播放策略的标准解锁法）。 */
function unlockAudio() {
  const ctx = ensureAudio()
  if (ctx === null) return
  if (ctx.state === 'suspended') { try { ctx.resume() } catch (err) {} }
}
/** 合成双音「叮咚」（880Hz → 1174.66Hz，指数衰减包络）。失败静默。 */
function chime(volume) {
  const vol = typeof volume === 'number' && volume >= 0 && volume <= 1 ? volume : 0.6
  const ctx = ensureAudio()
  if (ctx === null) return
  const play = () => {
    try {
      const t0 = ctx.currentTime
      const master = ctx.createGain()
      master.gain.setValueAtTime(vol, t0)
      master.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.7)
      master.connect(ctx.destination)
      const notes = [
        { freq: 880.0, start: 0.0, dur: 0.4 },
        { freq: 1174.66, start: 0.13, dur: 0.5 },
      ]
      for (const n of notes) {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(n.freq, t0 + n.start)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, t0 + n.start)
        g.gain.exponentialRampToValueAtTime(0.5, t0 + n.start + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + n.start + n.dur)
        osc.connect(g)
        g.connect(master)
        osc.start(t0 + n.start)
        osc.stop(t0 + n.start + n.dur + 0.05)
      }
    } catch (err) { /* 静默：音效失败不影响通知 */ }
  }
  if (ctx.state === 'suspended') {
    ctx.resume().then(() => { if (ctx.state === 'running') play() }).catch(() => {})
  } else {
    play()
  }
}

// ---------- 系统通知（Web Notification API） ----------
function notificationSupported() {
  return typeof window !== 'undefined' && 'Notification' in window
}
function notificationPermission() {
  if (!notificationSupported()) return 'unsupported'
  return window.Notification.permission
}
function requestPermission() {
  if (!notificationSupported()) return Promise.resolve('unsupported')
  try { return window.Notification.requestPermission() } catch (err) { return Promise.resolve('denied') }
}
/** 发送系统通知；未授权/不支持时返回 false（调用方降级）。 */
function showSystemNotification(opts) {
  if (!notificationSupported() || window.Notification.permission !== 'granted') return false
  try {
    const n = new window.Notification(opts.title, {
      body: opts.body,
      tag: 'dsh-complete-' + opts.tag,
      silent: opts.silent === true,
    })
    if (opts.onClick) {
      n.onclick = () => {
        try { window.focus() } catch (err) {}
        opts.onClick()
      }
    }
    return true
  } catch (err) {
    return false
  }
}

// ---------- 标题闪烁（后台且无系统通知时的兜底） ----------
let titleFlashTimer = null
let titleFlashOriginal = ''
function flashTitle(mark) {
  if (typeof document === 'undefined' || titleFlashTimer !== null) return
  titleFlashOriginal = document.title
  let count = 0
  titleFlashTimer = setInterval(() => {
    count += 1
    document.title = count % 2 === 1 ? mark + ' · ' + titleFlashOriginal : titleFlashOriginal
    if (count >= 6) {
      clearInterval(titleFlashTimer)
      titleFlashTimer = null
      document.title = titleFlashOriginal
    }
  }, 700)
}
function stopTitleFlash() {
  if (titleFlashTimer !== null) {
    clearInterval(titleFlashTimer)
    titleFlashTimer = null
    document.title = titleFlashOriginal
  }
}

// ---------- 运行统计（从会话快照提取时长 / token / steps，纯逻辑可单测） ----------
//
// 数据来源（ConversationSnapshot）：
//   - turnTimings: Map<turn, { startTime, endTime? }> → 最后一轮时长
//   - nodes: 会话节点，assistant 节点带 blocks（含 tool-call）与 usage
//   - usage 结构：{ inputTokens, outputTokens, cacheReadTokens?, ... }
// 统计口径：取「最后一轮」（turn 号最大的已结束轮次）——单轮任务即为本次运行。
function summarizeRun(snapshot) {
  if (snapshot === null || snapshot === undefined) return null
  const timings = snapshot.turnTimings
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : []

  let lastTurn = -1
  let lastTiming = null
  if (timings && typeof timings.forEach === 'function') {
    timings.forEach((tm, turn) => {
      if (typeof turn === 'number' && tm && typeof tm.endTime === 'number' && turn > lastTurn) {
        lastTurn = turn
        lastTiming = tm
      }
    })
  }
  if (lastTurn < 0) {
    for (const n of nodes) {
      if (n && typeof n.turn === 'number' && n.turn > lastTurn) lastTurn = n.turn
    }
  }
  if (lastTurn < 0) return null

  let tokens = 0
  let steps = 0
  for (const n of nodes) {
    if (!n || n.turn !== lastTurn) continue
    if (n.kind === 'assistant' && Array.isArray(n.blocks)) {
      for (const b of n.blocks) {
        if (b && b.kind === 'tool-call') steps += 1
      }
      if (n.usage && typeof n.usage === 'object') {
        const u = n.usage
        tokens += typeof u.inputTokens === 'number' ? u.inputTokens : 0
        tokens += typeof u.outputTokens === 'number' ? u.outputTokens : 0
      }
    }
  }
  const durationMs = lastTiming ? lastTiming.endTime - lastTiming.startTime : null
  return { durationMs, tokens, steps }
}

function formatDuration(ms, t) {
  if (ms === null || ms === undefined || !isFinite(ms) || ms < 0) return null
  const total = Math.round(ms / 1000)
  if (total < 60) return total + t('unitSec')
  const m = Math.floor(total / 60)
  const r = total % 60
  return r === 0 ? m + t('unitMin') : m + t('unitMin') + ' ' + r + t('unitSec')
}

function formatTokens(n) {
  if (n === null || n === undefined || !isFinite(n)) return null
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(n)
}

function buildStatsLine(stats, t) {
  if (!stats) return ''
  const parts = []
  const dur = formatDuration(stats.durationMs, t)
  if (dur !== null) parts.push('⏱ ' + dur)
  if (typeof stats.tokens === 'number' && stats.tokens > 0) parts.push('⚡ ' + formatTokens(stats.tokens) + ' tokens')
  if (typeof stats.steps === 'number' && stats.steps > 0) parts.push('🔧 ' + stats.steps + ' steps')
  return parts.join(' · ')
}

function lastAnswerText(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes)) return ''
  const nodes = snapshot.nodes
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n && n.kind === 'assistant' && Array.isArray(n.blocks)) {
      const texts = []
      for (const b of n.blocks) if (b && b.kind === 'text' && typeof b.text === 'string') texts.push(b.text)
      if (texts.length > 0) return texts.join(' ')
    }
  }
  return ''
}

function cleanRecap(text, max) {
  if (typeof text !== 'string' || text.trim() === '') return ''
  let s = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接 → 链接文字
    .replace(/[#>*`~_|]/g, ' ')              // markdown 噪音
    .replace(/\s+/g, ' ')
    .trim()
  const limit = typeof max === 'number' && max > 0 ? max : 50
  if (s.length <= limit) return s
  return s.slice(0, limit) + '…'
}

/** 一次快照读取同时取运行统计、最后回答文本与推断结果状态。 */
function collectRunInfo(sessions, sessionId) {
  if (sessions === undefined || typeof sessions.binding !== 'function') return null
  try {
    const binding = sessions.binding(sessionId)
    if (!binding || !binding.session || typeof binding.session.getSnapshot !== 'function') return null
    const snapshot = binding.session.getSnapshot()
    return { stats: summarizeRun(snapshot), answer: lastAnswerText(snapshot), kind: inferKind(snapshot) }
  } catch (err) {
    return null
  }
}

/** 结果状态元数据：颜色/图标/文案 key（fallback 一律 completed）。 */
const KIND_META = {
  completed: { key: 'doneTitle', color: '#4ade80', icon: '✓' },
  blocked: { key: 'blockedTitle', color: '#facc15', icon: '⚠' },
  aborted: { key: 'abortedTitle', color: '#f87171', icon: '✕' },
  error: { key: 'errorTitle', color: '#f87171', icon: '✕' },
  'max-tokens': { key: 'maxTokensTitle', color: '#fb923c', icon: '⚠' },
}
function kindMeta(kind, t) {
  const m = KIND_META[kind] || KIND_META.completed
  return { label: t(m.key), color: m.color, icon: m.icon }
}

/**
 * 客户端推断结果状态（Host 不可达时的兜底）：最后一轮出现 turn-error /
 * turn-max-tokens 节点或被打断的 assistant 消息。
 */
function inferKind(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.nodes)) return 'unknown'
  let lastTurn = -1
  for (const n of snapshot.nodes) {
    if (n && typeof n.turn === 'number' && n.turn > lastTurn) lastTurn = n.turn
  }
  if (lastTurn < 0) return 'unknown'
  let hasError = false
  let hasMaxTokens = false
  let interrupted = false
  for (const n of snapshot.nodes) {
    if (!n || n.turn !== lastTurn) continue
    if (n.kind === 'turn-error') hasError = true
    if (n.kind === 'turn-max-tokens') hasMaxTokens = true
    if (n.kind === 'assistant' && n.interrupted === true) interrupted = true
  }
  if (hasError) return 'error'
  if (hasMaxTokens) return 'max-tokens'
  if (interrupted) return 'aborted'
  return 'unknown'
}

/** 从 Host 拉取小结 + 结果状态（webserver 路由），失败返回 null。 */
async function fetchInfo(sessionId) {
  try {
    const res = await fetch('/dsh-complete-notify/recap?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' })
    if (!res.ok) return null
    const data = await res.json()
    if (!data) return null
    return {
      kind: typeof data.kind === 'string' && data.kind !== '' ? data.kind : null,
      recap: typeof data.recap === 'string' && data.recap !== '' ? data.recap : '',
    }
  } catch (err) {
    return null
  }
}

// ---------- 状态预览（设置页 → ToastHost 的模块级事件） ----------
const testListeners = []
function emitTest(kind) {
  for (const fn of testListeners.slice()) {
    try { fn(kind) } catch (err) {}
  }
}
function onTest(fn) {
  testListeners.push(fn)
  return () => {
    const i = testListeners.indexOf(fn)
    if (i >= 0) testListeners.splice(i, 1)
  }
}

// ---------- Toast 组件 ----------
function ToastItem(props) {
  const { toast, index, onClose, onOpen, t } = props
  const meta = kindMeta(toast.kind, t)
  const [phase, setPhase] = useState('enter') // enter -> shown -> leave
  useEffect(() => {
    const t1 = setTimeout(() => setPhase('shown'), 30)
    const t2 = setTimeout(() => setPhase('leave'), toast.duration)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [toast.duration])
  useEffect(() => {
    if (phase !== 'leave') return
    const t3 = setTimeout(onClose, 260)
    return () => clearTimeout(t3)
  }, [phase, onClose])

  const style = {
    position: 'fixed',
    top: 16 + index * 116,
    right: 16,
    width: 300,
    boxSizing: 'border-box',
    padding: '10px 12px',
    borderRadius: 10,
    borderLeft: '3px solid ' + meta.color,
    background: 'rgba(24, 27, 34, 0.97)',
    color: '#f2f4f8',
    boxShadow: '0 10px 28px rgba(0, 0, 0, 0.4)',
    fontFamily: 'inherit',
    fontSize: 13,
    lineHeight: 1.45,
    cursor: 'pointer',
    pointerEvents: 'auto', // shell.overlay 层默认点击穿透，需要显式恢复
    transition: 'opacity 240ms ease, transform 240ms ease',
    opacity: phase === 'shown' ? 1 : 0,
    transform: phase === 'shown' ? 'translateX(0)' : 'translateX(28px)',
    zIndex: 10000,
  }
  return h('div', { style, role: 'status', onClick: () => onOpen(toast) },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      h('span', { style: { color: meta.color, fontWeight: 700 } }, meta.icon),
      h('span', { style: { color: meta.color, fontWeight: 600, flex: 1 } }, meta.label),
      h('button', {
        title: t('close'),
        'aria-label': t('close'),
        onClick: (e) => { e.stopPropagation(); setPhase('leave') },
        style: {
          background: 'none', border: 'none', color: 'rgba(242,244,248,0.6)',
          cursor: 'pointer', fontSize: 15, lineHeight: 1, padding: '0 2px',
        },
      }, '×')),
    h('div', {
      style: {
        marginTop: 3, color: 'rgba(242,244,248,0.75)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      },
    }, toast.title),
    toast.recap
      ? h('div', { style: { marginTop: 4, color: 'rgba(242,244,248,0.85)', fontSize: 12, lineHeight: 1.4 } }, '💬 ' + toast.recap)
      : null,
    toast.statsLine
      ? h('div', { style: { marginTop: 4, color: '#7dd3a8', fontSize: 12, whiteSpace: 'nowrap' } }, toast.statsLine)
      : null,
    h('div', { style: { marginTop: 3, color: 'rgba(242,244,248,0.45)', fontSize: 11 } }, t('clickHint')),
  )
}

// useSessions 缺失时的兜底 hook（保持 hooks 无条件调用）
function useFallbackSnap() { return null }

/** 常驻挂载于 shell.overlay：订阅会话列表做完成检测，并渲染 toast 栈。 */
function ToastHost(props) {
  const select = typeof props.useSessions === 'function' ? props.useSessions : useFallbackSnap
  const snap = select((s) => s)
  const sessions = props.sessions
  const t = props.t
  const [toasts, setToasts] = useState([])
  const watcherRef = useRef(null)
  const prevRef = useRef(null)
  const tRef = useRef(t)
  tRef.current = t
  if (watcherRef.current === null) watcherRef.current = createWatcher()

  useEffect(() => () => stopTitleFlash(), [])

  // 状态预览：设置页按钮 → 弹一条对应状态的测试 toast
  useEffect(() => onTest((kind) => {
    const cfg = getCfg()
    if (cfg.enabled === false) return
    if (cfg.sound) chime(cfg.volume)
    pushTestToast(kind)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [])

  useEffect(() => {
    if (snap === null) return
    const events = watcherRef.current.diff(prevRef.current, snap)
    prevRef.current = snap
    if (events.length === 0) return
    const cfg = getCfg()
    if (cfg.enabled === false) return
    const visible = document.visibilityState === 'visible'
    let cancelled = false
    ;(async () => {
      for (const ev of events) {
        if (cancelled) return
        if (cfg.sound) chime(cfg.volume)
        const info = collectRunInfo(sessions, ev.sessionId)
        const statsLine = buildStatsLine(info ? info.stats : null, t)
        const fallbackRecap = cleanRecap(info ? info.answer : '')
        const eventKind = ev.kind || null // 阻塞事件自带 'blocked'
        const provisionalKind = eventKind || (info && info.kind) || 'completed'
        if (visible) {
          const key = pushToast(ev, statsLine, fallbackRecap, provisionalKind, TOAST_MS)
          refreshInfo(key, ev.sessionId)
        } else if (cfg.systemNotify) {
          // 系统通知发送后不可更新，先拉一次状态（本地路由，毫秒级）再发
          const info2 = await fetchInfo(ev.sessionId)
          if (cancelled) return
          const kind = eventKind || (info2 && info2.kind) || provisionalKind
          const meta = kindMeta(kind, t)
          const shown = showSystemNotification({
            title: meta.label,
            body: ev.title + (fallbackRecap ? '\n💬 ' + fallbackRecap : '') + (statsLine ? '\n' + statsLine : ''),
            tag: ev.sessionId,
            silent: Boolean(cfg.sound), // 音效由我们播放，避免系统通知双重出声
            onClick: () => openSession(ev.sessionId),
          })
          if (shown) flashTitle('⚠ ' + meta.label)
          else {
            const key = pushToast(ev, statsLine, fallbackRecap, kind, TOAST_MS_BG) // 系统通知不可达 → 长时 toast 兜底
            refreshInfo(key, ev.sessionId)
          }
        } else {
          flashTitle('⚠ ' + kindMeta(provisionalKind, t).label)
          const key = pushToast(ev, statsLine, fallbackRecap, provisionalKind, TOAST_MS_BG)
          refreshInfo(key, ev.sessionId)
        }
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap])

  function pushToast(ev, statsLine, fallbackRecap, kind, duration) {
    const key = ev.sessionId + ':' + Date.now()
    setToasts((prev) => {
      const tail = prev.slice(-(MAX_TOASTS - 1)) // 保留 N-1 条 + 新 1 条 = 最多 MAX_TOASTS 条
      return tail.concat([{ key, sessionId: ev.sessionId, title: ev.title, statsLine, recap: fallbackRecap || '', kind: kind || 'completed', duration }])
    })
    return key
  }

  /** 设置页「状态预览」：弹一条对应状态的测试 toast。 */
  function pushTestToast(kind) {
    const key = 'test:' + kind + ':' + Date.now()
    setToasts((prev) => {
      const tail = prev.slice(-(MAX_TOASTS - 1))
      return tail.concat([{
        key,
        sessionId: null,
        title: tRef.current('testToastTitle'),
        statsLine: '⏱ 12s · ⚡ 1.2k tokens · 🔧 3 steps',
        recap: tRef.current('testToastRecap'),
        kind,
        duration: TOAST_MS,
      }])
    })
  }

  /** 拉取 Host 的小结 + 结果状态升级 toast（0/1.5/3.5s 各试一次）。 */
  function refreshInfo(key, sessionId) {
    const apply = (info) => {
      if (!info) return
      setToasts((prev) => prev.map((item) => {
        if (item.key !== key) return item
        const patch = {}
        if (info.recap) patch.recap = info.recap
        if (info.kind) patch.kind = info.kind
        return Object.assign({}, item, patch)
      }))
    }
    fetchInfo(sessionId).then(apply)
    setTimeout(() => fetchInfo(sessionId).then(apply), 1500)
    setTimeout(() => fetchInfo(sessionId).then(apply), 3500)
  }
  function closeToast(key) {
    setToasts((prev) => prev.filter((item) => item.key !== key))
  }
  function openSession(id) {
    if (sessions === undefined || !id) return
    try { sessions.open(id) } catch (err) {}
  }

  return h(React.Fragment, null,
    toasts.map((toast, index) => h(ToastItem, {
      key: toast.key,
      toast,
      index,
      t,
      onClose: () => closeToast(toast.key),
      onOpen: (item) => openSession(item.sessionId),
    })),
  )
}

// ---------- 设置页（设置 → 任务完成通知） ----------
function Row(props) {
  return h('div', {
    style: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 0', borderBottom: '1px solid rgba(127,127,127,0.18)',
    },
  },
    h('span', { style: { fontSize: 13 } }, props.label),
    props.children)
}

function SettingsPage(props) {
  const t = props.t
  const [cfg, setCfgState] = useState(() => getCfg())
  const [perm, setPerm] = useState(() => notificationPermission())

  const update = (patch) => setCfgState(setCfg(patch))

  const permText = () => {
    if (perm === 'granted') return t('permGranted')
    if (perm === 'denied') return t('permDenied')
    if (perm === 'unsupported') return t('permUnsupported')
    return t('permDefault')
  }
  const testNotify = () => {
    requestPermission().then((p) => {
      setPerm(p)
      if (p === 'granted') {
        showSystemNotification({ title: t('doneTitle'), body: t('testBody'), tag: 'test', silent: true })
      }
    })
  }

  const btnStyle = {
    marginRight: 8, padding: '5px 12px', borderRadius: 6,
    border: '1px solid rgba(127,127,127,0.45)', background: 'transparent',
    color: 'inherit', cursor: 'pointer', fontSize: 12,
  }

  return h('div', { style: { padding: '6px 10px 20px', fontSize: 13, lineHeight: 1.6 } },
    h('p', { style: { margin: '0 0 4px', opacity: 0.75 } }, t('intro')),
    h(Row, { label: t('enableLabel') },
      h('input', { type: 'checkbox', checked: cfg.enabled !== false, onChange: (e) => update({ enabled: e.target.checked }) })),
    h(Row, { label: t('soundLabel') },
      h('input', { type: 'checkbox', checked: cfg.sound !== false, onChange: (e) => update({ sound: e.target.checked }) })),
    h(Row, { label: t('systemLabel') },
      h('input', { type: 'checkbox', checked: cfg.systemNotify !== false, onChange: (e) => update({ systemNotify: e.target.checked }) })),
    h(Row, { label: t('volumeLabel') },
      h('input', {
        type: 'range', min: 0, max: 100, value: Math.round((cfg.volume ?? DEFAULT_CFG.volume) * 100),
        onChange: (e) => update({ volume: Number(e.target.value) / 100 }),
        style: { width: 150 },
      })),
    h('div', { style: { padding: '12px 0 4px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
      h('button', { style: btnStyle, onClick: () => chime(cfg.volume) }, t('testSound')),
      h('button', { style: btnStyle, onClick: testNotify }, t('testNotify'))),
    h('div', { style: { padding: '8px 0 0', fontWeight: 600, fontSize: 12, opacity: 0.8 } }, t('testPreview')),
    h('div', { style: { padding: '8px 0 4px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 } },
      h('button', { style: Object.assign({}, btnStyle, { color: '#4ade80' }), onClick: () => emitTest('completed') }, t('testComplete')),
      h('button', { style: Object.assign({}, btnStyle, { color: '#facc15' }), onClick: () => emitTest('blocked') }, t('testBlocked')),
      h('button', { style: Object.assign({}, btnStyle, { color: '#f87171' }), onClick: () => emitTest('aborted') }, t('testAborted'))),
    h('p', { style: { margin: '10px 0 0', opacity: 0.7 } }, permText()),
  )
}

// ---------- 插件入口 ----------
exports.name = 'dsh-complete-notify'
exports.inject = ['slots', 'locale']
exports.apply = function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-complete-notify: dictionaries')
  const t = ctx.locale.bind(NS)
  const sessions = ctx.get('sessions')

  // 音效解锁：首次用户手势时创建/恢复 AudioContext（自动播放策略标准解法）
  ctx.effect(() => {
    const unlock = () => { try { unlockAudio() } catch (err) {} }
    window.addEventListener('pointerdown', unlock, { passive: true })
    window.addEventListener('keydown', unlock, { passive: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, 'dsh-complete-notify: audio unlock')

  // 全局 toast 宿主（含完成检测，常驻挂载）
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'complete-notify-toast',
    order: 60,
    label: () => t('overlayLabel'),
    locale: NS,
    inject: () => ({ t }),
  }, (props) => h(ToastHost, { useSessions: props ? props.useSessions : undefined, sessions, t })))

  // 设置页
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'complete-notify',
    order: 50,
    label: () => t('navLabel'),
    locale: NS,
    inject: () => ({ t }),
  }, () => h(SettingsPage, { t })))
}

// 单测钩子（客户端宿主会忽略该额外导出）
exports.__test = { createWatcher, summarizeRun, formatDuration, formatTokens, buildStatsLine, cleanRecap, lastAnswerText, inferKind, kindMeta, emitTest, onTest }

return module.exports;
} });
