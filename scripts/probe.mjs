/** 单独跑采集器，把快照打到终端，用来验证解析逻辑（不依赖 Harness）。 */
import { YunshuCollector } from '../src/collector.js'

const seconds = Number(process.argv[2] ?? 20)
const collector = new YunshuCollector({ intervalMs: 1000 })
collector.start()

const timer = setInterval(() => {
  const snapshot = collector.snapshot()
  console.log(JSON.stringify({
    at: new Date(snapshot.generatedAt).toISOString(),
    agent: snapshot.agent,
    screenCapture: snapshot.screenCapture,
    source: snapshot.source,
    actions: snapshot.actions.map(a => `${a.active ? '●' : '○'} ${a.key} ${a.count}x ${a.detail}`).slice(0, 8),
    events: snapshot.events.slice(0, 6).map(e => `${new Date(e.ts).toLocaleTimeString('zh-CN')} ${e.key} ${e.detail}`)
  }, null, 2))
}, 8000)

setTimeout(async () => {
  clearInterval(timer)
  await collector.stop()
  const final = collector.snapshot()
  console.log('\n=== FINAL ===')
  console.log(JSON.stringify(final, null, 2))
  process.exit(0)
}, seconds * 1000)
