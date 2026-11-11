/**
 * 云枢（Yunshu）监控实况 —— 客户端入口。
 *
 * 在会话顶栏（和日期同一行）右侧功能位渲染一个常驻徽标，轮询本机
 * /api/shuyun/state，实时显示云枢此刻在对这台 Mac 做什么：
 * 截屏、录音、摄像头、键盘监听、扫描文件、剪贴板上报……
 *
 * 这个文件是「已构建的单文件模块」：Desktop 不负责构建，所以这里直接写
 * window.__ModuleLoader__ 的工厂函数，只用 shared baseline 里的 react / react-dom。
 */
window.__ModuleLoader__.load({
  id: 'shuyun',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const STATE_URL = '/api/shuyun/state'
    const POLL_MS = 2000

    // ---------------------------------------------------------------- 样式
    const CSS = [
      '.ysw-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:999px;',
      'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#5b5f66);',
      'font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;max-width:280px;overflow:hidden;',
      'transition:background .12s ease,border-color .12s ease}',
      '.ysw-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}',
      '.ysw-chip[data-active="true"]{border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.2));color:var(--dsw-alias-label-primary,#17191c)}',
      '.ysw-chip:focus-visible{outline:2px solid var(--dsw-alias-system-accent,#3b7bff);outline-offset:2px}',
      '.ysw-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#9aa0a6}',
      '.ysw-dot[data-tone="high"]{background:#e5484d}',
      '.ysw-dot[data-tone="medium"]{background:#d98b17}',
      '.ysw-dot[data-tone="low"]{background:#6b7280}',
      '.ysw-dot[data-pulse="true"]{animation:ysw-pulse 1.6s ease-out infinite}',
      '@keyframes ysw-pulse{0%{box-shadow:0 0 0 0 rgba(229,72,77,.55)}70%{box-shadow:0 0 0 6px rgba(229,72,77,0)}100%{box-shadow:0 0 0 0 rgba(229,72,77,0)}}',
      '.ysw-name{font-weight:600;flex:none}',
      '.ysw-sep{opacity:.45;flex:none}',
      '.ysw-state{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.ysw-ago{opacity:.6;font-variant-numeric:tabular-nums;flex:none}',
      '.ysw-pop{position:fixed;width:352px;max-width:calc(100vw - 24px);max-height:min(62vh,520px);overflow:auto;',
      'background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#17191c);',
      'border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:12px;',
      'box-shadow:0 12px 32px rgba(0,0,0,.18);z-index:2147483000;padding:12px 14px 10px;font-size:12px;line-height:1.5}',
      '.ysw-pop-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}',
      '.ysw-pop-title{font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px}',
      '.ysw-pop-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8d98);font-variant-numeric:tabular-nums}',
      '.ysw-fin{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}',
      '.ysw-fin-item{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;',
      'background:var(--dsw-alias-bg-secondary,rgba(0,0,0,.04));font-size:11px;color:var(--dsw-alias-label-secondary,#5b5f66)}',
      '.ysw-section{margin-top:8px}',
      '.ysw-section-title{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8d98);margin:0 0 4px;font-weight:600;letter-spacing:.02em}',
      '.ysw-row{display:flex;align-items:baseline;gap:8px;padding:3px 0;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '.ysw-row:last-child{border-bottom:none}',
      '.ysw-time{font-size:11px;color:var(--dsw-alias-label-tertiary,#8b8d98);font-variant-numeric:tabular-nums;flex:none;min-width:52px}',
      '.ysw-label{flex:none;font-weight:500}',
      '.ysw-detail{color:var(--dsw-alias-label-secondary,#5b5f66);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:right}',
      '.ysw-foot{margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));',
      'color:var(--dsw-alias-label-tertiary,#8b8d98);font-size:11px;display:flex;justify-content:space-between;gap:8px}',
      '.ysw-empty{color:var(--dsw-alias-label-tertiary,#8b8d98);font-size:11px;padding:2px 0}',
      '.ysw-warn{color:#b4531a}'
    ].join('')

    const styleId = 'shuyun/styles'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css="' + styleId + '"]')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'shuyun'
      tag.dataset.pluginCss = styleId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------- 文案与工具
    /** 把内部动作 key 收敛成一句人话。 */
    const SHORT_STATE = {
      'screen-capture': '正在截屏',
      microphone: '正在录音',
      camera: '正在采集摄像头',
      'keyboard-listen': '正在监听键盘',
      'input-post': '正在模拟键鼠',
      'screen-timer': '定时截屏中',
      'file-scan': '正在扫描文件',
      'full-disk': '访问全盘文件',
      accessibility: '读取界面元素',
      'clipboard-read': '读取剪贴板',
      'browser-url': '正在读取网页地址',
      'browser-window': '统计浏览器窗口',
      watermark: '屏幕水印采集',
      'frontmost-app': '跟踪前台应用',
      software: '采集软件清单',
      upload: '上报服务端',
      'screen-lock': '探测锁屏',
      'apple-events': '控制其他应用',
      'external-disk': '读外接存储',
      bluetooth: '访问蓝牙'
    }

    const TONE_RANK = { high: 3, medium: 2, low: 1 }

    function ago(ms) {
      if (!Number.isFinite(ms) || ms < 0) return ''
      if (ms < 4000) return '刚刚'
      if (ms < 60000) return `${Math.round(ms / 1000)} 秒前`
      if (ms < 3600000) return `${Math.round(ms / 60000)} 分钟前`
      return `${Math.round(ms / 3600000)} 小时前`
    }

    function clock(ts) {
      if (!ts) return '--:--:--'
      return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })
    }

    /**
     * 徽标上展示的那件事：优先「刚刚发生的动作」，因为用户想知道的是它此刻在做什么；
     * 时间相近时再按严重度挑更值得警惕的那个。这样文字只在真有新动作时变化，不会每两秒跳字。
     */
    function headline(snapshot) {
      if (!snapshot || !Array.isArray(snapshot.actions)) return null
      const active = snapshot.actions.filter(item => item.active)
      if (!active.length) return null
      return active.slice().sort((a, b) => {
        const gap = b.lastAt - a.lastAt
        if (Math.abs(gap) > 3000) return gap
        return (TONE_RANK[b.severity] || 0) - (TONE_RANK[a.severity] || 0)
      })[0]
    }

    /** 这些动作是「此刻正在发生」的瞬间行为，值得让圆点呼吸；常驻能力不呼吸。 */
    const PULSE_KEYS = new Set(['screen-capture', 'microphone', 'camera', 'keyboard-listen', 'input-post', 'file-scan'])

    // --------------------------------------------------------------- 数据层
    /** 轮询本机接口；失败时保留上一份数据，只把状态标成 error。 */
    function useSnapshot() {
      const [state, setState] = useState({ phase: 'loading', snapshot: null, error: '' })
      const aliveRef = useRef(true)

      useEffect(() => {
        aliveRef.current = true
        let timer = null

        const tick = async () => {
          try {
            const response = await fetch(STATE_URL, {
              method: 'GET',
              headers: { accept: 'application/json' },
              cache: 'no-store',
              credentials: 'same-origin'
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const snapshot = await response.json()
            if (aliveRef.current) {
              setState({ phase: 'ready', snapshot: { ...snapshot, receivedAt: Date.now() }, error: '' })
            }
          } catch (error) {
            if (aliveRef.current) {
              setState(previous => ({
                phase: 'error',
                snapshot: previous.snapshot,
                error: error && error.message ? error.message : String(error)
              }))
            }
          } finally {
            if (aliveRef.current) timer = setTimeout(tick, POLL_MS)
          }
        }

        tick()
        return () => {
          aliveRef.current = false
          if (timer) clearTimeout(timer)
        }
      }, [])

      return state
    }

    // --------------------------------------------------------------- 弹层
    function Section({ title, children }) {
      return h('div', { className: 'ysw-section' },
        h('div', { className: 'ysw-section-title' }, title),
        children
      )
    }

    function ActionRow({ left, label, detail, right, tone, keyName }) {
      return h('div', { className: 'ysw-row', key: keyName },
        left ? h('span', { className: 'ysw-time' }, left) : null,
        tone ? h('span', { className: 'ysw-dot', 'data-tone': tone }) : null,
        h('span', { className: 'ysw-label' }, label),
        h('span', { className: 'ysw-detail', title: detail || '' }, detail || ''),
        right ? h('span', { className: 'ysw-ago' }, right) : null
      )
    }

    function Popover({ snapshot, error, anchor, onClose }) {
      const boxRef = useRef(null)
      const [position, setPosition] = useState({ top: -9999, left: -9999 })

      useEffect(() => {
        const place = () => {
          const rect = anchor.current && anchor.current.getBoundingClientRect()
          if (!rect) return
          const width = 352
          const margin = 12
          const left = Math.min(
            Math.max(margin, rect.right - width),
            Math.max(margin, window.innerWidth - width - margin)
          )
          setPosition({ top: Math.min(rect.bottom + 8, window.innerHeight - 80), left })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [anchor])

      useEffect(() => {
        const onPointerDown = event => {
          if (boxRef.current && boxRef.current.contains(event.target)) return
          if (anchor.current && anchor.current.contains(event.target)) return
          onClose()
        }
        const onKeyDown = event => { if (event.key === 'Escape') onClose() }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [anchor, onClose])

      const now = Date.now()
      const actions = (snapshot && snapshot.actions) || []
      const current = actions.filter(item => item.active).slice(0, 6)
      const recent = (snapshot && snapshot.events) || []
      const source = (snapshot && snapshot.source) || {}
      const agent = (snapshot && snapshot.agent) || {}
      const screen = (snapshot && snapshot.screenCapture) || {}

      const facts = []
      facts.push(h('span', { className: 'ysw-fin-item', key: 'fin-agent' },
        agent.running ? `云枢在线 · ${(agent.processes || []).length} 个进程` : '未发现云枢进程'))
      if (screen.enabled === true) facts.push(h('span', { className: 'ysw-fin-item', key: 'fin-screen' }, '截屏：已开启'))
      if (screen.enabled === false) facts.push(h('span', { className: 'ysw-fin-item', key: 'fin-screen' }, '截屏：关闭'))
      if (agent.remoteDesk) facts.push(h('span', { className: 'ysw-fin-item', key: 'fin-remote' }, '远程协助服务在线'))

      const currentRows = current.length
        ? current.map(item => h(ActionRow, {
            key: `now-${item.key}`,
            keyName: `now-${item.key}`,
            tone: item.severity,
            label: SHORT_STATE[item.key] || item.label,
            detail: item.detail || '',
            right: ago(now - item.lastAt)
          }))
        : [h('div', { className: 'ysw-empty', key: 'empty' },
            error ? `读取失败：${error}（保留上次结果）` : '最近几十秒没有新的采集动作')]

      const recentRows = recent.length
        ? recent.slice(0, 10).map((event, index) => h(ActionRow, {
            key: `ev-${event.ts}-${index}`,
            keyName: `ev-${event.ts}-${index}`,
            left: clock(event.ts),
            label: event.label,
            detail: event.detail || ''
          }))
        : [h('div', { className: 'ysw-empty', key: 'empty' }, '还没有记录到动作')]

      const sourceLabel = source.tcc === 'live'
        ? '系统权限日志：已连接'
        : `系统权限日志：${source.tcc === 'unavailable' ? '不可用' : (source.tcc || '连接中')}`

      const panel = h('div', {
        ref: boxRef,
        className: 'ysw-pop',
        style: { top: position.top, left: position.left },
        role: 'dialog',
        'aria-label': '云枢监控实况'
      },
        h('div', { className: 'ysw-pop-head' },
          h('div', { className: 'ysw-pop-title' },
            h('span', {
              className: 'ysw-dot',
              'data-tone': current.length ? current[0].severity : 'low',
              'data-pulse': String(current.some(item => item.severity === 'high'))
            }),
            '云枢监控实况'
          ),
          h('div', { className: 'ysw-pop-sub' },
            snapshot ? `更新 ${clock(snapshot.receivedAt || now)}` : '连接中…')
        ),
        h('div', { className: 'ysw-fin' }, facts),
        h(Section, { title: '此刻正在做' }, currentRows),
        h(Section, { title: '最近动作' }, recentRows),
        h('div', { className: 'ysw-foot' },
          h('span', null, sourceLabel),
          h('span', { className: source.agentLog === 'missing' ? 'ysw-warn' : undefined },
            source.agentLog === 'missing' ? '云枢日志未找到' : '云枢日志：已连接')
        )
      )

      return ReactDOM.createPortal(panel, document.body)
    }

    // --------------------------------------------------------------- 徽标
    function YunshuHeaderChip() {
      const { phase, snapshot, error } = useSnapshot()
      const [open, setOpen] = useState(false)
      const anchorRef = useRef(null)
      const close = useCallback(() => setOpen(false), [])

      const top = headline(snapshot)
      const now = Date.now()
      const screenOn = Boolean(snapshot && snapshot.screenCapture && snapshot.screenCapture.enabled)

      let tone = 'low'
      let text = '静默'
      let timeText = ''

      if (phase === 'error' && !snapshot) {
        text = '连接中断'
      } else if (top) {
        tone = top.severity
        text = SHORT_STATE[top.key] || top.label
        timeText = ago(now - top.lastAt)
      } else if (screenOn) {
        tone = 'medium'
        text = '截屏已开启'
      } else if (snapshot) {
        const latest = (snapshot.actions || [])[0]
        if (latest) {
          text = `最近：${SHORT_STATE[latest.key] || latest.label}`
          timeText = ago(now - latest.lastAt)
        }
      }

      const label = `云枢监控：${text}${timeText ? '，' + timeText : ''}。点击查看详情`

      const chip = h('button', {
        ref: anchorRef,
        type: 'button',
        className: 'ysw-chip',
        'data-active': String(Boolean(top)),
        'aria-label': label,
        'aria-expanded': open,
        'aria-haspopup': 'dialog',
        title: label,
        onClick: () => setOpen(value => !value)
      },
        h('span', {
          className: 'ysw-dot',
          'data-tone': tone,
          'data-pulse': String(Boolean(top && top.severity === 'high'))
        }),
        h('span', { className: 'ysw-name' }, '云枢'),
        h('span', { className: 'ysw-sep' }, '·'),
        h('span', { className: 'ysw-state' }, text),
        timeText ? h('span', { className: 'ysw-ago' }, timeText) : null
      )

      return h(React.Fragment, null,
        chip,
        open ? h(Popover, { snapshot, error, anchor: anchorRef, onClose: close }) : null
      )
    }

    // --------------------------------------------------------------- 注册
    function apply(ctx) {
      // 顶栏右侧功能位：与日期、定时任务时钟同一行；列表型 slot 允许多个条目并存。
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: 'shuyun',
        order: 5,
        inject: () => ({})
      }, YunshuHeaderChip))
    }

    module.exports = { apply, inject: ['slots'] }
    return module.exports
  }
})
