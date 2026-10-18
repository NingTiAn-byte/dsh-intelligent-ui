import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mapDocument } from '../lib/features.js'
import { image } from './image-fixture.mjs'
import { root } from '../scripts/environment.mjs'
const stops = [
  { name: '合成站点A', latitude: 39.91, longitude: 116.39, description: 'A', source: 'https://zh.wikipedia.org/wiki/合成站点A', imageId: 'a' },
  { name: '合成站点B', latitude: 39.90, longitude: 116.40, description: 'B', source: '合成测试位置', imageId: 'b' },
  { name: '合成站点C', latitude: 39.89, longitude: 116.41, description: 'C', source: '合成测试位置', imageId: 'c' },
]
const data = { version: 1, fetchedAt: 1, bounds: [39.87, 116.37, 39.94, 116.44], features: [
  { kind: 'road', name: '合成道路', major: true, paths: [[[39.89, 116.38], [39.90, 116.40], [39.92, 116.42]]] },
  { kind: 'road', name: '', major: false, paths: [[[39.88, 116.39], [39.91, 116.41]]] },
  { kind: 'park', name: '合成公园', major: false, paths: [[[39.90, 116.38], [39.905, 116.38], [39.905, 116.39], [39.90, 116.39], [39.90, 116.38]]] },
  { kind: 'label', name: '道路名称', major: false, paths: [[[39.90, 116.40]]] },
] }
const doc = { ...mapDocument({ title: '三站合成回归', basemap: 'street', durationMs: 1000, stops }, data), version: 3, images: ['a', 'b', 'c'].map(id => ({ ...image, id })) }
async function browserTest(run) {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 1100, height: 3000 } }); const page = await context.newPage(); page.setDefaultTimeout(5000)
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href); await page.waitForFunction(() => window.uiChecks)
    await run(page, context)
  } finally { await browser.close() }
}
test('street geometry and all three photos draw offline, attach to their own cards and survive host theme changes', { timeout: 15000 }, () => browserTest(async page => {
  const requests = []; page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()) })
  await page.evaluate(doc => window.uiChecks.mount(doc), doc)
  const f = page.frameLocator('iframe'); await f.locator('.iui-pin').first().waitFor(); assert.equal(await f.locator('.iui-pin').count(), 3)
  assert.equal(await f.locator('.leaflet-street-base-pane path').count(), 3); assert.equal(await f.locator('.iui-map-label').textContent(), '道路名称')
  const introduction = f.locator('.trip-description a').first()
  assert.equal(await introduction.textContent(), 'A'); assert.equal(await introduction.getAttribute('href'), new URL(stops[0].source).href)
  const cardCopy = await f.locator('#trip-stops').innerText()
  assert.ok(!cardCopy.includes('39.91')); assert.ok(!cardCopy.includes('https://'))
  await introduction.click(); await page.getByRole('button', { name: '打开链接', exact: true }).waitFor()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  for (let i = 0; i < 3; i++) {
    const card = f.locator('.trip-card').nth(i), img = card.locator('img')
    await img.evaluate(i => i.decode()); assert.equal(await img.evaluate(i => i.naturalWidth), 1)
    await card.locator('button').first().click(); assert.equal(await card.getAttribute('aria-current'), 'true')
  }
  const source = await page.locator('iframe').getAttribute('srcdoc'); await page.getByLabel('DSH主题').selectOption('dark')
  assert.equal(await page.locator('iframe').getAttribute('srcdoc'), source); assert.equal(await f.locator('img').count(), 3); assert.deepEqual(requests, [])
  assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
}))
test('street preview stays inert, then hydrates three images and its geographic layers once in the same frame', { timeout: 15000 }, () => browserTest(async page => {
  const preview = { ...doc, version: 1, libraries: undefined, images: undefined, html: '', javascript: '' }
  await page.evaluate(d => window.uiChecks.stream(d, 'generating', true), preview)
  const source = await page.locator('iframe').getAttribute('srcdoc'); assert.equal(await page.frameLocator('iframe').locator('.iui-pin').count(), 0)
  await page.evaluate(d => window.uiChecks.stream(d, 'ready'), doc)
  const f = page.frameLocator('iframe'); await f.locator('.iui-pin').first().waitFor()
  assert.equal(await f.locator('.trip-card img').count(), 3)
  await page.evaluate(d => window.uiChecks.stream(d, 'ready'), doc)
  assert.equal(await f.locator('.leaflet-map-pane').count(), 1); assert.equal(await f.locator('.trip-card img').count(), 3); assert.equal(await page.locator('iframe').getAttribute('srcdoc'), source)
}))
test('exported street map retains real geometry and all three image declarations without any network', { timeout: 15000 }, () => browserTest(async (page, context) => {
  await page.evaluate(d => window.uiChecks.mount(d), doc)
  await page.frameLocator('iframe').locator('.iui-pin').first().waitFor()
  const promise = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 HTML' }).click(); const file = await promise
  const path = join(root, 'artifacts/three-photos-export.html'); await file.saveAs(path)
  const replay = await context.newPage(); await replay.goto(pathToFileURL(path).href); await replay.locator('.iui-pin').first().waitFor()
  assert.equal(await replay.locator('.leaflet-street-base-pane path').count(), 3); assert.equal(await replay.locator('.trip-card img').count(), 3)
  for (const img of await replay.locator('.trip-card img').all()) await img.evaluate(i => i.decode())
  assert.match(await replay.locator('.leaflet-control-attribution').textContent(), /OpenStreetMap/)
  assert.equal(await replay.locator('.trip-description a').getAttribute('href'), new URL(stops[0].source).href)
  assert.ok(!(await replay.locator('#trip-stops').innerText()).includes('39.91'))
}))
