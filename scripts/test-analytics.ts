// 访问统计（kernel/src/analytics.ts）：打开事件、页面停留累计、离线队列、发送通道。
// 纯函数 + 可注入的时钟/存储/传输，跟 test-expr.ts 一样手写断言。
import {
  DwellTracker, QUEUE_KEY, buildOpenEvent, buildPagesEvent, endpoint, flushQueue, openedVia, queueStats, report, sendStats,
} from '../kernel/src/analytics.ts'

let failures = 0
let checks = 0
function ok(cond: boolean, msg: string) {
  checks++
  if (!cond) { failures++; console.error(`  ✗ ${msg}`) }
}

// 内存版 localStorage
function memStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(), key: () => null, get length() { return m.size },
  } as Storage
}
// 记录型传输：sendBeacon 成功/失败可控
function memTransport(accept = true) {
  const calls: Array<{ url: string; body: string }> = []
  const pending: Promise<void>[] = []
  const transport = {
    sendBeacon(url: string, body: Blob) {
      pending.push(body.text().then((txt) => { calls.push({ url, body: txt }) }))
      return accept
    },
  }
  return { transport, calls, settle: () => Promise.all(pending) }
}

const doc = { docId: 'doc-1', title: '看板', meta: { subject: '张三 GT001' }, analytics: { url: 'https://lic.zcpz.cc/', id: 'GT001-big' } }

console.log('端点与打开事件…')
ok(endpoint(doc.analytics) === 'https://lic.zcpz.cc/v1/open', '去掉尾斜杠 + /v1/open')
ok(openedVia('file:///C:/x.bento.html') === 'file' && openedVia('https://a/b') === 'https' && openedVia('http://1.2.3.4/x') === 'http', 'via 判定')
const env = { href: 'file:///tmp/a.bento.html', ua: 'x'.repeat(300), tz: 'Asia/Shanghai', lang: 'zh-CN', screen: '2560x1440' }
const open = buildOpenEvent(doc, '李四', env, new Date('2026-09-07T01:02:03Z'))
ok(open.t === 'open' && open.id === 'GT001-big' && open.docId === 'doc-1', '事件 id 取 analytics.id，docId 保留')
ok(open.viewer === '李四' && open.holder === '张三 GT001' && open.via === 'file', '观看者 / 持有人 / 打开方式')
ok(open.ua.length === 160 && open.at === '2026-09-07T01:02:03.000Z', 'UA 截断到 160、时间 ISO')
ok(buildOpenEvent({ docId: 'd2', title: 't' }, '', env).id === 'd2', '无 analytics.id 时回退 docId')

console.log('页面停留…')
let now = 1_000_000
const dw = new DwellTracker(() => now)
ok(dw.drain().length === 0 && dw.current === -1, '空累计')
dw.enter(0, 's1', '封面'); now += 4_000
dw.enter(1, 's2', '指南'); now += 2_500
dw.enter(0, 's1', '封面'); now += 1_000
let pages = dw.drain()
ok(pages.length === 2 && pages[0].idx === 0 && pages[0].sec === 5 && pages[1].sec === 2.5, '同页累加、按序号排序、0.1s 精度')
ok(dw.current === 0, 'drain 后当前页继续计时')
now += 3_000
dw.leave(); now += 60_000            // 隐藏期间不计
dw.enter(2, 's3', '目录'); now += 1_000
pages = dw.drain()
ok(pages.length === 2 && pages[0].sec === 3 && pages[1].idx === 2 && pages[1].sec === 1, 'leave 后停止计时，再 enter 恢复')
const pe = buildPagesEvent(doc, '李四', pages, 2, new Date('2026-09-07T01:10:00Z'))
ok(pe.t === 'pages' && pe.total === 4 && pe.last === 2 && pe.id === 'GT001-big', 'pages 事件汇总')

console.log('发送通道…')
{
  const { transport, calls, settle } = memTransport(true)
  ok(sendStats('https://x/v1/open', open, transport) === true, 'sendBeacon 接受')
  await settle()
  ok(calls.length === 1 && calls[0].url === 'https://x/v1/open' && JSON.parse(calls[0].body).t === 'open', '正文是事件 JSON')
  let fetched: any = null
  const viaFetch = { fetch: ((url: string, init: any) => { fetched = { url, init }; return Promise.resolve(new Response()) }) as any }
  ok(sendStats('https://y/v1/open', open, viaFetch) === true && fetched.init.mode === 'no-cors' && fetched.init.keepalive === true && fetched.init.headers['content-type'] === 'text/plain', '无 sendBeacon 时走 no-cors keepalive fetch，text/plain 简单请求')
  ok(sendStats('https://z', open, {} as any) === false || typeof globalThis.fetch === 'function', '两者都没有 → false')
}

console.log('离线队列…')
{
  const st = memStorage()
  const { transport, calls, settle } = memTransport(true)
  ok(report(doc.analytics, open, { online: false, offlineSwitch: false, storage: st, transport }) === 'queued', '离线 → queued')
  ok(JSON.parse(st.getItem(QUEUE_KEY)!).length === 1, '队列落盘 1 条')
  ok(report(doc.analytics, pe, { online: true, offlineSwitch: false, storage: st, transport }) === 'sent', '联网 → sent')
  await settle()
  ok(calls.length === 2 && JSON.parse(calls[0].body).t === 'open' && JSON.parse(calls[1].body).t === 'pages', '联网时先补发队列再发本次')
  ok(st.getItem(QUEUE_KEY) === null, '补发后队列清空')
  ok(report(doc.analytics, open, { online: true, offlineSwitch: true, storage: st, transport }) === 'skipped', '离线开关 → skipped，不入队')
  ok(report({ url: '' }, open, { online: true, offlineSwitch: false, storage: st, transport }) === 'skipped', '无 url → skipped')
  const rej = memTransport(false)
  ok(report(doc.analytics, open, { online: true, offlineSwitch: false, storage: st, transport: rej.transport }) === 'queued', '浏览器拒收 → 入队待补')
  for (let i = 0; i < 60; i++) queueStats('https://x/v1/open', open, st)
  ok(JSON.parse(st.getItem(QUEUE_KEY)!).length === 50, '队列上限 50')
  ok(flushQueue(st, transport) === 50 && st.getItem(QUEUE_KEY) === null, 'flush 全部发出')
  ok(flushQueue(st, transport) === 0, '空队列 flush = 0')
  const bad = memStorage(); bad.setItem(QUEUE_KEY, '{not json')
  ok(flushQueue(bad, transport) === 0, '坏队列不抛错')
}

console.log(`analytics: ${checks} checks, ${failures} failures`)
if (failures) process.exit(1)
