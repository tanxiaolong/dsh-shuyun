/**
 * 把采集快照渲染成 SwiftBar 能直接显示的菜单栏文本。
 *
 * SwiftBar 的插件约定：脚本第一行是菜单栏标题（可带 `| color=…` 参数），
 * `---` 之后是下拉菜单；行首写 `--` 会被当成子菜单，所以明细行不加前缀，
 * 分隔线必须正好是三个短横线。
 * 所以这里只做「文本渲染」，不碰任何 GUI 代码，脚本那边 `cat` 即可。
 */
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 菜单栏 / 菜单文本的落盘位置，SwiftBar 脚本读同一组文件。 */
export const STATE_DIR = join(homedir(), 'Library', 'Application Support', 'shuyun')

/** 菜单栏标题里的短标签：中文两三个字，避免把状态栏挤爆。 */
const TITLE_LABEL = {
  'screen-capture': '截屏',
  microphone: '录音',
  camera: '摄像',
  'keyboard-listen': '键盘',
  'input-post': '键鼠',
  'screen-timer': '截屏',
  'file-scan': '扫文件',
  'full-disk': '全盘',
  accessibility: '读界面',
  'clipboard-read': '剪贴板',
  'browser-url': '读网页',
  'browser-window': '浏览器',
  watermark: '水印',
  'frontmost-app': '前台',
  software: '软件',
  upload: '上报',
  'screen-lock': '锁屏',
  'apple-events': '控应用',
  'external-disk': '外接盘',
  bluetooth: '蓝牙'
}

const COLOR = {
  high: '#e5484d',
  medium: '#d98b17',
  low: '#8a8f98',
  idle: '#8a8f98'
}

const TONE_RANK = { high: 3, medium: 2, low: 1 }

function age(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 4000) return '刚刚'
  if (ms < 10000) return `${Math.round(ms / 1000)}s`
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

function clock(ts) {
  if (!ts) return '--:--'
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** 和客户端徽标同一套口径：优先最新动作，时间接近时再比危险度。 */
function pickHeadline(actions) {
  const active = (actions || []).filter(item => item.active)
  if (!active.length) return null
  return active.slice().sort((a, b) => {
    const gap = b.lastAt - a.lastAt
    if (Math.abs(gap) > 3000) return gap
    return (TONE_RANK[b.severity] || 0) - (TONE_RANK[a.severity] || 0)
  })[0]
}

/**
 * 渲染菜单栏标题。
 * @param snapshot 采集器快照
 * @returns 一行 SwiftBar 标题文本（含参数段）
 */
export function renderTitle(snapshot) {
  const now = Date.now()
  if (!snapshot) return '云枢 · 等待中 | color=#8a8f98'
  const top = pickHeadline(snapshot.actions)
  const screenOn = Boolean(snapshot.screenCapture && snapshot.screenCapture.enabled)

  if (top) {
    const label = TITLE_LABEL[top.key] || top.label
    const when = age(now - top.lastAt)
    return `云枢 · ${label} ${when} | color=${COLOR[top.severity] || COLOR.idle} font=system-ui`
  }
  if (screenOn) return `云枢 · 截屏常开 | color=${COLOR.medium}`
  return `云枢 · 静默 | color=${COLOR.idle}`
}

/**
 * 渲染下拉菜单正文（不含首行的 `---` 分隔）。
 * @param snapshot 采集器快照
 */
/** SwiftBar 会把没有 action 的菜单项渲染成禁用态（发灰），信息行挂个空动作保持正常对比度。 */
const NOOP = 'bash=/usr/bin/true terminal=false'

/** 菜单里一行最多显示多少字；超出部分用省略号，完整内容仍留在 tooltip 里。 */
const clip = (text, max = 56) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function renderMenu(snapshot) {
  const now = Date.now()
  const lines = []
  const actions = (snapshot && snapshot.actions) || []
  const active = actions.filter(item => item.active).slice(0, 5)
  const events = (snapshot && snapshot.events) || []
  const agent = (snapshot && snapshot.agent) || {}
  const screen = (snapshot && snapshot.screenCapture) || {}
  const source = (snapshot && snapshot.source) || {}

  // SwiftBar 的约定：首行是菜单栏标题，之后每个正好 `---` 的行才是分隔线。
  // 行首的 `--` 会被当成子菜单，所以明细行一律不加前缀。
  lines.push(`云枢监控实况 | size=13 color=#b9bdc4 ${NOOP}`)
  lines.push('---')

  const facts = []
  facts.push(agent.running ? `在线 · ${(agent.processes || []).length} 个进程` : '未发现进程')
  if (screen.enabled === true) facts.push('截屏开启')
  if (agent.remoteDesk) facts.push('远程协助在线')
  lines.push(`${facts.join(' · ')} | size=11 color=#b9bdc4 ${NOOP}`)

  lines.push('---')
  lines.push(`此刻正在做 | size=11 color=#b9bdc4 ${NOOP}`)
  if (active.length > 0) {
    for (const item of active) {
      const label = TITLE_LABEL[item.key] || item.label
      const detail = item.detail ? ` — ${item.detail}` : ''
      lines.push(`${clip(`${label} ${age(now - item.lastAt)}${detail}`)} | color=${COLOR[item.severity] || COLOR.idle} size=12 trim=true ${NOOP}`)
    }
  } else {
    lines.push(`最近几十秒没有新的采集动作 | color=#b9bdc4 size=12 ${NOOP}`)
  }

  lines.push('---')
  lines.push(`最近动作 | size=11 color=#b9bdc4 ${NOOP}`)
  if (events.length > 0) {
    for (const event of events.slice(0, 5)) {
      const detail = event.detail ? ` — ${event.detail}` : ''
      lines.push(`${clip(`${clock(event.ts)} ${event.label}${detail}`)} | color=#9aa0a6 size=11 trim=true ${NOOP}`)
    }
  } else {
    lines.push(`还没有记录到动作 | color=#b9bdc4 size=12 ${NOOP}`)
  }

  lines.push('---')
  const tcc = source.tcc === 'live' ? '权限日志已连接' : `权限日志：${source.tcc || '未知'}`
  const log = source.agentLog === 'missing' ? '云枢日志缺失' : '云枢日志已连接'
  lines.push(`${tcc} · ${log} | size=11 color=#b9bdc4 ${NOOP}`)
  const scanFile = (snapshot && snapshot.current && snapshot.current.scanFile) || ''
  lines.push(scanFile ? `最近扫描：${scanFile} | size=11 color=#b9bdc4 ${NOOP}` : `最近扫描：无 | size=11 color=#b9bdc4 ${NOOP}`)
  lines.push('---')
  lines.push('刷新 | refresh=true size=11')
  return lines.join('\n')
}

/** 原子落盘：先写临时文件再 rename，SwiftBar 不会读到半个文件。 */
async function writeAtomic(path, text) {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, path)
}

/**
 * 写出一组 SwiftBar 可读的文件。
 * @param snapshot 采集器快照
 */
export async function publish(snapshot) {
  await mkdir(STATE_DIR, { recursive: true })
  await writeAtomic(join(STATE_DIR, 'menubar.txt'), renderTitle(snapshot))
  await writeAtomic(join(STATE_DIR, 'menu.txt'), renderMenu(snapshot))
  await writeAtomic(join(STATE_DIR, 'state.json'), JSON.stringify(snapshot, null, 2))
}

/** SwiftBar 的插件目录（用户在 SwiftBar 里配置的默认位置）。 */
export const SWIFTBAR_DIR = join(homedir(), 'Library', 'Application Support', 'SwiftBar', 'Plugins')
export const SWIFTBAR_SCRIPT = join(SWIFTBAR_DIR, 'shuyun.2s.sh')

/** 改名前的旧脚本名：启动时清掉，免得菜单栏里同时挂着旧条目（会一直显示「未连接」）。 */
const LEGACY_SCRIPTS = [join(SWIFTBAR_DIR, 'yunshu-watch.2s.sh')]

/**
 * SwiftBar 插件脚本本体：只做「读文件 + 打印」，所有判断都在上面的渲染函数里，
 * 这样状态栏文案和下拉菜单只有一份实现。
 */
const SWIFTBAR_SOURCE = `#!/bin/bash
# 云枢监控实况 —— 菜单栏条目。
# 数据由 DSH 插件 shuyun 每 2 秒写入 ~/Library/Application Support/shuyun/。
# 删除本文件即可从菜单栏移除这个条目。
SETUP="$HOME/Library/Application Support/shuyun"
TITLE="$SETUP/menubar.txt"
MENU="$SETUP/menu.txt"

stale=1
if [ -f "$TITLE" ]; then
  mtime=$(stat -f %m "$TITLE" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ $(( now - mtime )) -le 20 ] && [ -f "$MENU" ]; then stale=0; fi
fi

if [ "$stale" -eq 0 ]; then
  cat "$TITLE"
  echo "---"
  cat "$MENU"
else
  echo "云枢 · 未连接 | color=#8a8f98"
  echo "---"
  echo "DSH 没有运行，或者「云枢监控实况」插件未启动"
  echo "---"
  echo "重新检测 | refresh=true size=11"
fi
`

/**
 * 确保 SwiftBar 里有一个「云枢」菜单栏条目。
 * SwiftBar 没装就安静跳过，不制造多余目录。
 * @returns 安装结果，便于启动日志/排查
 */
export async function ensureSwiftBarPlugin() {
  const info = await stat(SWIFTBAR_DIR).catch(() => null)
  if (!info || !info.isDirectory()) return 'no-swiftbar'
  for (const legacy of LEGACY_SCRIPTS) await unlink(legacy).catch(() => {})
  const current = await readFile(SWIFTBAR_SCRIPT, 'utf8').catch(() => null)
  if (current === SWIFTBAR_SOURCE) {
    await chmod(SWIFTBAR_SCRIPT, 0o755).catch(() => {})
    return 'unchanged'
  }
  await writeFile(SWIFTBAR_SCRIPT, SWIFTBAR_SOURCE, 'utf8')
  await chmod(SWIFTBAR_SCRIPT, 0o755)
  return current === null ? 'created' : 'updated'
}
