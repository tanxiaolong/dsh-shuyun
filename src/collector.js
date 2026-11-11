/**
 * 云枢（Yunshu / 鹰云 SASE）终端监控动作采集器。
 *
 * 三条互补的数据来源，全部只读：
 *   1. macOS 的 TCC 访问日志流（`log stream`）：谁在请求「屏幕录制 / 麦克风 / 摄像头 /
 *      键盘监听 / 全盘文件 / 无障碍」权限。这是系统层面的真实动作，不依赖云枢自己上报。
 *   2. 云枢自己的运行日志（`~/Library/Logs/com.eagleyun.sase/agent/*.log`）：
 *      截屏循环、水印、剪贴板、前台应用、软件清单、心跳上报等。
 *   3. 云枢的 DLP 引擎日志（`/opt/.yunshu/logs/sase.dlp.engine.log`）：
 *      正在扫描的具体文件路径。
 *
 * 采集结果是一份「当前状态 + 最近动作流水」，交给 /api/shuyun/state 输出。
 */
import { spawn } from 'node:child_process'
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 云枢可能出现的进程/路径特征。 */
const YUNSHU_HINTS = ['eagleyun', 'yunshu', '/opt/.yunshu']
const isYunshuText = text => {
  if (typeof text !== 'string' || !text) return false
  const lower = text.toLowerCase()
  return YUNSHU_HINTS.some(hint => lower.includes(hint))
}

/** 把浏览器 bundle id 收敛成人看得懂的名字（云枢日志里用的是 bundle id）。 */
const BROWSER_NAMES = {
  'com.google.Chrome': 'Chrome',
  'com.microsoft.Edge': 'Edge',
  'org.mozilla.firefox': 'Firefox',
  'com.brave.Browser': 'Brave',
  'com.apple.Safari': 'Safari',
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  brave: 'Brave',
  safari: 'Safari'
}
const browserLabel = id => {
  const raw = String(id ?? '').trim()
  return BROWSER_NAMES[raw] ?? BROWSER_NAMES[raw.toLowerCase()] ?? raw
}

/**
 * 动作目录：key 是内部标识，label 给用户看，severity 决定颜色，ttl 是「多久没有新动作
 * 就算结束」，source 标明证据来自哪里。
 */
export const ACTION_CATALOG = {
  'screen-capture': { label: '截屏 / 抓屏', severity: 'high', ttl: 60_000, source: 'system', event: 0 },
  microphone: { label: '录音（麦克风）', severity: 'high', ttl: 45_000, source: 'system', event: 0 },
  camera: { label: '摄像头采集', severity: 'high', ttl: 45_000, source: 'system', event: 0 },
  'keyboard-listen': { label: '监听键盘事件', severity: 'high', ttl: 60_000, source: 'system', event: 5_000 },
  'input-post': { label: '模拟键鼠（远程操作）', severity: 'high', ttl: 30_000, source: 'system', event: 10_000 },
  'screen-timer': { label: '定时截屏循环', severity: 'high', ttl: 90_000, source: 'yunshu', event: 60_000 },
  'file-scan': { label: '扫描文件内容', severity: 'medium', ttl: 20_000, source: 'dlp', event: 4_000 },
  'full-disk': { label: '全盘文件访问', severity: 'medium', ttl: 60_000, source: 'system', event: 15_000 },
  accessibility: { label: '读取界面元素', severity: 'medium', ttl: 60_000, source: 'yunshu', event: 30_000 },
  'clipboard-read': { label: '读取剪贴板', severity: 'medium', ttl: 30_000, source: 'yunshu', event: 10_000 },
  'browser-url': { label: '读取浏览器地址', severity: 'medium', ttl: 20_000, source: 'yunshu', event: 10_000 },
  'browser-window': { label: '统计浏览器窗口', severity: 'low', ttl: 90_000, source: 'yunshu', event: null },
  watermark: { label: '屏幕水印 / 显示层采集', severity: 'medium', ttl: 120_000, source: 'yunshu', event: 30_000 },
  'frontmost-app': { label: '跟踪前台应用', severity: 'low', ttl: 120_000, source: 'yunshu', event: null },
  software: { label: '采集已安装软件清单', severity: 'low', ttl: 30 * 60_000, source: 'yunshu', event: 0 },
  upload: { label: '上报数据到服务端', severity: 'low', ttl: 120_000, source: 'yunshu', event: null },
  'screen-lock': { label: '探测锁屏状态', severity: 'low', ttl: 120_000, source: 'yunshu', event: null },
  'apple-events': { label: '控制其他应用', severity: 'medium', ttl: 60_000, source: 'system', event: 10_000 },
  'external-disk': { label: '读取外接存储', severity: 'medium', ttl: 60_000, source: 'system', event: 10_000 },
  bluetooth: { label: '访问蓝牙', severity: 'low', ttl: 60_000, source: 'system', event: 30_000 }
}

/** TCC 服务名 → 动作品类。没列出的服务不展示，避免噪音。 */
const TCC_SERVICE_MAP = {
  kTCCServiceScreenCapture: 'screen-capture',
  kTCCServiceMicrophone: 'microphone',
  kTCCServiceCamera: 'camera',
  kTCCServiceListenEvent: 'keyboard-listen',
  kTCCServicePostEvent: 'input-post',
  kTCCServiceAccessibility: 'accessibility',
  kTCCServiceSystemPolicyAllFiles: 'full-disk',
  kTCCServiceSystemPolicyRemovableVolumes: 'external-disk',
  kTCCServiceSystemPolicyNetworkVolumes: 'external-disk',
  kTCCServiceAppleEvents: 'apple-events',
  kTCCServiceBluetoothAlways: 'bluetooth',
  kTCCServiceBluetoothPeripheral: 'bluetooth'
}

const SEVERITY_ORDER = { high: 3, medium: 2, low: 1 }

const AGENT_LOG_DIR = join(homedir(), 'Library', 'Logs', 'com.eagleyun.sase', 'agent')
const DLP_LOG = '/opt/.yunshu/logs/sase.dlp.engine.log'

/** 把一行云枢日志拆成字段：`2026/11/05 20:30:24:523 127267041 ScreenCapture:199 Info | isopen: 1` */
const AGENT_LINE = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}):(\d{3}) \d+ (\w+):(\d+) (\w+) \| ([\s\S]*)$/

/** 把日志时间转成毫秒时间戳（日志本身就写在本机时区里）。 */
function logTimestamp(m) {
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]), Number(m[7])
  ).getTime()
}

/**
 * 增量跟随一个目录里最新的日志文件。日志会按启动/跨天切分，所以每次轮询都重挑最新文件，
 * 换文件时从头读新文件。读取有上限，避免一次性把几百 MB 的旧日志拉进内存。
 */
class TailFile {
  constructor({ pick, fromEnd = false, maxBytesPerPoll = 256 * 1024 }) {
    this.pick = pick
    this.fromEnd = fromEnd
    this.maxBytesPerPoll = maxBytesPerPoll
    this.path = null
    this.offset = 0
    this.remainder = ''
    this.missing = false
  }

  async poll(onLine) {
    const path = await this.pick().catch(() => null)
    if (!path) {
      this.missing = true
      return
    }
    this.missing = false
    if (path !== this.path) {
      this.path = path
      this.remainder = ''
      this.offset = this.fromEnd ? (await stat(path)).size : 0
    }
    const info = await stat(path)
    if (info.size < this.offset) {
      // 文件被轮转重写：从头再读。
      this.offset = 0
      this.remainder = ''
    }
    if (info.size === this.offset) return

    const handle = await open(path, 'r')
    try {
      let position = this.offset
      while (position < info.size) {
        const length = Math.min(this.maxBytesPerPoll, info.size - position)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, position)
        if (!bytesRead) break
        position += bytesRead
        const chunk = this.remainder + buffer.subarray(0, bytesRead).toString('utf8')
        const lines = chunk.split('\n')
        this.remainder = lines.pop() ?? ''
        for (const raw of lines) {
          // 云枢的日志行尾带 \r，锚定 $ 的行内解析会因此失配，这里先清掉。
          const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
          if (line.trim()) onLine(line)
        }
        if (position - this.offset >= this.maxBytesPerPoll * 4) break
      }
      this.offset = position
    } finally {
      await handle.close()
    }
  }
}

/** 目录里 mtime 最新的文件。 */
async function newestFile(dir, filter) {
  const names = await readdir(dir).catch(() => [])
  let best = null
  let bestTime = -1
  for (const name of names) {
    if (filter && !filter(name)) continue
    const full = join(dir, name)
    const info = await stat(full).catch(() => null)
    if (!info || !info.isFile()) continue
    if (info.mtimeMs > bestTime) {
      bestTime = info.mtimeMs
      best = full
    }
  }
  return best
}

export class YunshuCollector {
  constructor({ intervalMs = 1000, maxEvents = 60 } = {}) {
    this.intervalMs = intervalMs
    this.maxEvents = maxEvents
    this.events = []
    this.actions = new Map()
    this.state = {
      screenCaptureEnabled: null,
      screenCaptureAt: 0,
      axPermission: null,
      frontmost: null,
      processes: [],
      processesAt: 0,
      tcc: 'starting',
      tccReason: '',
      agentLogAt: 0,
      dlpLogAt: 0,
      scanFile: null,
      scanFileAt: 0
    }
    this.timer = null
    this.tccChild = null
    this.pendingTcc = new Map()
    this.lastTccMsgId = null
    /** BrowserWindowState 是多行日志，这里暂存解析中的那一块。 */
    this.browserBlock = null
    /** 上一次剪贴板写入的时间，用来避免「pb changed」覆盖更具体的类型信息。 */
    this.lastPbAt = 0
    this.stopped = false
    this.seeding = false
    this.ticking = false
    this.agentTail = new TailFile({
      pick: () => newestFile(AGENT_LOG_DIR, n => n.endsWith('.log')),
      fromEnd: true
    })
    this.dlpTail = new TailFile({ pick: async () => DLP_LOG, fromEnd: true })
  }

  /** 记一条动作：刷新状态，并按动作自身的节流规则决定要不要进「动作流水」。 */
  record(key, detail, at = Date.now(), source) {
    if (this.seeding) return
    const action = ACTION_CATALOG[key]
    if (!action) return
    const entry = this.actions.get(key) ?? { key, count: 0, firstAt: at, lastAt: 0, lastEventAt: 0, detail: '' }
    entry.count += 1
    entry.lastAt = Math.max(entry.lastAt, at)
    if (detail) entry.detail = detail
    this.actions.set(key, entry)

    // event === null 表示「状态型动作」：只反映当前状态，不进流水，否则会淹掉真正的动作。
    if (action.event === null) return
    if (at - entry.lastEventAt < action.event) return
    entry.lastEventAt = at
    this.events.unshift({ ts: at, key, label: action.label, detail: detail || '', source: source ?? action.source })
    if (this.events.length > this.maxEvents) this.events.length = this.maxEvents
  }

  /**
   * 只为了拿到「当前状态」而回读日志尾部（截屏开关、前台应用、无障碍权限），
   * 不回放历史动作，否则刚打开面板就会刷出几百条旧记录。
   */
  async seed() {
    const path = await newestFile(AGENT_LOG_DIR, name => name.endsWith('.log'))
    if (!path) return
    const info = await stat(path).catch(() => null)
    if (!info) return
    const start = Math.max(0, info.size - 128 * 1024)
    const handle = await open(path, 'r').catch(() => null)
    if (!handle) return
    try {
      const buffer = Buffer.alloc(info.size - start)
      await handle.read(buffer, 0, buffer.length, start)
      this.seeding = true
      for (const line of buffer.toString('utf8').split('\n')) if (line.trim()) this.parseAgentLine(line)
    } finally {
      this.seeding = false
      await handle.close()
    }
  }

  start() {
    this.startTccStream()
    void this.seed().then(() => this.tick()).catch(() => {})
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    void this.sampleProcesses()
    this.processTimer = setInterval(() => { void this.sampleProcesses() }, 5000)
  }

  async stop() {
    this.stopped = true
    clearInterval(this.timer)
    clearInterval(this.processTimer)
    if (this.tccChild) {
      try { this.tccChild.kill() } catch { /* 进程已经退出 */ }
      this.tccChild = null
    }
  }

  async tick() {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      // 掉在半路的 TCC 请求（没等到 RESULT）过一会儿就丢掉，避免映射表无限长大。
      const now = Date.now()
      for (const [id, pending] of this.pendingTcc) {
        if (now - pending.at > 60_000) this.pendingTcc.delete(id)
      }
      await this.agentTail.poll(line => this.parseAgentLine(line)).catch(() => {})
      await this.dlpTail.poll(line => this.parseDlpLine(line)).catch(() => {})
    } finally {
      this.ticking = false
    }
  }

  /** macOS 的 TCC 子系统会把「谁在申请什么权限」写进统一日志，这里流式读取并归因到云枢。 */
  startTccStream() {
    let child
    try {
      child = spawn('/usr/bin/log', ['stream', '--style', 'compact', '--predicate', 'subsystem == "com.apple.TCC"'], {
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      this.state.tcc = 'unavailable'
      this.state.tccReason = String(error?.message ?? error)
      return
    }
    this.tccChild = child
    this.state.tcc = 'starting'
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) this.parseTccLine(line)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', text => {
      const text$ = String(text).trim()
      if (text$) this.state.tccReason = text$.slice(0, 200)
    })
    child.on('spawn', () => { this.state.tcc = 'live' })
    child.on('error', error => {
      this.state.tcc = 'unavailable'
      this.state.tccReason = String(error?.message ?? error)
    })
    child.on('exit', () => {
      this.tccChild = null
      if (this.stopped) return
      this.state.tcc = 'restarting'
      // 日志流被系统回收很常见，隔一会儿重新拉起。
      setTimeout(() => { if (!this.stopped) this.startTccStream() }, 3000).unref?.()
    })
  }

  /**
   * 一次 TCC 请求会被拆成多行：REQUEST / AUTHREQ_CTX（服务名）/ AUTHREQ_ATTRIBUTION
   * （责任进程）/ requestor（实际访问者）/ AUTHREQ_RESULT（结果）。按 msgID 拼起来，
   * 只有责任进程、访问者或路径命中云枢时才记一笔。
   */
  parseTccLine(line) {
    if (!line.includes('com.apple.TCC')) return
    const msg = /msgID=([\w.]+)/.exec(line)
    const msgId = msg ? msg[1] : null

    if (line.includes('REQUEST:')) {
      if (msgId) this.pendingTcc.set(msgId, { at: Date.now(), id: msgId })
      return
    }
    if (line.includes('AUTHREQ_CTX:')) {
      if (!msgId) return
      const pending = this.pendingTcc.get(msgId) ?? { at: Date.now(), id: msgId }
      const service = /service=(\w+)/.exec(line)
      if (service) pending.service = service[1]
      this.pendingTcc.set(msgId, pending)
      this.lastTccMsgId = msgId
      return
    }
    if (line.includes('requestor:') && this.lastTccMsgId) {
      const pending = this.pendingTcc.get(this.lastTccMsgId)
      if (!pending) return
      const identifier = /is checking access for accessor TCCDProcess: identifier=([^,]+)/.exec(line)
      const pid = /accessor TCCDProcess: identifier=[^,]+, pid=(\d+)/.exec(line)
      if (identifier) pending.accessor = identifier[1].trim()
      if (pid) pending.pid = Number(pid[1])
      if (isYunshuText(line)) pending.yunshu = true
      return
    }
    if (line.includes('AUTHREQ_RESULT:')) {
      if (!msgId) return
      const pending = this.pendingTcc.get(msgId)
      this.pendingTcc.delete(msgId)
      if (!pending || !pending.service) return
      const key = TCC_SERVICE_MAP[pending.service]
      if (!key) return
      const attributed = pending.yunshu || isYunshuText(pending.accessor ?? '')
      if (!attributed) return
      const granted = /authValue=(\d+)/.exec(line)
      const detail = [
        pending.accessor || '云枢进程',
        granted && granted[1] === '1' ? '已授权' : granted ? '未授权' : ''
      ].filter(Boolean).join(' · ')
      this.record(key, detail, pending.at, 'system')
      return
    }
    // AUTHREQ_ATTRIBUTION 里带着责任进程与访问进程的完整路径，用来判断是不是云枢。
    if (line.includes('AUTHREQ_ATTRIBUTION:') && msgId) {
      const pending = this.pendingTcc.get(msgId) ?? { at: Date.now(), id: msgId }
      if (isYunshuText(line)) pending.yunshu = true
      const responsible = /responsible=\{[^}]*?identifier=([^,]+)/.exec(line)
      if (responsible) pending.responsible = responsible[1].trim()
      this.pendingTcc.set(msgId, pending)
    }
  }

  /**
   * 消费 BrowserWindowState 的多行块：
   *   chrome = { "has_window" = 1; "window_count" = 4; };
   * 块结束时汇总成一句「Chrome 4 个窗口 · Edge 1 个窗口」。
   * 返回 true 表示这一行已经被吃掉，不该再走单行解析。
   */
  consumeBrowserLine(line) {
    const block = this.browserBlock
    if (block === null) return false
    const trimmed = line.trim()
    if (trimmed === '') return true
    if (trimmed === '}') {
      const open = block.entries.filter(entry => entry.count > 0)
      this.record(
        'browser-window',
        open.length > 0
          ? open.map(entry => `${entry.name} ${entry.count} 个窗口`).join(' · ')
          : '没有已打开的浏览器窗口',
        block.at, 'yunshu')
      this.browserBlock = null
      return true
    }
    if (trimmed === '};') { block.current = null; return true }
    const opened = /^([A-Za-z0-9_.-]+)\s*=\s*\{$/.exec(trimmed)
    if (opened !== null) {
      block.current = { name: browserLabel(opened[1]), count: 0 }
      block.entries.push(block.current)
      return true
    }
    const count = /"window_count"\s*=\s*(\d+)/.exec(trimmed)
    if (count !== null && block.current !== null) {
      block.current.count = Number(count[1])
      return true
    }
    if (/"has_window"\s*=\s*\d+/.test(trimmed)) return true
    // 不像这个块的内容：放弃解析，避免把后续日志吞掉。
    this.browserBlock = null
    return false
  }

  /** 解析云枢 agent 日志里那些能说明「它正在干什么」的行。 */
  parseAgentLine(line) {
    // BrowserWindowState 的后续行没有时间戳前缀，先交给多行解析器。
    if (this.browserBlock !== null && this.consumeBrowserLine(line)) return
    const m = AGENT_LINE.exec(line)
    if (!m) return
    this.state.agentLogAt = Date.now()
    const at = logTimestamp(m)
    const module = m[8]
    const text = m[11]

    if (module === 'ScreenCapture') {
      const open = /isopen: (\d)/.exec(text)
      if (open) {
        const next = open[1] === '1'
        const changed = this.state.screenCaptureEnabled !== null && this.state.screenCaptureEnabled !== next
        this.state.screenCaptureEnabled = next
        this.state.screenCaptureAt = at
        if (changed) this.record('screen-capture', next ? '截屏状态切换为「开启」' : '截屏状态切换为「关闭」', at, 'yunshu')
        return
      }
      if (/Start schedule timer/i.test(text)) {
        this.record('screen-timer', '定时抓屏任务已排期', at, 'yunshu')
        return
      }
      if (/locked,old record/i.test(text)) {
        this.record('screen-lock', '锁屏状态轮询', at, 'yunshu')
      }
      return
    }

    if (module === 'WatermarkManager' || module === 'LXWatermarkEngine') {
      const app = /active app:\s*(.+?)\s+([\w.-]+)\s*$/.exec(text) || /active app:\s*(.+?)\s+([\w.-]+)\s*$/.exec(text)
      if (app) {
        this.state.frontmost = app[1].trim()
        this.record('watermark', app[1].trim(), at, 'yunshu')
      }
      return
    }

    if (module === 'ClipboardMonitor') {
      const url = /getUrlWithCode:(.*)$/.exec(text)
      if (url) {
        this.record('browser-url', browserLabel(url[1]), at, 'yunshu')
        return
      }
      const front = /frontmost bundle id:(.*)$/.exec(text)
      if (front) {
        this.record('frontmost-app', front[1].trim(), at, 'yunshu')
        return
      }
      if (/BrowserWindowState\] reply state:\{$/.test(text)) {
        this.browserBlock = { at, current: null, entries: [] }
        return
      }
      const pb = /pb item, length: (\d+), type: ([^,]+)/.exec(text)
      if (pb) {
        this.lastPbAt = at
        this.record('clipboard-read', `剪贴板写入 · ${pb[2].trim()}（${pb[1]} 字节）`, at, 'yunshu')
        return
      }
      if (/pb changed/.test(text)) {
        // 刚写进去的细节更值钱，别被紧随其后的「变化」通知覆盖。
        if (at - this.lastPbAt < 2_000) return
        this.record('clipboard-read', '剪贴板内容变化', at, 'yunshu')
        return
      }
      return
    }

    if (module === 'AXHelper') {
      this.state.axPermission = /no permission/i.test(text) ? false : true
      this.record('accessibility', /no permission/i.test(text) ? '尝试读取界面元素（无权限）' : '读取界面元素', at, 'yunshu')
      return
    }

    if (module === 'SoftwareRecorder') {
      const count = /software_list update succeed (\d+)/.exec(text)
      if (count) this.record('software', `已采集 ${count[1]} 个软件`, at, 'yunshu')
      return
    }

    if (module === 'YSHttpClient' || module === 'YSHTTPGateway') {
      this.record('upload', '心跳 / 数据上报', at, 'yunshu')
    }
  }

  /** DLP 引擎会打印正在扫描的文件路径，这是「扫描文件」最直接的证据。 */
  parseDlpLine(line) {
    if (!line.includes('cloudpivot')) return
    this.state.dlpLogAt = Date.now()
    const ts = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/.exec(line)
    const at = ts
      ? new Date(Number(ts[1]), Number(ts[2]) - 1, Number(ts[3]), Number(ts[4]), Number(ts[5]), Number(ts[6]), Number(ts[7])).getTime()
      : Date.now()
    const scan = /ScanFile Result: filename: (.+?) [A-Za-z0-9+/=]{8,}\s*$/.exec(line)
      || /End custom_detector : (.+?)\s*$/.exec(line)
    if (!scan) return
    const file = scan[1].trim()
    this.state.scanFile = file
    this.state.scanFileAt = at
    if (file === this.lastScanFile && at - (this.lastScanAt ?? 0) < 5000) return
    this.lastScanFile = file
    this.lastScanAt = at
    this.record('file-scan', shortPath(file), at, 'dlp')
  }

  /** 云枢的守护进程还活着吗？顺便看看远程协助服务在不在。 */
  async sampleProcesses() {
    if (this.stopped) return
    const list = await new Promise(resolve => {
      const child = spawn('/bin/ps', ['-axo', 'pid=,comm='], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => { out += chunk })
      child.on('error', () => resolve([]))
      child.on('close', () => resolve(out.split('\n')))
    })
    const found = []
    for (const line of list) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      if (!match) continue
      const path = match[2].trim()
      if (!isYunshuText(path)) continue
      found.push({ pid: Number(match[1]), name: path.split('/').pop() ?? path, path })
    }
    this.state.processes = found
    this.state.processesAt = Date.now()
  }

  /** 汇总成给客户端的一份快照。 */
  snapshot() {
    const now = Date.now()
    const actions = []
    for (const [key, entry] of this.actions) {
      const catalog = ACTION_CATALOG[key]
      if (!catalog) continue
      const age = now - entry.lastAt
      actions.push({
        key,
        label: catalog.label,
        severity: catalog.severity,
        source: catalog.source,
        lastAt: entry.lastAt,
        ageMs: age,
        active: age <= catalog.ttl,
        count: entry.count,
        detail: entry.detail
      })
    }
    actions.sort((a, b) => (SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]) || (b.lastAt - a.lastAt))

    const running = this.state.processes.length > 0
    const remoteDesk = this.state.processes.some(p => /RemoteDeskServer/i.test(p.name))
    return {
      ok: true,
      generatedAt: now,
      agent: {
        running,
        remoteDesk,
        processes: this.state.processes.map(p => ({ pid: p.pid, name: p.name }))
      },
      screenCapture: {
        enabled: this.state.screenCaptureEnabled,
        at: this.state.screenCaptureAt
      },
      source: {
        tcc: this.state.tcc,
        tccReason: this.state.tccReason,
        agentLog: this.state.agentLogAt ? 'live' : (this.agentTail.missing ? 'missing' : 'quiet'),
        dlpLog: this.state.dlpLogAt ? 'live' : (this.dlpTail.missing ? 'missing' : 'quiet')
      },
      current: {
        scanFile: this.state.scanFileAt ? shortPath(this.state.scanFile ?? '') : null,
        scanAt: this.state.scanFileAt,
        frontmost: this.state.frontmost,
        axPermission: this.state.axPermission
      },
      actions,
      events: this.events.slice(0, 40)
    }
  }
}

/** 只保留路径尾部，弹层里看得清又不至于撑破一行。 */
export function shortPath(path, keep = 3) {
  if (typeof path !== 'string') return ''
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= keep) return path
  return '…/' + parts.slice(-keep).join('/')
}

