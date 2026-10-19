import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { fetch } from 'undici'
import { setTimeout as delay } from 'node:timers/promises'
import type { Place } from './places.ts'

export interface AmapOptions { amapEnvFile?: string; amapKeyFile?: string; amapTimeoutMs?: number }
export interface AmapSnapshot { dataUrl: string; bounds: [number, number, number, number] }
type Point = { latitude: number; longitude: number }
const validPoint = (p: Point) => Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 85 && Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180
let nextRequestAt = 0

export async function amapKey(options: AmapOptions): Promise<string> {
  let key = process.env.DSH_AMAP_KEY?.trim()
  if (!key) {
    // Built output lives at lib/amap.js; resolve relative to the plugin, not DSH's cwd.
    const file = options.amapEnvFile || new URL('../.env', import.meta.url)
    try { key = parseEnv(await readFile(file, 'utf8')).DSH_AMAP_KEY?.trim() }
    catch (error) {
      if (options.amapEnvFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取高德 .env 文件，请检查 amapEnvFile 配置和文件权限。')
    }
  }
  if (!key && options.amapKeyFile) {
    try { key = (await readFile(options.amapKeyFile, 'utf8')).trim() } catch { throw new Error('无法读取高德 Key 文件，请检查 amapKeyFile 配置。') }
  }
  if (!key || !/^[a-f0-9]{32}$/i.test(key)) throw new Error('请在插件目录的 .env 中设置 DSH_AMAP_KEY，或配置环境变量、amapEnvFile。')
  return key
}

/** Only official server APIs; never return request URLs, keys or raw transport errors. */
async function request(path: '/v3/place/text' | '/v3/assistant/coordinate/convert' | '/v3/staticmap', parameters: Record<string, string>, key: string, options: AmapOptions, parent: AbortSignal, attempt = 0): Promise<{ bytes: Buffer; type: string }> {
  parent.throwIfAborted()
  // Shared pacing also covers simultaneous sessions using a personal account.
  const slot = Math.max(Date.now(), nextRequestAt); nextRequestAt = slot + 1100
  await delay(Math.max(0, slot - Date.now()), undefined, { signal: parent })
  const signal = AbortSignal.any([parent, AbortSignal.timeout(options.amapTimeoutMs ?? 15000)])
  const url = new URL(path, 'https://restapi.amap.com')
  url.search = new URLSearchParams({ ...parameters, key }).toString()
  try {
    const response = await fetch(url, { signal, redirect: 'error', credentials: 'omit' })
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`高德服务 HTTP ${response.status}`) }
    const chunks: Uint8Array[] = []; let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > 1000000) throw new Error('高德响应超过大小限制')
      chunks.push(chunk)
    }
    const bytes = Buffer.concat(chunks), type = (response.headers.get('content-type') ?? '').split(';')[0]
    if (type.includes('json') && attempt < 2) {
      let code
      try { code = JSON.parse(bytes.toString('utf8')).infocode } catch { /* Validated by the JSON boundary below. */ }
      if (['10020', '10021'].includes(String(code))) return request(path, parameters, key, options, parent, attempt + 1)
    }
    return { bytes, type }
  } catch (error) {
    parent.throwIfAborted()
    if (error instanceof Error && /^高德/.test(error.message)) throw error
    throw new Error(signal.aborted ? '高德请求超时，请稍后重试。' : '高德请求失败，请检查网络连接。')
  }
}
function json(bytes: Buffer): any {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('高德服务返回了无效数据') }
  if (String(value.status) !== '1') {
    const code = /^\d{5}$/.test(String(value.infocode)) ? String(value.infocode) : 'UNKNOWN'
    const hint = code === '10001' ? 'Key 无效' : code === '10005' ? 'IP 白名单不匹配' : code === '10009' ? '需要 Web服务 类型的 Key' : ['10003', '10004', '10020', '10021', '10044'].includes(code) ? '配额或并发受限' : '请检查服务权限与控制台状态'
    throw new Error(`高德接口错误 ${code}：${hint}`)
  }
  return value
}
export async function resolveAmapPlace(name: string, city: string, key: string, options: AmapOptions, signal: AbortSignal): Promise<Place> {
  if (!name.trim() || name.length > 160 || city.length > 100) throw new Error('无效的高德地点查询')
  const result = json((await request('/v3/place/text', { keywords: name, city, citylimit: city ? 'true' : 'false', offset: '10', page: '1', extensions: 'base', output: 'JSON' }, key, options, signal)).bytes)
  const rows = (Array.isArray(result.pois) ? result.pois : []).filter((p: any) => typeof p.name === 'string' && typeof p.location === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(p.id))
  const exact = rows.filter((p: any) => p.name === name)
  const choices = exact.length ? exact : rows
  if (!choices.length || choices.length > 1 && !city.trim()) throw new Error(`“${name}”${choices.length ? '有多个匹配，请补充城市或更准确的名称' : '未找到可验证的地点'}。`)
  // Within an explicitly constrained city, preserve AMap's relevance ranking.
  const p = choices[0], [longitude, latitude] = p.location.split(',').map(Number)
  if (!validPoint({ latitude, longitude })) throw new Error(`“${name}”没有有效坐标。`)
  return { title: p.name, language: 'zh', latitude, longitude, source: `https://www.amap.com/place/${p.id}` }
}
export async function convertAmapPoint(point: Point, key: string, options: AmapOptions, signal: AbortSignal): Promise<Point> {
  if (!validPoint(point)) throw new Error('无效的 WGS84 坐标')
  const value = json((await request('/v3/assistant/coordinate/convert', { locations: `${point.longitude},${point.latitude}`, coordsys: 'gps', output: 'JSON' }, key, options, signal)).bytes)
  if (typeof value.locations !== 'string') throw new Error('高德坐标转换失败')
  const [longitude, latitude] = value.locations.split(',').map(Number), result = { latitude, longitude }
  if (!validPoint(result)) throw new Error('高德坐标转换返回了无效坐标')
  return result
}
// AMap staticmap's named zoom uses a 512-pixel world at level 0. Leaflet's
// default CRS uses 256. Keep the API's scale here, not Leaflet's zoom scale.
// Verified against two official staticmap markers at explicit GCJ-02 positions.
const STATIC_WORLD_PIXELS = 512
/** Compute the actual image footprint, independent of the client's viewing zoom. */
export function amapView(stops: Point[], width = 640, height = 360) {
  if (!stops.length || stops.some(p => !validPoint(p))) throw new Error('无效的地图范围')
  const project = (p: Point) => [(p.longitude + 180) / 360, (1 - Math.asinh(Math.tan(p.latitude * Math.PI / 180)) / Math.PI) / 2]
  const pts = stops.map(project), xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  if (Math.max(...xs) - Math.min(...xs) > .5) throw new Error('高德地图暂不支持跨日期变更线行程')
  const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = (Math.min(...ys) + Math.max(...ys)) / 2
  let zoom = 16
  while (zoom > 1 && ((Math.max(...xs) - Math.min(...xs)) * STATIC_WORLD_PIXELS * 2 ** zoom > width - 80 || (Math.max(...ys) - Math.min(...ys)) * STATIC_WORLD_PIXELS * 2 ** zoom > height - 80)) zoom--
  const longitude = (x: number) => x * 360 - 180
  const latitude = (y: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI
  // The center is rounded exactly as sent to AMap; use that center for image bounds too.
  const center = { latitude: +latitude(y).toFixed(6), longitude: +longitude(x).toFixed(6) }
  const [cx, cy] = project(center), dx = width / (2 * STATIC_WORLD_PIXELS * 2 ** zoom), dy = height / (2 * STATIC_WORLD_PIXELS * 2 ** zoom)
  return { center, zoom, bounds: [latitude(cy + dy), longitude(cx - dx), latitude(cy - dy), longitude(cx + dx)] as AmapSnapshot['bounds'] }
}
export async function loadAmapSnapshot(stops: Point[], key: string, options: AmapOptions, signal: AbortSignal): Promise<AmapSnapshot> {
  for (const width of [640, 480, 320]) {
    const height = Math.round(width * 9 / 16), view = amapView(stops, width, height)
    const { bytes, type } = await request('/v3/staticmap', { location: `${view.center.longitude},${view.center.latitude}`, zoom: String(view.zoom), size: `${width}*${height}`, scale: '1', traffic: '0' }, key, options, signal)
    if (type.includes('json') || bytes[0] === 123) json(bytes)
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.length < 24 || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw new Error('高德底图不是预期尺寸的 PNG 图片')
    const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
    if (dataUrl.length <= 150000) return { dataUrl, bounds: view.bounds }
  }
  throw new Error('高德底图超过文档大小限制，请缩小行程范围。')
}
