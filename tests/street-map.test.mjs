import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import Attachments from '@deepseek-ai/dsh-attachment-local'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import { tilePlan, decodeTile, loadStreetMap } from '../lib/street-map.js'
import { parseDocument } from '../lib/document.js'
import * as plugin from '../lib/index.js'
import { original, thumbnail, png } from './image-fixture.mjs'
const bytes = await readFile(new URL('./fixtures/beijing-vector.pbf', import.meta.url))
const stops = [{ latitude: 39.9166, longitude: 116.3907 }, { latitude: 39.9087, longitude: 116.3975 }, { latitude: 39.8823, longitude: 116.4066 }]
const headers = { 'content-type': 'application/json' }
const manifest = { tiles: ['https://tiles.openfreemap.org/planet/fixture/{z}/{x}/{y}.pbf'] }
function source(mock, info = manifest) {
  const pool = mock.get('https://tiles.openfreemap.org')
  pool.intercept({ path: '/planet', method: 'GET' }).reply(200, info, { headers })
  pool.intercept({ path: p => p.startsWith('/planet/fixture/') && p.endsWith('.pbf'), method: 'GET' }).reply(200, bytes).persist()
}
test('real vector-tile fixture yields actual roads/water/names with WGS84 coordinates; area download stays bounded', () => {
  const features = decodeTile(bytes, 6744, 3102, 13)
  assert.ok(features.some(f => f.kind === 'road' && f.major)); assert.ok(features.some(f => f.kind === 'label' && f.name))
  assert.ok(features.filter(f => f.kind === 'road').length > 130, 'retain the connected road network instead of only the first short intersection segments')
  assert.ok(features.flatMap(f => f.paths.flat()).every(([lat, lon]) => lat > 39 && lat < 41 && lon > 115 && lon < 118))
  for (const input of [stops, [{ latitude: 22.3, longitude: 114.2 }], [{ latitude: -33.8, longitude: 151.2 }, { latitude: 39.9, longitude: 116.4 }]]) assert.ok(tilePlan(input).tiles.length <= 12)
  assert.throws(() => tilePlan([{ latitude: NaN, longitude: 0 }]))
})
test('street source uses fixed origin, validates geometry, and serves repeated views from a bounded cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iui-map-cache-')), mock = new MockAgent(), old = getGlobalDispatcher(); mock.disableNetConnect(); setGlobalDispatcher(mock)
  try {
    source(mock)
    const first = await loadStreetMap(stops, { timeoutMs: 5000 }, new AbortController().signal, dir)
    assert.ok(first.features.some(f => f.kind === 'road')); assert.ok(first.features.some(f => f.kind === 'label')); assert.ok(JSON.stringify(first).length <= 125000)
    assert.ok(first.features.filter(f => f.kind === 'road').reduce((n, f) => n + f.paths.length, 0) > 360, 'pack real segments so metadata limits do not erase most roads')
    first.features.length = 0
    const second = await loadStreetMap(stops, { timeoutMs: 5000 }, new AbortController().signal, dir)
    assert.ok(second.features.length > 0, 'callers cannot mutate the retained cache')
    mock.assertNoPendingInterceptors()
  } finally { setGlobalDispatcher(old); await mock.close(); await rm(dir, { recursive: true, force: true }) }
})
test('redirected/forged map manifests and source errors never masquerade as a street map; abort stays an abort', async () => {
  for (const info of [{ tiles: ['http://localhost/private/{z}/{x}/{y}.pbf'] }, { tiles: ['https://tiles.openfreemap.org/planet/v1/{z}/{x}/{y}.pbf?token=secret'] }]) {
    const dir = await mkdtemp(join(tmpdir(), 'iui-map-bad-')), mock = new MockAgent(), old = getGlobalDispatcher(); mock.disableNetConnect(); setGlobalDispatcher(mock)
    try { source(mock, info); await assert.rejects(loadStreetMap(stops, { timeoutMs: 5000 }, new AbortController().signal, dir), /Invalid map source/) }
    finally { setGlobalDispatcher(old); await mock.close(); await rm(dir, { recursive: true, force: true }) }
  }
  const aborted = new AbortController(); aborted.abort(); await assert.rejects(loadStreetMap(stops, { timeoutMs: 1000 }, aborted.signal), { name: 'AbortError' })
})
test('actual DSH tool resolves three names and creates three per-stop photos without model-supplied coordinates/image IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'iui-trip-')), ctx = new Context(), mock = new MockAgent(), old = getGlobalDispatcher(); mock.disableNetConnect(); setGlobalDispatcher(mock)
  try {
    for (const p of [Tools, SystemPrompt, SessionProjectionRegistry]) await ctx.plugin(p)
    new Attachments(ctx, { dshHome: dir })
    await ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900, routing: 'off', mapCacheDir: join(dir, 'cache') })
    const names = ['故宫', '天安门', '天坛'], english = ['Forbidden City', 'Tiananmen', 'Temple of Heaven']
    for (let i = 0; i < 3; i++) {
      mock.get('https://zh.wikipedia.org').intercept({ path: p => new URL('https://zh.wikipedia.org' + p).searchParams.get('titles') === names[i] }).reply(200, { query: { pages: [{ ns: 0, title: names[i], coordinates: [{ lat: stops[i].latitude, lon: stops[i].longitude }], langlinks: [{ lang: 'en', title: english[i] }] }] } }, { headers })
      mock.get('https://en.wikipedia.org').intercept({ path: p => new URL('https://en.wikipedia.org' + p).searchParams.get('titles') === english[i] }).reply(200, { query: { pages: [{ ns: 0, title: english[i], thumbnail: { source: thumbnail }, original: { source: original } }] } }, { headers })
    }
    mock.get('https://commons.wikimedia.org').intercept({ path: p => p.startsWith('/w/api.php?') }).reply(200, { query: { pages: [{ imageinfo: [{ url: original, extmetadata: { Artist: { value: 'Synthetic fixture' }, LicenseShortName: { value: 'CC0' } } }] }] } }, { headers }).persist()
    mock.get('https://thumb.wikimedia.org').intercept({ path: new URL(thumbnail).pathname }).reply(200, Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } }).persist()
    source(mock)
    const r = await ctx.tools.execute({ callId: 'three-names', name: 'render_intelligent_map', arguments: { title: '北京行程', stops: names.map(name => ({ name })) }, signal: new AbortController().signal })
    assert.equal(r.isError, false, JSON.stringify(r.content)); const doc = parseDocument(r.meta.intelligentUi); assert.ok(doc)
    assert.equal(doc.images.length, 3); assert.ok(doc.images.every(i => i.status === 'available')); assert.equal(new Set(doc.images.map(i => i.id)).size, 3)
    for (let i = 0; i < 3; i++) { assert.equal(doc.images[i].wikipediaTitle, english[i]); assert.ok(doc.html.includes(`data-iui-image="stop_${i + 1}"`)) }
    assert.ok(doc.javascript.includes('OpenStreetMap')); assert.ok(!doc.html.includes('39.9166')); assert.ok(!doc.html.includes('https://zh.wikipedia.org/'))
    assert.ok(!JSON.stringify(r.content).includes(png)); mock.assertNoPendingInterceptors()
  } finally { setGlobalDispatcher(old); await mock.close(); await ctx.fiber.dispose(); await rm(dir, { recursive: true, force: true }) }
})
test('unresolved place does not get invented coordinates or a successful blank map', async () => {
  const ctx = new Context(), mock = new MockAgent(), old = getGlobalDispatcher(); mock.disableNetConnect(); setGlobalDispatcher(mock)
  try {
    for (const p of [Tools, SystemPrompt, SessionProjectionRegistry]) await ctx.plugin(p)
    await ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900, routing: 'off' })
    mock.get('https://zh.wikipedia.org').intercept({ path: p => p.startsWith('/w/api.php?') }).reply(200, { query: { pages: [{ ns: 0, title: '不存在的景点', missing: true }] } }, { headers })
    const r = await ctx.tools.execute({ callId: 'missing-place', name: 'render_intelligent_map', arguments: { title: '地图', stops: [{ name: '不存在的景点' }] }, signal: new AbortController().signal })
    assert.equal(r.isError, true); assert.equal(r.meta?.intelligentUi, undefined); assert.match(r.content[0].text, /无法确定/)
  } finally { setGlobalDispatcher(old); await mock.close(); await ctx.fiber.dispose() }
})

test('map follows exact interlanguage coordinates and keeps unresolved stops visible without losing resolved photo identity', async () => {
  const ctx = new Context(), mock = new MockAgent(), old = getGlobalDispatcher(); mock.disableNetConnect(); setGlobalDispatcher(mock)
  try {
    for (const p of [Tools, SystemPrompt, SessionProjectionRegistry]) await ctx.plugin(p)
    await ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900, routing: 'off' })
    const page = (host, title, value) => mock.get(`https://${host}.wikipedia.org`).intercept({ path: p => new URL('https://example.org' + p).searchParams.get('titles') === title }).reply(200, { query: { pages: [value] } }, { headers })
    page('zh', '安福路', { ns: 0, title: '安福路' })
    page('zh', '武康路', { ns: 0, title: '武康路', langlinks: [{ lang: 'en', title: 'Wukang Road' }] })
    page('en', 'Wukang Road', { ns: 0, title: 'Wukang Road', coordinates: [{ lat: 31.2076, lon: 121.4401 }] })
    const r = await ctx.tools.execute({ callId: 'partial-trip', name: 'render_intelligent_map', arguments: {
      title: '上海行程', basemap: 'world', stops: [{ name: '<安福路>', wikipediaTitle: '安福路' }, { name: '武康路' }],
    }, signal: new AbortController().signal })
    assert.equal(r.isError, false, JSON.stringify(r.content))
    const doc = parseDocument(r.meta.intelligentUi); assert.ok(doc)
    assert.match(doc.description, /1 个地点已定位，1 个地点未定位/)
    assert.match(doc.html, /data-map-unresolved/); assert.match(doc.html, /&lt;安福路&gt;/)
    assert.equal(doc.images.length, 1)
    assert.equal(doc.images[0].wikipediaTitle, 'Wukang Road')
    assert.equal(doc.images[0].alt, '武康路')
    assert.match(doc.javascript, /31\.2076/)
    mock.assertNoPendingInterceptors()
  } finally { setGlobalDispatcher(old); await mock.close(); await ctx.fiber.dispose() }
})

test('Latin Wikipedia titles paired with zh retry the exact English article, without searching or inventing coordinates', async () => {
  const ctx = new Context(), mock = new MockAgent(), old = getGlobalDispatcher(); mock.disableNetConnect(); setGlobalDispatcher(mock)
  try {
    for (const p of [Tools, SystemPrompt, SessionProjectionRegistry]) await ctx.plugin(p)
    await ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900, routing: 'off' })
    mock.get('https://zh.wikipedia.org').intercept({ path: p => p.includes('Wukang') }).reply(200, { query: { pages: [{ ns: 0, title: 'Wukang Road', missing: true }] } }, { headers })
    mock.get('https://en.wikipedia.org').intercept({ path: p => p.includes('Wukang') }).reply(200, { query: { pages: [{ ns: 0, title: 'Wukang Road', coordinates: [{ lat: 31.2076, lon: 121.4401 }] }] } }, { headers })
    const r = await ctx.tools.execute({ callId: 'english-trip', name: 'render_intelligent_map', arguments: { title: '武康路', basemap: 'world', photos: 'none', stops: [{ name: '武康路', wikipediaTitle: 'Wukang Road', language: 'zh' }] }, signal: new AbortController().signal })
    assert.equal(r.isError, false, JSON.stringify(r.content)); assert.match(r.meta.intelligentUi.javascript, /en\.wikipedia/)
    mock.assertNoPendingInterceptors()
  } finally { setGlobalDispatcher(old); await mock.close(); await ctx.fiber.dispose() }
})
