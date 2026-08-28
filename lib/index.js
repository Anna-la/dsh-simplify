// dsh-simplify — node half.
//
// The browser half (client/client.js) removes page elements and keeps removal
// records in localStorage, but localStorage is origin-scoped: DSH relaunches
// the web server on a fresh port each time, so a restarted origin would lose
// every record. This side registers a loopback-only bridge
//
//   GET /api/dsh-simplify/records  -> { ok: true, records: [...] }
//   PUT /api/dsh-simplify/records  -> { ok: true, count: n }
//
// backed by a stable JSON file (~/.dsh-simplify/records.json by default,
// overridable via $DSH_SIMPLIFY_DATA_DIR), so removals survive restarts.
// Follows the same webServer-bridge pattern as dsh-token-stat / dsh-free-search.
import * as os from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export const name = 'dsh-simplify'

const BRIDGE_PREFIX = '/api/dsh-simplify'
const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024

/** Durable records directory: outside DSH_HOME, safe from profile cleans. */
export function pluginDataDir() {
  return process.env.DSH_SIMPLIFY_DATA_DIR?.trim() || join(os.homedir(), '.dsh-simplify')
}

function recordsFile() {
  return join(pluginDataDir(), 'records.json')
}

/** Loopback-only guard: refuse anything that is not from the local page. */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers?.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers?.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead?.(status, { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' })
  res.end?.(payload)
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

export function apply(ctx) {
  const logger = ctx.logger ?? { info() {}, warn() {}, error() {} }

  ctx.inject(['webServer'], (sctx) => {
    const webServer = sctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      logger.warn?.('[dsh-simplify] webServer 服务不可用，跨重启持久化桥未注册（仅 localStorage 会话内持久化）')
      return
    }
    const guard = (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'loopback requests only' })
        return false
      }
      return true
    }
    const routes = [
      {
        kind: 'exact',
        path: `${BRIDGE_PREFIX}/records`,
        handler: async (req, res) => {
          if (!guard(req, res)) return
          if (req.method === 'GET') {
            try {
              let records = []
              try {
                records = JSON.parse(await readFile(recordsFile(), 'utf8'))
              } catch (error) {
                if (error.code !== 'ENOENT') throw error
              }
              if (!Array.isArray(records)) records = []
              writeJson(res, 200, { ok: true, records })
            } catch (error) {
              logger.warn?.('[dsh-simplify] 读取 records 失败:', String(error?.message ?? error))
              writeJson(res, 500, { ok: false, error: 'read failed' })
            }
            return
          }
          if (req.method === 'PUT') {
            const body = await readJsonBody(req)
            if (!body || !Array.isArray(body.records)) {
              writeJson(res, 400, { ok: false, error: 'body must be {"records": [...]}' })
              return
            }
            try {
              await mkdir(pluginDataDir(), { recursive: true })
              await writeFile(recordsFile(), JSON.stringify(body.records, null, 2), 'utf8')
              writeJson(res, 200, { ok: true, count: body.records.length })
            } catch (error) {
              logger.warn?.('[dsh-simplify] 写入 records 失败:', String(error?.message ?? error))
              writeJson(res, 500, { ok: false, error: 'write failed' })
            }
            return
          }
          writeJson(res, 405, { ok: false, error: 'method not allowed' })
        },
      },
    ]
    for (const route of routes) {
      try {
        webServer.register(route)
      } catch (error) {
        logger.warn?.('[dsh-simplify] 注册 webServer 路由失败:', route?.path, String(error))
      }
    }
    logger.info?.('[dsh-simplify] 跨重启持久化桥已就绪:', BRIDGE_PREFIX)
  }, 'dsh-simplify: durable records bridge')
}