import { fetch, type Dispatcher } from 'undici'
import { VectorTile } from '@mapbox/vector-tile'
import Pbf from 'pbf'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { parseStreetMap, MAX_MAP_CHARS, type StreetMap, type StreetFeature, type MapPoint } from '../shared/street-map.ts'

const UA = 'dsh-intelligent-ui/1.1.0 (+https://github.com/deepseek-ai/deepseek-harness)'
const lon = (x: number, z: number) => x / 2 ** z * 360 - 180
const lat = (y: number, z: number) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) * 180 / Math.PI
export function tilePlan(stops: { latitude: number; longitude: number }[]) {
  if (!stops.length || stops.some(s => !Number.isFinite(s.latitude) || Math.abs(s.latitude) > 85 || !Number.isFinite(s.longitude) || Math.abs(s.longitude) > 180)) throw new Error('Invalid map coordinates')
  for (let z = 13; z >= 0; z--) {
    const points = stops.map(s => ({ x: (s.longitude + 180) / 360 * 2 ** z, y: (1 - Math.asinh(Math.tan(s.latitude * Math.PI / 180)) / Math.PI) / 2 * 2 ** z }))
    const left = Math.max(0, Math.floor(Math.min(...points.map(p => p.x)) - .6)), right = Math.min(2 ** z - 1, Math.floor(Math.max(...points.map(p => p.x)) + .6))
    const top = Math.max(0, Math.floor(Math.min(...points.map(p => p.y)) - .6)), bottom = Math.min(2 ** z - 1, Math.floor(Math.max(...points.map(p => p.y)) + .6))
    if ((right - left + 1) * (bottom - top + 1) > 12) continue
    const tiles = []; for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) tiles.push({ x, y, z })
    return { tiles, bounds: [Math.max(-85.1, lat(bottom + 1, z)), lon(left, z), Math.min(85.1, lat(top, z)), lon(right + 1, z)] as [number, number, number, number] }
  }
  throw new Error('Map area is too large')
}
/** Fixed origin, no redirects, bounded decoded bodies, two concurrent requests at most. */
async function download(url: string, limit: number, signal: AbortSignal, dispatcher?: Dispatcher) {
  const u = new URL(url)
  if (u.origin !== 'https://tiles.openfreemap.org' || u.username || u.password || u.search || u.hash) throw new Error('Unsupported map source')
  const r = await fetch(u, { signal, dispatcher, redirect: 'error', credentials: 'omit', headers: { 'user-agent': UA } })
  if (!r.ok || !r.body) { await r.body?.cancel(); throw new Error('Map source unavailable') }
  if (Number(r.headers.get('content-length')) > limit) { await r.body.cancel(); throw new Error('Map source exceeds byte limit') }
  const chunks: Uint8Array[] = []; let length = 0
  for await (const chunk of r.body) { length += chunk.length; if (length > limit) throw new Error('Map source exceeds byte limit'); chunks.push(chunk) }
  return Buffer.concat(chunks, length)
}
function path(points: number[][]): MapPoint[] {
  if (!Array.isArray(points) || points.length > 8192) return []
  const output: MapPoint[] = []
  for (const p of points) {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1]) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 85.1) return []
    const q: MapPoint = [Math.round(p[1] * 1e5) / 1e5, Math.round(p[0] * 1e5) / 1e5]
    const last = output.at(-1)
    if (!last || q[0] !== last[0] || q[1] !== last[1]) output.push(q)
  }
  const simplify = (items: MapPoint[]): MapPoint[] => {
    if (items.length < 3) return items
    const a = items[0], b = items[items.length - 1], dx = b[0] - a[0], dy = b[1] - a[1], length = dx * dx + dy * dy
    let distance = 0, index = 0
    for (let i = 1; i < items.length - 1; i++) {
      const p = items[i], t = length ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0
      const d = (p[0] - a[0] - t * dx) ** 2 + (p[1] - a[1] - t * dy) ** 2
      if (d > distance) { distance = d; index = i }
    }
    return distance > .00004 ** 2 ? [...simplify(items.slice(0, index + 1)).slice(0, -1), ...simplify(items.slice(index))] : [a, b]
  }
  const simplified = simplify(output)
  if (simplified.length <= 128) return simplified
  // Retain endpoints and a bounded sampling of the original geometry.
  return Array.from({ length: 128 }, (_, i) => simplified[Math.round(i * (simplified.length - 1) / 127)])
}
export function decodeTile(bytes: Uint8Array, x: number, y: number, z: number): StreetFeature[] {
  const tile = new VectorTile(new Pbf(bytes)), result: StreetFeature[] = []
  for (const layerName of ['water', 'landuse', 'landcover', 'park', 'building', 'transportation', 'transportation_name', 'poi']) {
    const layer = tile.layers[layerName]; if (!layer) continue
    let used = 0
    const order = Array.from({ length: Math.min(layer.length, 12000) }, (_, i) => i)
    if (layerName === 'transportation') order.sort((a, b) => {
      const priority = (i: number) => ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(String(layer.feature(i).properties.class)) ? 0 : ['minor', 'service'].includes(String(layer.feature(i).properties.class)) ? 1 : 2
      return priority(a) - priority(b)
    })
    for (const i of order) {
      if (used >= (layerName === 'transportation' ? 2000 : 130)) break
      const f = layer.feature(i), p = f.properties
      let kind: StreetFeature['kind'] = layerName === 'water' ? 'water' : layerName === 'building' ? 'building' : layerName === 'transportation' ? 'road' : ['transportation_name', 'poi'].includes(layerName) ? 'label' : 'park'
      if (kind === 'park' && !['park', 'wood', 'grass', 'forest', 'cemetery', 'garden', 'recreation_ground', 'nature_reserve'].includes(String(p.class))) continue
      const name = String(p['name:zh'] ?? p['name:zh-Hans'] ?? p.name ?? '').slice(0, 100)
      if (kind === 'label' && !name) continue
      const geo = f.toGeoJSON(x, y, z).geometry
      let paths: MapPoint[][] = []
      if (geo.type === 'LineString') paths = [path(geo.coordinates)]
      if (geo.type === 'MultiLineString' || geo.type === 'Polygon') paths = geo.coordinates.slice(0, 8).map(path)
      if (geo.type === 'MultiPolygon') paths = geo.coordinates.slice(0, 8).map(poly => path(poly[0]))
      if (geo.type === 'Point') paths = [path([geo.coordinates])]
      paths = paths.filter(p => p.length >= (kind === 'label' ? 1 : 2)); if (!paths.length) continue
      if (kind === 'label') paths = [[paths[0][Math.floor(paths[0].length / 2)]]]
      result.push({ kind, name, paths, major: ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'].includes(String(p.class)) }); used++
    }
  }
  return result
}
const memory = new Map<string, StreetMap>()
export async function loadStreetMap(stops: { latitude: number; longitude: number }[], policy: { dispatcher?: Dispatcher; timeoutMs: number }, parentSignal: AbortSignal, cacheDir = join(tmpdir(), 'dsh-intelligent-ui', 'street-maps')): Promise<StreetMap> {
  parentSignal.throwIfAborted()
  const plan = tilePlan(stops), key = createHash('sha256').update('geometry-v4:' + JSON.stringify(plan.tiles)).digest('hex'), now = Date.now()
  const validCache = (value: unknown) => { const m = parseStreetMap(value); return m && now - m.fetchedAt < 86400000 && now >= m.fetchedAt ? m : null }
  const memoryKey = cacheDir + ':' + key
  const cached = validCache(memory.get(memoryKey)); if (cached) return structuredClone(cached)
  const location = join(cacheDir, key + '.json')
  try { const saved = validCache(JSON.parse(await readFile(location, 'utf8'))); if (saved) { memory.set(memoryKey, saved); return saved } } catch { /* A missing/expired cache is not a data source. */ }
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(Math.max(30000, policy.timeoutMs))])
  const info = JSON.parse((await download('https://tiles.openfreemap.org/planet', 300000, signal, policy.dispatcher)).toString('utf8'))
  const template = info?.tiles?.[0]
  if (typeof template !== 'string' || !/^https:\/\/tiles\.openfreemap\.org\/planet\/[A-Za-z0-9_-]+\/\{z\}\/\{x\}\/\{y\}\.pbf$/.test(template)) throw new Error('Invalid map source manifest')
  const groups: StreetFeature[][] = []
  for (let i = 0; i < plan.tiles.length; i += 2) groups.push(...await Promise.all(plan.tiles.slice(i, i + 2).map(async ({ x, y, z }) => decodeTile(await download(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), 1500000, signal, policy.dispatcher), x, y, z))))
  // Vector tiles split a road at junctions. Packing several real segments into
  // one feature keeps the road network instead of spending the budget on a
  // repeated metadata object for every short intersection segment.
  const length = (p: MapPoint[]) => p.slice(1).reduce((n, q, i) => n + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0)
  for (let g = 0; g < groups.length; g++) {
    const roads = groups[g].filter(f => f.kind === 'road')
    groups[g] = groups[g].filter(f => f.kind !== 'road')
    for (const major of [true, false]) {
      const paths = roads.filter(f => f.major === major).flatMap(f => f.paths).sort((a, b) => length(b) - length(a))
      for (let i = 0; i < paths.length; i += 8) groups[g].push({ kind: 'road', name: '', major, paths: paths.slice(i, i + 8) })
    }
  }
  const features: StreetFeature[] = [], limits = { water: 45, park: 60, building: 25, road: 180, label: 70 }, counts = { water: 0, park: 0, building: 0, road: 0, label: 0 }
  // Round-robin across tiles, so the first tile cannot consume the entire drawing budget.
  for (let i = 0; i < Math.max(...groups.map(g => g.length)); i++) for (const group of groups) {
    const f = group[i]; if (!f || counts[f.kind] >= limits[f.kind]) continue
    features.push(f); counts[f.kind]++
  }
  const map: StreetMap = { version: 1, bounds: plan.bounds, features, fetchedAt: now }
  while (JSON.stringify(map).length > MAX_MAP_CHARS && map.features.length) {
    const largest = [...map.features].sort((a, b) => b.paths.reduce((n, p) => n + p.length, 0) - a.paths.reduce((n, p) => n + p.length, 0)).find(f => f.paths.some(p => p.length > 12))
    if (largest) { largest.paths = largest.paths.map(p => p.length <= 12 ? p : p.filter((_point, i) => i % 2 === 0 || i === p.length - 1)); continue }
    let index = map.features.length - 1
    for (let i = index; i >= 0; i--) if (map.features[i].kind === 'building' || map.features[i].kind === 'park') { index = i; break }
    if (map.features[index].kind === 'label') index = map.features.findIndex(f => f.kind === 'road' && !f.major)
    if (index < 0) index = map.features.findIndex(f => f.kind !== 'label')
    map.features.splice(index, 1)
  }
  if (!map.features.some(f => f.kind === 'road') || !parseStreetMap(map)) throw new Error('Street map contains no usable roads')
  parentSignal.throwIfAborted(); memory.set(memoryKey, map); if (memory.size > 32) memory.delete(memory.keys().next().value!)
  try { await mkdir(cacheDir, { recursive: true }); await writeFile(location, JSON.stringify(map)) } catch { /* Read-only installations retain the memory cache. */ }
  return structuredClone(map)
}
