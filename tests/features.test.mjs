import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import * as plugin from '../lib/index.js'
import { parseMap, mapDocument, chartDocument, planDocument, workflowDocument } from '../lib/features.js'
import { parseDocument } from '../lib/document.js'
import { parseImageRequests, parseImages, creditUrl } from '../lib/image-protocol.js'
import { resolveImage } from '../lib/images.js'
import { image, original, thumbnail, png } from './image-fixture.mjs'

export const spec = { title: '悉尼行程', basemap: 'world', durationMs: 1000, stops: [
  { name: '悉尼歌剧院', latitude: -33.8568, longitude: 151.2153, description: '第一站', source: '用户提供坐标' },
  { name: '海港大桥', latitude: -33.8523, longitude: 151.2108, description: '第二站', source: '用户提供坐标' },
  { name: '皇家植物园', latitude: -33.8642, longitude: 151.2166, description: '第三站', source: '用户提供坐标' },
] }
async function setup(config = {}) {
  const ctx = new Context(); await ctx.plugin(Tools); await ctx.plugin(SystemPrompt); await ctx.plugin(SessionProjectionRegistry)
  const fiber = ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900, routing: 'off', ...config }); await fiber
  return { ctx, fiber, call: (name, args, signal = new AbortController().signal) => ctx.tools.execute({ callId: 'features-test', name, arguments: args, signal }) }
}
test('map rejects invalid coordinates/providers/bounds, while all controlled components produce replayable documents', () => {
  for (const changes of [{ stops: [] }, { stops: Array(31).fill(spec.stops[0]) }, { basemap: 'custom' }, { durationMs: 0 }, { stops: [{ ...spec.stops[0], latitude: NaN }] }, { stops: [{ ...spec.stops[0], longitude: 181 }] }, { stops: [{ ...spec.stops[0], source: '' }] }, { basemap: 'usgs' }]) assert.equal(parseMap({ ...spec, ...changes }), null)
  for (const doc of [mapDocument(spec), chartDocument({ title: '销量', kind: 'bar', labels: ['一'], values: [-2], unit: '件', source: '演示数据' }), planDocument('比较趋势', 'Chart.js', ['柱图', '单位']), workflowDocument('进度', [{ title: '核对', description: '待处理', status: 'pending' }])]) assert.deepEqual(parseDocument(JSON.parse(JSON.stringify(doc))), doc)
  assert.throws(() => chartDocument({ title: '坏数据', kind: 'pie', labels: ['一'], values: [-1], unit: '件', source: '演示' }))
  assert.throws(() => chartDocument({ title: '坏数据', kind: 'pie', labels: ['一'], values: [0], unit: '件', source: '演示' }))
})
test('real DSH registry persists controlled component metadata, enforces deployment caps and releases registrations', async () => {
  const h = await setup()
  try {
    for (const [name, args] of [['render_intelligent_map', spec], ['render_intelligent_chart', { title: '销售', kind: 'pie', labels: ['甲', '乙'], values: [2, 3], unit: '件', source: '演示' }], ['plan_intelligent_ui', { approach: '比较', technology: 'SVG', key_elements: ['坐标', '数据'] }], ['render_intelligent_workflow', { title: '待办', items: [{ title: '检查', description: '读数据', status: 'in_progress' }] }]]) {
      const r = await h.call(name, args); assert.equal(r.isError, false, JSON.stringify(r)); assert.ok(parseDocument(r.meta.intelligentUi)); assert.equal(r.value.title, r.meta.intelligentUi.title)
    }
    assert.equal((await h.call('render_intelligent_map', { ...spec, stops: [{ ...spec.stops[0], imageId: 'missing' }] })).isError, true)
    const abort = new AbortController(); abort.abort(); assert.equal((await h.call('render_intelligent_map', spec, abort.signal)).isError, true)
    await h.fiber.dispose(); assert.equal(h.ctx.tools.schemas().some(t => t.name === 'render_intelligent_map'), false)
  } finally { await h.ctx.fiber.dispose() }
  const small = await setup({ maxDocumentChars: 1000, maxHeight: 300 })
  try { assert.equal((await small.call('render_intelligent_map', spec)).isError, true) } finally { await small.ctx.fiber.dispose() }
})
test('Commons filename photo path verifies exact attribution and raster bytes, and rejects path injection', async () => {
  const request = { id: 'chosen', wikipediaTitle: 'Fixture', language: 'en', alt: 'A subject', commonsFile: 'Fixture.png' }
  assert.equal(parseImageRequests([{ ...request, commonsFile: '../secret.png' }]), null)
  const calls = []
  const r = await resolveImage(request, { enabled: true, maxBytes: 256000, timeoutMs: 5000 }, { validateImage: async ({ data }) => assert.ok(data.length) }, new AbortController().signal, async url => {
    calls.push(String(url)); return calls.length === 1 ? new Response(JSON.stringify({ query: { pages: [{ imageinfo: [{ url: original, thumburl: thumbnail, extmetadata: { Artist: { value: 'Fixture author' }, LicenseShortName: { value: 'CC0' } } }] }] } }), { headers: { 'content-type': 'application/json' } }) : new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } })
  })
  assert.equal(r.status, 'available'); assert.equal(r.articleUrl, creditUrl('Fixture.png')); assert.deepEqual(parseImages([r]), [r]); assert.equal(calls.length, 2)
  assert.equal(parseImages([{ ...r, commonsFile: 'Other.png' }]), null)
})
test('place lookup and Commons search use fixed hosts and bounded reusable metadata', async () => {
  const h = await setup(), mock = new MockAgent(), previous = getGlobalDispatcher(); mock.disableNetConnect(); setGlobalDispatcher(mock)
  try {
    mock.get('https://en.wikipedia.org').intercept({ path: p => p.includes('prop=coordinates'), method: 'GET' }).reply(200, { query: { pages: [{ ns: 0, title: 'Sydney Opera House', coordinates: [{ lat: -33.8568, lon: 151.2153 }] }] } }, { headers: { 'content-type': 'application/json' } })
    const r = await h.call('lookup_intelligent_ui_places', { title: 'Sydney Opera House', language: 'en' }); assert.equal(r.isError, false); assert.equal(JSON.parse(r.value).latitude, -33.8568)
    mock.get('https://commons.wikimedia.org').intercept({ path: p => p.includes('generator=search'), method: 'GET' }).reply(200, { query: { pages: [{ imageinfo: [{ url: original, extmetadata: { Artist: { value: 'Author' }, LicenseShortName: { value: 'CC0' } } }] }, { imageinfo: [{ url: original, extmetadata: { Artist: { value: 'Author' }, LicenseShortName: { value: 'All rights reserved' } } }] }] } }, { headers: { 'content-type': 'application/json' } })
    const s = await h.call('search_intelligent_ui_images', { query: 'Sydney' }); assert.equal(s.isError, false); assert.equal(JSON.parse(s.value).images.length, 1); assert.equal(JSON.parse(s.value).images[0].commonsFile, 'Fixture.png')
    mock.assertNoPendingInterceptors()
  } finally { setGlobalDispatcher(previous); await mock.close(); await h.ctx.fiber.dispose() }
})
