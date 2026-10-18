/**
 * DSH memory feeder.
 *
 * At the end of every completed top-level turn, the user+assistant text is
 * appended to a durable local queue (synchronously, so a one-shot headless
 * process cannot exit before it is persisted). The queue is drained later by
 * the same session model, which extracts long-term facts and writes them as
 * unverified candidates into the shared memory library's candidate file
 * (agents/dsh/inbox.md).
 *
 * v1 never edits shared/ or projects/ directly: the manager (or a human)
 * promotes inbox candidates into the formal files.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-memory-feeder'
export const inject = ['llm']

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOG_PREFIX = '[dsh-memory-feeder]'

const DEFAULTS = Object.freeze({
  memoryRoot: '',
  inboxSubdir: 'agents/dsh',
  debounceMs: 5000,
  startupDelayMs: 1500,
  retryDelayMs: 15000,
  maxPerRun: 5,
  maxQueueAttempts: 3,
  maxItems: 5,
  minConfidence: 0.6,
  minTurnChars: 30,
  maxTranscriptChars: 16000,
  maxSeenEntries: 2000,
  provider: '',
  model: '',
  queuePath: path.join(PLUGIN_DIR, '.pending.jsonl'),
  seenPath: path.join(PLUGIN_DIR, '.seen.json'),
  logPath: path.join(PLUGIN_DIR, '.feeder.log'),
})

let activeLogPath = DEFAULTS.logPath

function formatLogArg(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack ?? value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function log(...args) {
  const message = scrubSecrets(args.map(formatLogArg).join(' ')).slice(0, 2000)
  console.error(LOG_PREFIX, message)
  try {
    fs.appendFileSync(activeLogPath, `${new Date().toISOString()} ${message}\n`, 'utf8')
  } catch {
    // Logging must never break memory capture.
  }
}

function resolveConfig(raw) {
  const value = raw !== null && typeof raw === 'object' ? raw : {}
  const text = (key) => typeof value[key] === 'string' && value[key].trim() !== '' ? value[key].trim() : DEFAULTS[key]
  const number = (key, minimum = 0) => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= minimum
    ? value[key]
    : DEFAULTS[key]
  return {
    memoryRoot: text('memoryRoot'),
    inboxSubdir: text('inboxSubdir'),
    debounceMs: number('debounceMs'),
    startupDelayMs: number('startupDelayMs'),
    retryDelayMs: number('retryDelayMs'),
    maxPerRun: Math.floor(number('maxPerRun', 1)),
    maxQueueAttempts: Math.floor(number('maxQueueAttempts', 1)),
    maxItems: Math.floor(number('maxItems', 1)),
    minConfidence: Math.min(1, number('minConfidence')),
    minTurnChars: Math.floor(number('minTurnChars')),
    maxTranscriptChars: Math.floor(number('maxTranscriptChars', 1000)),
    maxSeenEntries: Math.floor(number('maxSeenEntries', 100)),
    provider: text('provider'),
    model: text('model'),
    queuePath: text('queuePath'),
    seenPath: text('seenPath'),
    logPath: text('logPath'),
  }
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function humanStamp(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function localDateStamp(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{16,}\b/gi,
]

const ASSIGNMENT_SECRET = /((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|password|passwd|secret)\s*[:=：]\s*)["']?[^\s"']{6,}["']?/gi

/** Remove credential-looking values before text leaves the process. */
function scrubSecrets(input) {
  let output = String(input)
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[REDACTED]')
  output = output.replace(ASSIGNMENT_SECRET, '$1[REDACTED]')
  return output
}

function hasSecret(input) {
  const text = String(input)
  if (ASSIGNMENT_SECRET.test(text)) {
    ASSIGNMENT_SECRET.lastIndex = 0
    return true
  }
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0
    if (pattern.test(text)) {
      pattern.lastIndex = 0
      return true
    }
    pattern.lastIndex = 0
  }
  return false
}

function clip(text, max) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.6)
  const tail = Math.max(0, max - head - 24)
  return `${text.slice(0, head)}\n\n[...中间已截断...]\n\n${text.slice(text.length - tail)}`
}

function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** First UUID group of a session id, for short file names and logs. */
function sessionTag(id) {
  const match = /[0-9a-f]{8}/i.exec(String(id))
  return match ? match[0] : String(id).slice(0, 8)
}

function itemHash(scope, content) {
  return crypto.createHash('sha1').update(`${scope}\n${content.trim().toLowerCase()}`).digest('hex')
}

function buildSystemPrompt(maxItems, today) {
  return [
    '你是“共享记忆库写回器”。从给定的一轮对话里找出值得跨会话长期记住的事实。',
    `今天是 ${today}。相对日期（明天、下周五等）要换算成绝对日期再写。`,
    '',
    '只提取以下几类：',
    '1. 用户偏好、纠正，或“以后都这样”这类长期要求；',
    '2. 用户身份、长期目标、课程、项目背景等跨会话有用的事实；',
    '3. 项目决定、截止日期、硬约束；',
    '4. 完成任务后可复用的结论：环境配置、踩过的坑、固定流程。',
    '',
    '用户亲口说出的计划、目标、优先级（“我希望…”“我打算…”“以后…”）必须提取，哪怕只有一句话；不要因为助手回复更长就忽略用户。这类事实的 confidence 不低于 0.8。',
    '示例：用户说“我希望大一把英语和绩点搞好”，应输出 [{"scope":"user","title":"大一目标","content":"希望大一提高英语和绩点。","confidence":0.9}]。',
    '只记用户亲口说过的事实、计划、目标和偏好；助手的建议、方案、鼓励不算用户事实，除非用户明确接受。不要把助手的建议改写成用户的计划。',
    '助手的长篇解释只在包含可复用的环境配置、踩坑或固定流程时提取；用户与助手冲突时以用户为准。',
    '',
    '不要提取：一次性任务细节、临时路径、代码或 git 里随时能查到的东西、',
    '密钥/密码/token/登录态、寒暄、过程性叙述和没有长期价值的闲聊。',
    '没有值得记的内容就返回空数组。',
    '',
    '把这一轮值得记的事实合并成一段，不要一条一个条目。默认只输出 1 条；只有用户级事实和项目级事实同时存在时，才输出 2 条（user/project 各一条）。',
    '每条用中文写，独立可读、具体，保留必要的名称、日期、路径或命令。',
    'scope 规则：身份、学校、课程、长期目标、偏好一律写 "user"；只有绑定当前工作目录或某个具体代码/工作项目的事实才写 "project"。',
    `最多 ${Math.min(maxItems, 2)} 条。`,
    '',
    '只输出 JSON 数组，不要 markdown 围栏，不要解释。元素格式：',
    '[{"scope":"user"|"project","title":"不超过20字","content":"合并成一段话","confidence":0到1}]',
  ].join('\n')
}

function parseModelItems(raw, cfg) {
  let text = String(raw).trim()
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) text = fence[1].trim()
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end <= start) throw new Error('model output has no JSON array')
  const parsed = JSON.parse(text.slice(start, end + 1))
  if (!Array.isArray(parsed)) throw new Error('model output is not an array')

  const items = []
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object') continue
    const scope = entry.scope === 'project' ? 'project' : entry.scope === 'user' ? 'user' : undefined
    const title = typeof entry.title === 'string' ? entry.title.trim().replace(/\s+/g, ' ') : ''
    const content = typeof entry.content === 'string' ? entry.content.trim() : ''
    const confidence = typeof entry.confidence === 'number' && Number.isFinite(entry.confidence) ? entry.confidence : 0
    if (scope === undefined || title === '' || content === '') continue
    if (confidence < cfg.minConfidence || confidence > 1) continue
    if (hasSecret(content) || hasSecret(title)) continue
    items.push({
      scope,
      title: clip(title, 60),
      content: scrubSecrets(clip(content, 1200)),
      confidence,
    })
    if (items.length >= cfg.maxItems) break
  }
  return items
}

export function apply(ctx, rawConfig) {
  const cfg = resolveConfig(rawConfig)
  activeLogPath = cfg.logPath
  if (cfg.memoryRoot === '') {
    log('disabled: config.memoryRoot is required; set it to the root of your Markdown memory library')
    return
  }
  const states = new Map()
  const inflight = new Set()
  let seen = loadSeen()
  let timer = null
  let processing = false
  let disposed = false
  let ownsLock = false

  const lockPath = `${cfg.queuePath}.lock`

  function readQueue() {
    let raw
    try {
      raw = fs.readFileSync(cfg.queuePath, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line)
        if (record !== null && typeof record === 'object' && typeof record.id === 'string') records.push(record)
      } catch {
        log('skip malformed queue line')
      }
    }
    return records
  }

  function writeQueue(records) {
    fs.mkdirSync(path.dirname(cfg.queuePath), { recursive: true })
    const tmp = `${cfg.queuePath}.tmp`
    const body = records.map(record => JSON.stringify(record)).join('\n')
    fs.writeFileSync(tmp, body === '' ? '' : `${body}\n`, 'utf8')
    fs.renameSync(tmp, cfg.queuePath)
  }

  function updateRecord(record) {
    writeQueue(readQueue().map(item => item.id === record.id ? record : item))
  }

  function removeRecord(id) {
    writeQueue(readQueue().filter(item => item.id !== id))
  }

  function appendRecord(record) {
    fs.mkdirSync(path.dirname(cfg.queuePath), { recursive: true })
    fs.appendFileSync(cfg.queuePath, `${JSON.stringify(record)}\n`, 'utf8')
  }

  function loadSeen() {
    try {
      const parsed = JSON.parse(fs.readFileSync(cfg.seenPath, 'utf8'))
      if (Array.isArray(parsed?.hashes)) return new Set(parsed.hashes.filter(hash => typeof hash === 'string'))
    } catch (error) {
      if (error.code !== 'ENOENT') log('cannot read seen file:', error.message)
    }
    return new Set()
  }

  function saveSeen() {
    const hashes = [...seen].slice(-cfg.maxSeenEntries)
    seen = new Set(hashes)
    fs.mkdirSync(path.dirname(cfg.seenPath), { recursive: true })
    const tmp = `${cfg.seenPath}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, hashes }, null, 2), 'utf8')
    fs.renameSync(tmp, cfg.seenPath)
  }

  function stateFor(session) {
    const id = String(session.id)
    let state = states.get(id)
    if (state === undefined) {
      state = { sessionId: id, user: [], assistant: [] }
      states.set(id, state)
    }
    return state
  }

  function routeOf(session) {
    try {
      const config = session.requestHeader()?.config
      return {
        provider: typeof config?.provider === 'string' ? config.provider : '',
        model: typeof config?.model === 'string' ? config.model : '',
      }
    } catch {
      return { provider: '', model: '' }
    }
  }

  function enqueueTurn(session, state) {
    const user = scrubSecrets(state.user.join('\n\n')).trim()
    const assistant = scrubSecrets(state.assistant.join('\n\n')).trim()
    if (user === '') return
    if (user.length + assistant.length < cfg.minTurnChars) return

    const route = routeOf(session)
    const provider = cfg.provider || route.provider
    const model = cfg.model || route.model
    if (provider === '' || model === '') {
      log('skip turn: no provider/model on the session request header')
      return
    }

    const userBudget = Math.floor(cfg.maxTranscriptChars * 0.4)
    const assistantBudget = cfg.maxTranscriptChars - userBudget
    const record = {
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      sessionId: state.sessionId,
      cwd: typeof session.header?.cwd === 'string' ? session.header.cwd : process.cwd(),
      provider,
      model,
      user: clip(user, userBudget),
      assistant: clip(assistant, assistantBudget),
      attempts: 0,
    }
    appendRecord(record)
    log(`queued turn ${sessionTag(record.sessionId)} (${record.user.length}+${record.assistant.length} chars)`)
    scheduleProcess(cfg.debounceMs)
  }

  function handleSessionEvent(session, event) {
    if (session.header?.origin === 'subagent') return
    if (event === null || typeof event !== 'object') return
    const id = String(session.id)
    switch (event.type) {
      case 'turn/start':
        states.set(id, { sessionId: id, user: [], assistant: [] })
        return
      case 'user/message': {
        if (event.data?.source?.kind !== 'user') return
        const text = textFromBlocks(event.data.content)
        if (text !== '') stateFor(session).user.push(text)
        return
      }
      case 'assistant/message': {
        const text = textFromBlocks(event.data?.message?.content)
        if (text !== '') stateFor(session).assistant.push(text)
        return
      }
      case 'turn/end': {
        const state = states.get(id)
        states.delete(id)
        if (state !== undefined && event.data?.reason?.kind === 'completed') enqueueTurn(session, state)
        return
      }
      default:
        return
    }
  }

  function acquireLock() {
    try {
      const fd = fs.openSync(lockPath, 'wx')
      fs.writeSync(fd, String(process.pid))
      fs.closeSync(fd)
      ownsLock = true
      return true
    } catch (error) {
      if (error.code !== 'EEXIST') {
        log('cannot create lock:', error.message)
        return false
      }
      try {
        const stat = fs.statSync(lockPath)
        if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
          fs.unlinkSync(lockPath)
          return acquireLock()
        }
      } catch {
        // The lock disappeared between open and stat: retry once below.
        return acquireLock()
      }
      return false
    }
  }

  function releaseLock() {
    if (!ownsLock) return
    ownsLock = false
    try {
      fs.unlinkSync(lockPath)
    } catch {
      // Already gone.
    }
  }

  async function extract(record) {
    const today = localDateStamp(new Date())
    const transcript = [
      `工作目录：${record.cwd || '(未知)'}`,
      `会话：${record.sessionId}`,
      '',
      '【用户】',
      record.user,
      '',
      '【助手】',
      record.assistant || '(无文本回复)',
    ].join('\n')

    const messages = [{
      id: crypto.randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: transcript }],
      source: { kind: 'plugin', plugin: 'dsh-memory-feeder' },
    }]

    const controller = new AbortController()
    inflight.add(controller)
    try {
      let text = ''
      let finish
      for await (const chunk of ctx.llm.stream({
        provider: record.provider,
        model: record.model,
        system: buildSystemPrompt(cfg.maxItems, today),
        messages,
        maxTokens: 2500,
        signal: controller.signal,
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') finish = chunk.reason
      }
      if (finish !== undefined && (finish.kind === 'error' || finish.kind === 'aborted')) {
        throw new Error(`extractor stream ended with ${finish.kind}: ${finish.failure.code} ${finish.failure.message}`)
      }
      const items = parseModelItems(text, cfg)
      if (items.length === 0) log(`extractor returned no items; raw: ${clip(text, 800)}`)
      else log(`extracted ${items.length} item(s): ${items.map(item => `[${item.scope}] ${item.title}`).join(' | ')}`)
      return items
    } finally {
      inflight.delete(controller)
    }
  }

  function consolidateItems(items) {
    const groups = new Map()
    for (const item of items) {
      const group = groups.get(item.scope)
      if (group === undefined) {
        groups.set(item.scope, {
          scope: item.scope,
          title: item.title,
          contents: [item.content],
          confidence: item.confidence,
        })
        continue
      }
      group.contents.push(item.content)
      group.confidence = Math.min(group.confidence, item.confidence)
    }
    return [...groups.values()].map(group => ({
      scope: group.scope,
      title: group.contents.length === 1
        ? group.title
        : `${group.scope === 'user' ? '用户' : '项目'}事实（${group.contents.length} 项合并）`,
      content: group.contents.join(' '),
      confidence: group.confidence,
    }))
  }

  function inboxFile() {
    const dir = path.join(cfg.memoryRoot, cfg.inboxSubdir)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'inbox.md')
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      fs.writeFileSync(file, [
        '# DSH 候选区',
        '',
        'feeder 自动抽取的未核实候选追加在这里。管理者合并后清理或移入 `archive/2026.md`。',
        '',
        '- 不写密钥、token、密码、登录态。',
        '- 同轮相关事实按 scope 合并成一块。',
        '',
      ].join('\n'), 'utf8')
    }
    return file
  }

  function writeInbox(record, items) {
    if (items.length === 0) return 0
    const merged = consolidateItems(items)
    const file = inboxFile()
    const when = new Date(record.time)

    const lines = [
      `## ${humanStamp(when)} · \`${sessionTag(record.sessionId)}\` · dsh`,
      '',
      `- 来源会话：\`${record.sessionId}\``,
      `- 工作目录：\`${record.cwd || '(未知)'}\``,
      `- 模型：\`${record.provider}/${record.model}\``,
      '- 状态：**自动提取，未核实**。确认后由管理者合并到 `shared/` 或 `projects/<slug>/`。',
      '',
    ]

    merged.forEach(item => {
      lines.push(`**${item.title}**（\`${item.scope}\`，置信度 ${item.confidence.toFixed(2)}）`)
      lines.push('')
      lines.push(item.content)
      lines.push('')
    })

    lines.push('<details>')
    lines.push('<summary>原始对话摘录</summary>')
    lines.push('')
    lines.push('**用户**')
    lines.push('')
    lines.push(clip(record.user, 2000))
    lines.push('')
    lines.push('**助手**')
    lines.push('')
    lines.push(clip(record.assistant || '(无文本回复)', 2000))
    lines.push('')
    lines.push('</details>')
    lines.push('')

    const existing = fs.readFileSync(file, 'utf8')
    const prefix = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n'
    fs.appendFileSync(file, prefix + lines.join('\n'), 'utf8')
    log(`appended ${items.length} candidate(s) to ${file}`)
    return items.length
  }

  async function processRecord(record) {
    if (record.provider === '' || record.model === '') {
      record.attempts = cfg.maxQueueAttempts
      record.lastError = 'missing provider/model'
      updateRecord(record)
      log('drop queued turn: missing provider/model')
      return
    }
    try {
      const extracted = await extract(record)
      const fresh = []
      const freshHashes = []
      for (const item of extracted) {
        const hash = itemHash(item.scope, item.content)
        if (seen.has(hash)) continue
        fresh.push(item)
        freshHashes.push(hash)
      }
      if (fresh.length > 0) {
        writeInbox(record, fresh)
        for (const hash of freshHashes) seen.add(hash)
        saveSeen()
      }
      removeRecord(record.id)
      log(`processed turn ${sessionTag(record.sessionId)}: ${fresh.length} new candidate(s)`)
    } catch (error) {
      record.attempts = (record.attempts ?? 0) + 1
      record.lastError = String(error?.message ?? error).slice(0, 500)
      updateRecord(record)
      log(`extract failed (${record.attempts}/${cfg.maxQueueAttempts}): ${record.lastError}`)
    }
  }

  async function processQueue() {
    if (disposed || processing) return
    processing = true
    try {
      if (!acquireLock()) {
        log('another feeder process holds the queue; retrying later')
        if (!disposed) scheduleProcess(cfg.retryDelayMs)
        return
      }
      let handled = 0
      while (!disposed && handled < cfg.maxPerRun) {
        const record = readQueue().find(item => (item.attempts ?? 0) < cfg.maxQueueAttempts)
        if (record === undefined) break
        handled += 1
        await processRecord(record)
      }
      const remaining = readQueue().some(item => (item.attempts ?? 0) < cfg.maxQueueAttempts)
      if (remaining && !disposed) scheduleProcess(cfg.retryDelayMs)
    } finally {
      releaseLock()
      processing = false
    }
  }

  function scheduleProcess(delay) {
    if (disposed) return
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void processQueue().catch(error => { log('queue processing failed:', error) })
    }, delay)
  }

  ctx.on('session/event', (session, event) => {
    try {
      handleSessionEvent(session, event)
    } catch (error) {
      log('session event handling failed:', error)
    }
  })

  ctx.effect(() => {
    const startup = setTimeout(() => {
      void processQueue().catch(error => { log('startup queue processing failed:', error) })
    }, cfg.startupDelayMs)
    return () => {
      disposed = true
      clearTimeout(startup)
      if (timer !== null) clearTimeout(timer)
      for (const controller of inflight) controller.abort()
    }
  })

  log(`ready (memoryRoot=${cfg.memoryRoot}, inbox=${cfg.inboxSubdir}, queue=${cfg.queuePath})`)
}
