/**
 * 云枢（Yunshu）监控实况插件 —— 服务端入口。
 *
 * 只做两件事：
 *   1. 启动采集器（TCC 日志流 + 云枢日志 + 进程表）；
 *   2. 暴露 GET /api/shuyun/state 给顶部徽标轮询。
 */
import { YunshuCollector } from './collector.js'
import { ensureSwiftBarPlugin, publish } from './menubar.js'

export const name = 'shuyun'
export const inject = ['webServer', 'connection']

const STATE_PATH = '/api/shuyun/state'

/** 统一的小 JSON 响应；监控数据不该被任何缓存留住。 */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(text)
}

export function apply(ctx) {
  const collector = new YunshuCollector()

  // 装好菜单栏条目（SwiftBar 不存在时安静跳过），让「顶部日期旁边」也能看到。
  void ensureSwiftBarPlugin().catch(() => {})

  ctx.effect(() => {
    collector.start()
    // 每 2 秒把快照渲染成 SwiftBar 的菜单栏文本，菜单栏里的「x 秒前」才会一直走动。
    const publishNow = () => { void publish(collector.snapshot()).catch(() => {}) }
    publishNow()
    const timer = setInterval(publishNow, 2000)
    return () => {
      clearInterval(timer)
      void collector.stop()
    }
  }, 'shuyun: collector')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATE_PATH,
    handler: (req, res) => {
      // 和 Desktop 其他本机接口一样，只接受已认证的浏览器会话。
      const rejection = ctx.connection?.requestRejection?.(req)
      if (rejection !== undefined) return json(res, rejection || 403, { ok: false, error: 'authentication required' })
      try {
        return json(res, 200, collector.snapshot())
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    }
  }), `shuyun: ${STATE_PATH}`)
}
