import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { amapKey, resolveAmapPlace, convertAmapPoint, loadAmapSnapshot, amapView } from '../lib/amap.js'
import { parseDocument } from '../lib/document.js'
import * as plugin from '../lib/index.js'

const key = 'a'.repeat(32), headers = { 'content-type': 'application/json' }
test('dotenv keys support quotes and comments, environment precedence and legacy fallback without global mutation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'iui-env-')), previous = process.env.DSH_AMAP_KEY
  try {
    delete process.env.DSH_AMAP_KEY
    const env = join(directory, '.env'), legacy = join(directory, 'key.txt')
    await writeFile(env, `# local config\nOTHER=value\nDSH_AMAP_KEY="${key}" # comment\n`)
    await writeFile(legacy, 'b'.repeat(32))
    assert.equal(await amapKey({ amapEnvFile: env, amapKeyFile: legacy }), key)
    assert.equal(process.env.DSH_AMAP_KEY, undefined)
    process.env.DSH_AMAP_KEY = 'c'.repeat(32)
    assert.equal(await amapKey({ amapEnvFile: env }), 'c'.repeat(32))
    delete process.env.DSH_AMAP_KEY
    await writeFile(env, 'OTHER=value\n')
    assert.equal(await amapKey({ amapEnvFile: env, amapKeyFile: legacy }), 'b'.repeat(32))
    await writeFile(env, 'DSH_AMAP_KEY=invalid\n')
    await assert.rejects(amapKey({ amapEnvFile: env }), error => !error.message.includes('invalid'))
    await assert.rejects(amapKey({ amapEnvFile: join(directory, 'missing') }), /amapEnvFile/)
  } finally {
    if (previous === undefined) delete process.env.DSH_AMAP_KEY; else process.env.DSH_AMAP_KEY = previous
    await rm(directory, { recursive: true, force: true })
  }
})
const poi = (name = '武康路') => ({ id: 'B_SYNTHETIC', name, location: '121.440627,31.209252' })
// Valid synthetic PNG: the test never depends on live maps or private credentials.
function png(width, height) {
  const crc = b => { let c = 0xffffffff; for (const v of b) { c ^= v; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0) } return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, bytes) => { const t = Buffer.from(type), size = Buffer.alloc(4), sum = Buffer.alloc(4); size.writeUInt32BE(bytes.length); sum.writeUInt32BE(crc(Buffer.concat([t, bytes]))); return Buffer.concat([size, t, bytes, sum]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc(height * (width * 4 + 1), 240); for (let y = 0; y < height; y++) raw[y * (width * 4 + 1)] = 0
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
async function mocked(run) {
  const mock = new MockAgent(), old = getGlobalDispatcher(); mock.disableNetConnect(); setGlobalDispatcher(mock)
  try { await run(mock.get('https://restapi.amap.com')); mock.assertNoPendingInterceptors() }
  finally { setGlobalDispatcher(old); await mock.close() }
}
const pathIs = path => url => new URL(url, 'https://restapi.amap.com').pathname === path

test('static image footprint matches independently calibrated AMap pixels away from its center', () => {
  // Official staticmap zoom 13: offset (.02 lon, .01 lat) from (121.49,31.23)
  // is approximately (+233,-136) image pixels, rather than Leaflet's (+116,-68).
  const project = p => [(p.longitude + 180) / 360, (1 - Math.asinh(Math.tan(p.latitude * Math.PI / 180)) / Math.PI) / 2]
  for (const [width, height] of [[640, 360], [480, 270], [320, 180]]) {
    const point = { longitude: 121.49, latitude: 31.23 }, view = amapView([point], width, height)
    const [s, w, n, e] = view.bounds, west = project({ longitude: w, latitude: n }), east = project({ longitude: e, latitude: s })
    const offset = { longitude: view.center.longitude + .0005, latitude: view.center.latitude + .00025 }
    const a = project(view.center), b = project(offset)
    const imageX = (b[0] - west[0]) / (east[0] - west[0]) * width
    const imageY = (b[1] - west[1]) / (east[1] - west[1]) * height
    assert.ok(Math.abs(imageX - width / 2 - (b[0] - a[0]) * 512 * 2 ** view.zoom) < .001)
    assert.ok(Math.abs(imageY - height / 2 - (b[1] - a[1]) * 512 * 2 ** view.zoom) < .001)
  }
  const route = [{ latitude: 31.23, longitude: 121.49 }, { latitude: 31.24, longitude: 121.51 }], view = amapView(route)
  const [s, w, n, e] = view.bounds, nw = project({ latitude: n, longitude: w }), se = project({ latitude: s, longitude: e })
  for (const p of route) {
    const v = project(p), x = (v[0] - nw[0]) / (se[0] - nw[0]) * 640, y = (v[1] - nw[1]) / (se[1] - nw[1]) * 360
    assert.ok(x >= 39 && x <= 601 && y >= 39 && y <= 321, 'route pins must fit inside the requested snapshot padding')
  }
})

test('AMap uses city-constrained POIs and refuses ambiguous results or leaked API errors', () => mocked(async pool => {
  pool.intercept({ path: url => { const u = new URL(url, 'https://restapi.amap.com'); return u.pathname === '/v3/place/text' && u.searchParams.get('city') === '上海' && u.searchParams.get('citylimit') === 'true' && u.searchParams.get('key') === key } }).reply(200, { status: '1', pois: [poi()] }, { headers })
  const place = await resolveAmapPlace('武康路', '上海', key, {}, new AbortController().signal)
  assert.equal(place.latitude, 31.209252); assert.match(place.source, /amap.com\/place\/B_SYNTHETIC/)
  pool.intercept({ path: pathIs('/v3/place/text') }).reply(200, { status: '1', pois: [poi(), { ...poi(), id: 'B_OTHER' }] }, { headers })
  await assert.rejects(resolveAmapPlace('武康路', '', key, {}, new AbortController().signal), /多个匹配/)
  pool.intercept({ path: pathIs('/v3/place/text') }).reply(200, { status: '0', infocode: '10009', info: key }, { headers })
  await assert.rejects(resolveAmapPlace('武康路', '上海', key, {}, new AbortController().signal), error => /Web服务/.test(error.message) && !error.message.includes(key))
}))

test('WGS84 inputs use official coordinate conversion; static bounds and bytes stay bounded and key-free', () => mocked(async pool => {
  pool.intercept({ path: url => { const u = new URL(url, 'https://restapi.amap.com'); return u.pathname.endsWith('/coordinate/convert') && u.searchParams.get('coordsys') === 'gps' } }).reply(200, { status: '1', locations: '121.44,31.21' }, { headers })
  const point = await convertAmapPoint({ latitude: 31.2, longitude: 121.43 }, key, {}, new AbortController().signal)
  assert.deepEqual(point, { longitude: 121.44, latitude: 31.21 })
  pool.intercept({ path: pathIs('/v3/staticmap') }).reply(200, png(640, 360), { headers: { 'content-type': 'image/png' } })
  const image = await loadAmapSnapshot([point], key, {}, new AbortController().signal)
  assert.ok(image.dataUrl.startsWith('data:image/png;base64,')); assert.ok(!JSON.stringify(image).includes(key))
  const [s, w, n, e] = image.bounds; assert.ok(s < point.latitude && n > point.latitude && w < point.longitude && e > point.longitude)
  assert.throws(() => amapView([{ latitude: NaN, longitude: 0 }]))
  const cancelled = new AbortController(); cancelled.abort()
  await assert.rejects(loadAmapSnapshot([point], key, {}, cancelled.signal), { name: 'AbortError' })
}))

test('AMap refuses non-image snapshots and preserves useful quota errors', () => mocked(async pool => {
  pool.intercept({ path: pathIs('/v3/staticmap') }).reply(200, '<html>error</html>', { headers: { 'content-type': 'text/html' } })
  await assert.rejects(loadAmapSnapshot([{ latitude: 31.2, longitude: 121.4 }], key, {}, new AbortController().signal), /PNG/)
  pool.intercept({ path: pathIs('/v3/staticmap') }).reply(200, { status: '0', infocode: '10003', info: key }, { headers })
  await assert.rejects(loadAmapSnapshot([{ latitude: 31.2, longitude: 121.4 }], key, {}, new AbortController().signal), error => /配额/.test(error.message) && !error.message.includes(key))
}))

test('transient AMap QPS errors retry within a fixed limit and do not expose credentials', () => mocked(async pool => {
  pool.intercept({ path: pathIs('/v3/place/text') }).reply(200, { status: '0', infocode: '10021' }, { headers })
  pool.intercept({ path: pathIs('/v3/place/text') }).reply(200, { status: '1', pois: [poi()] }, { headers })
  assert.equal((await resolveAmapPlace('武康路', '上海', key, {}, new AbortController().signal)).title, '武康路')
  pool.intercept({ path: pathIs('/v3/place/text') }).reply(200, { status: '0', infocode: '10021', info: key }, { headers }).times(3)
  await assert.rejects(resolveAmapPlace('武康路', '上海', key, {}, new AbortController().signal), error => /并发/.test(error.message) && !error.message.includes(key))
}))

test('real DSH AMap tool produces a replayable GCJ-02 map with no overseas calls or persisted key', () => mocked(async pool => {
  const directory = await mkdtemp(join(tmpdir(), 'iui-amap-')), ctx = new Context()
  try {
    const file = join(directory, 'key.txt'); await writeFile(file, key)
    const env = join(directory, '.env'); await writeFile(env, '# Test isolates developer credentials\n')
    for (const p of [Tools, SystemPrompt, SessionProjectionRegistry]) await ctx.plugin(p)
    await ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900, routing: 'off', mapProvider: 'amap', amapEnvFile: env, amapKeyFile: file })
    pool.intercept({ path: pathIs('/v3/place/text') }).reply(200, { status: '1', pois: [poi()] }, { headers })
    pool.intercept({ path: pathIs('/v3/staticmap') }).reply(200, png(640, 360), { headers: { 'content-type': 'image/png' } })
    const result = await ctx.tools.execute({ callId: 'amap-test', name: 'render_intelligent_map', arguments: { title: '上海', city: '上海', stops: [{ name: '武康路' }] }, signal: new AbortController().signal })
    assert.equal(result.isError, false, JSON.stringify(result.content))
    const doc = parseDocument(JSON.parse(JSON.stringify(result.meta.intelligentUi))); assert.ok(doc)
    assert.match(doc.description, /高德地图/); assert.match(doc.javascript, /31\.209252/)
    assert.equal(doc.images, undefined); assert.ok(!JSON.stringify(result).includes(key)); assert.ok(!doc.javascript.includes('restapi.amap.com'))
  } finally { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) }
}))
