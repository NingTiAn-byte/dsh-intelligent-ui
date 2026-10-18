import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { root } from '../scripts/environment.mjs'
import { mapDocument, chartDocument } from '../lib/features.js'
import { image } from './image-fixture.mjs'
const spec = { title: '行程地图', basemap: 'world', durationMs: 1000, stops: [
  { name: '第一站', latitude: 22.3, longitude: 114.2, description: '海边', source: '用户坐标', imageId: 'photo' },
  { name: '第二站', latitude: 23.1, longitude: 113.3, description: '城市', source: '用户坐标' },
] }
const doc = { ...mapDocument(spec), version: 3, images: [{ ...image, id: 'photo' }] }
async function withPage(run) {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 1000, height: 1000 } }); const page = await context.newPage(); page.setDefaultTimeout(6000)
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href); await page.waitForFunction(() => window.uiChecks)
    await run(page, context)
  } finally { await browser.close() }
}
test('offline itinerary paints map and photo, supports zoom, marker/card selection, pause/replay and host theme without remount', { timeout: 25000 }, () => withPage(async page => {
  const requests = []; page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()) })
  await page.evaluate(doc => window.uiChecks.mount(doc), doc)
  const f = page.frameLocator('iframe'); await f.locator('.leaflet-marker-icon').first().waitFor()
  assert.equal(await f.locator('.leaflet-marker-icon').count(), 2); assert.equal(await f.locator('.leaflet-image-layer').evaluate(i => i.complete && i.naturalWidth > 0), true)
  await f.locator('[data-iui-saved-image="photo"] img').waitFor(); assert.equal(await f.locator('[data-iui-saved-image="photo"] img').evaluate(i => i.naturalWidth), 1)
  await page.frames().find(frame => frame.parentFrame()).waitForFunction(() => {
    const map = document.getElementById('iui-map').getBoundingClientRect()
    return [...document.querySelectorAll('.leaflet-marker-icon')].every(n => { const r = n.getBoundingClientRect(); return r.left >= map.left && r.right <= map.right && r.top >= map.top && r.bottom <= map.bottom })
  }, undefined, { timeout: 5000 })
  await f.locator('.leaflet-control-zoom-in').click(); await f.locator('.trip-card > button').nth(1).click(); assert.equal(await f.locator('.trip-card').nth(1).getAttribute('aria-current'), 'true')
  await f.locator('#trip-play').click(); await page.waitForTimeout(200); await f.locator('#trip-pause').click()
  const paused = await f.locator('progress').evaluate(p => p.value); await page.waitForTimeout(200); assert.equal(await f.locator('progress').evaluate(p => p.value), paused)
  await f.locator('#trip-reset').click(); await f.locator('progress').evaluate(p => new Promise(resolve => { const check = () => p.value === 1 ? resolve(true) : setTimeout(check, 30); check() }))
  assert.equal(await f.locator('.trip-card').nth(1).getAttribute('aria-current'), 'true')
  const identity = await page.locator('iframe').getAttribute('srcdoc')
  await page.getByLabel('DSH主题').selectOption('dark'); assert.equal(await f.locator('html').getAttribute('data-iui-theme'), 'dark'); assert.equal(await page.locator('iframe').getAttribute('srcdoc'), identity)
  assert.equal(await f.locator('progress').evaluate(p => p.value), 1); assert.equal(await page.locator('[data-runtime-errors]').count(), 0); assert.deepEqual(requests, [])
  await page.screenshot({ path: join(root, 'artifacts/f06-map.png'), fullPage: true })
}))
test('streamed controlled maps activate Leaflet and photos exactly once; exports replay offline without DSH', { timeout: 25000 }, () => withPage(async (page, context) => {
  const empty = { version: 1, title: '地图', description: '', html: '', css: '', javascript: '', height: 400 }
  await page.evaluate(doc => window.uiChecks.stream(doc, 'generating', true), empty)
  const source = await page.locator('iframe').getAttribute('srcdoc')
  await page.evaluate(doc => window.uiChecks.stream(doc, 'ready'), doc)
  const f = page.frameLocator('iframe'); await f.locator('.leaflet-marker-icon').first().waitFor(); await f.locator('[data-iui-saved-image="photo"] img').waitFor()
  await page.evaluate(doc => window.uiChecks.stream(doc, 'ready'), doc); assert.equal(await f.locator('.leaflet-map-pane').count(), 1); assert.equal(await page.locator('iframe').getAttribute('srcdoc'), source)
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 HTML' }).click(); const download = await downloadPromise
  const target = join(root, 'artifacts/f06-map-export.html'); await download.saveAs(target)
  const replay = await context.newPage(); await replay.goto(pathToFileURL(target).href); await replay.locator('.leaflet-marker-icon').first().waitFor(); assert.equal(await replay.locator('.leaflet-marker-icon').count(), 2); assert.equal(await replay.locator('[data-iui-saved-image="photo"] img').evaluate(i => i.naturalWidth), 1)
  assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
}))
test('fixed remote tile failure falls back to saved world map; map CSP blocks arbitrary networking', { timeout: 20000 }, () => withPage(async page => {
  await page.evaluate(doc => window.uiChecks.mount(doc), mapDocument({ ...spec, basemap: 'nasa', stops: spec.stops.map(({ imageId, ...s }) => s) }))
  const f = page.frameLocator('iframe'); await f.locator('.leaflet-marker-icon').first().waitFor(); await f.locator('#map-status').filter({ hasText: '详细底图暂不可用' }).waitFor()
  assert.equal(await f.locator('.leaflet-image-layer').evaluate(i => i.complete && i.naturalWidth > 0), true)
  assert.equal(await f.locator('body').evaluate(async () => { try { await fetch('https://gibs.earthdata.nasa.gov'); return false } catch { return true } }), true)
}))
test('controlled charts retain data and chart instance through host theme updates and render accessible values', { timeout: 20000 }, () => withPage(async page => {
  await page.evaluate(doc => window.uiChecks.mount(doc), chartDocument({ title: '柱图', kind: 'bar', labels: ['甲', '乙'], values: [5, 8], unit: '件', source: '演示数据' }))
  const f = page.frameLocator('iframe'); await f.locator('canvas').waitFor(); await f.locator('canvas').evaluate(c => { window.originalChart = window.Chart.getChart(c) })
  await page.getByLabel('DSH主题').selectOption('dark'); assert.equal(await f.locator('canvas').evaluate(c => window.Chart.getChart(c) === window.originalChart), true)
  assert.deepEqual(await f.locator('canvas').evaluate(c => window.Chart.getChart(c).data.datasets[0].data), [5, 8]); assert.equal(await f.locator('table tbody tr').count(), 2)
  assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
}))
test('nearby city stops fit independently of native basemap resolution and retain a visible route segment', { timeout: 15000 }, () => withPage(async page => {
  const nearby = { ...spec, stops: [{ name: '歌剧院', latitude: -33.8568, longitude: 151.2153, description: '', source: '用户坐标' }, { name: '海港大桥', latitude: -33.8523, longitude: 151.2108, description: '', source: '用户坐标' }] }
  await page.evaluate(doc => window.uiChecks.mount(doc), mapDocument(nearby))
  const f = page.frameLocator('iframe'); await f.locator('.leaflet-marker-icon').first().waitFor()
  await page.frames().find(frame => frame.parentFrame()).waitForFunction(() => [...document.querySelectorAll('#iui-map path')].some(p => p.getBoundingClientRect().width > 10), undefined, { timeout: 5000 })
  const points = await f.locator('.leaflet-marker-icon').evaluateAll(nodes => nodes.map(n => { const r = n.getBoundingClientRect(); return [r.x, r.y] }))
  assert.ok(Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1]) > 28)
  assert.ok(await f.locator('path').evaluate(p => p.getBoundingClientRect().width > 10))
}))
