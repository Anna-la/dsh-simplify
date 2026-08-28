// dsh-simplify server-half standalone test (node, no dependencies)
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'dsh-simplify-test-'))
process.env.DSH_SIMPLIFY_DATA_DIR = dataDir

const mod = await import('../lib/index.js')

const results = []
const ok = (name, cond) => { results.push(`${cond ? '  [PASS]' : '  [FAIL]'} ${name}`) }

const routes = []
const ctx = {
  logger: { info() {}, warn(...a) { console.log('  [warn]', ...a) } },
  inject(list, fn, label) {
    ok(`ctx.inject 收到服务依赖 [${list.join(',')}]`, list[0] === 'webServer')
    const sctx = { get: (k) => (k === 'webServer' ? webServer : null) }
    fn(sctx)
  },
}
const webServer = { register: (route) => routes.push(route) }

mod.apply(ctx)
ok('注册了 1 个路由', routes.length === 1)
ok('路由是 /api/dsh-simplify/records', routes[0].path === '/api/dsh-simplify/records')

const handler = routes[0].handler

function fakeRes() {
  const r = { status: 0, body: '', writeHead(s, h) { this.status = s; this.headers = h }, end(p) { this.body = String(p) } }
  return r
}
function fakeReq(method, opts = {}) {
  const req = { method, socket: { remoteAddress: opts.loopback === false ? '1.2.3.4' : '127.0.0.1' },
    headers: opts.headers || { host: '127.0.0.1:7362', origin: 'http://127.0.0.1:7362' } }
  req[Symbol.asyncIterator] = () => {
    let i = 0
    const chunks = opts.body === undefined ? [] : [Buffer.from(opts.body)]
    return { next: async () => (i < chunks.length ? { value: chunks[i++], done: false } : { done: true }) }
  }
  return req
}

// GET on empty store → { ok: true, records: [] }
{
  const res = fakeRes()
  await handler(fakeReq('GET'), res)
  ok('空库 GET 返回 ok:true 空数组', res.status === 200 && JSON.parse(res.body).ok === true && Array.isArray(JSON.parse(res.body).records) && JSON.parse(res.body).records.length === 0)
}
// PUT with records → 200, file written
{
  const rec = { id: 'r1', xpath: '/html/body/div/x[1]', html: '<div id="x"></div>', parentXpath: '/html/body/div', index: 0, label: '测试元素', removedAt: 123 }
  const res = fakeRes()
  await handler(fakeReq('PUT', { body: JSON.stringify({ records: [rec] }) }), res)
  ok('PUT 返回 200 count=1', res.status === 200 && JSON.parse(res.body).ok === true && JSON.parse(res.body).count === 1)
  const file = join(dataDir, 'records.json')
  ok('records.json 已写入', existsSync(file))
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  ok('文件内容与 PUT 一致', saved.length === 1 && saved[0].id === 'r1' && saved[0].label === '测试元素')
}
// GET after PUT → returns the record
{
  const res = fakeRes()
  await handler(fakeReq('GET'), res)
  const data = JSON.parse(res.body)
  ok('写入后 GET 返回记录', data.ok === true && data.records.length === 1 && data.records[0].id === 'r1')
}
// loopback guard: non-loopback remote → 403
{
  const res = fakeRes()
  await handler(fakeReq('GET', { loopback: false }), res)
  ok('非回环请求被拒绝 403', res.status === 403)
}
// method guard: DELETE → 405
{
  const res = fakeRes()
  await handler(fakeReq('DELETE'), res)
  ok('不支持的方法返回 405', res.status === 405)
}
// bad body → 400
{
  const res = fakeRes()
  await handler(fakeReq('PUT', { body: '{"nope":1}' }), res)
  ok('非法 body 返回 400', res.status === 400)
}
// empty PUT (clear) wipes file
{
  const res = fakeRes()
  await handler(fakeReq('PUT', { body: JSON.stringify({ records: [] }) }), res)
  const saved = JSON.parse(readFileSync(join(dataDir, 'records.json'), 'utf8'))
  ok('清空场景（PUT []）写空数组', saved.length === 0)
}

rmSync(dataDir, { recursive: true, force: true })
const fails = results.filter((r) => r.includes('[FAIL]'))
console.log(results.join('\n'))
console.log(fails.length === 0 ? `\n✔ 服务端半面全部通过 (${results.length})` : `\n✘ 存在失败 (${fails.length} of ${results.length})`)
process.exit(fails.length === 0 ? 0 : 1)