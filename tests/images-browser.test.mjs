import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from '../scripts/environment.mjs'
import { document, image, request } from './image-fixture.mjs'
import { makeTheme } from '../lib/theme.js'
async function withPage(run) {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 900, height: 1000 } })
    const page = await context.newPage(); page.setDefaultTimeout(5000)
    const errors = []; const external = []
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (/^https?:/.test(r.url())) external.push(r.url()) })
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href); await page.waitForFunction(() => window.uiChecks)
    await run(page, context); assert.deepEqual(errors, []); assert.deepEqual(external, [])
  } finally { await browser.close() }
}
async function mount(page, doc = document) {
  await page.evaluate(value => window.uiChecks.mount(value), doc)
  await page.locator('[data-runtime-status]').filter({ hasText: '交互界面已加载' }).waitFor()
  return page.frameLocator('iframe')
}
async function decoded(frame) { await frame.locator('[data-iui-saved-image] img').evaluate(async el => { await el.decode() }) }

test('saved photos render with alt, visible immutable host credits and unavailable text; theme, form state and resize survive', () => withPage(async page => {
  const missing = { ...request, id: 'missing', status: 'unavailable', code: 'NO_IMAGE' }
  const frame = await mount(page, { ...document, images: [image, missing] }); await decoded(frame)
  assert.equal(await frame.locator('img').getAttribute('src'), image.dataUrl)
  assert.equal(await frame.locator('img').getAttribute('alt'), image.alt)
  await frame.locator('[data-iui-saved-image=missing]').filter({ hasText: '图片暂不可用' }).waitFor()
  assert.equal(await page.locator('[data-image-sources] details').getAttribute('open'), null)
  await page.locator('[data-image-sources] summary').click()
  await page.locator('[data-image-sources]').getByText(/Synthetic fixture author.*CC0/).waitFor()
  await frame.locator('#value').fill('99')
  await page.evaluate(theme => window.uiChecks.setTheme(theme), makeTheme('dark'))
  await page.locator('[data-ui-theme=dark]').waitFor()
  assert.equal(await frame.locator('#value').inputValue(), '99')
  assert.equal(await frame.locator('img').evaluate(el => el.complete && el.naturalWidth === 1), true)
  assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
  assert.doesNotMatch(await page.locator('[data-image-sources]').innerText(), /实时|离线|保留文字|无关图片/)
  assert.doesNotMatch(await frame.locator('[data-iui-saved-image=photo]').innerText(), /实时|离线|保留文字|无关图片/)
  await frame.getByRole('button', { name: '图片出处与许可', exact: true }).click()
  await page.getByRole('button', { name: '打开链接', exact: true }).waitFor()
  assert.ok((await page.locator('aside pre').textContent()).includes('commons.wikimedia.org'))
  await page.getByRole('button', { name: '取消', exact: true }).click()
}))

test('image previews stay static; ready hydrates in the same iframe once; failed previews never hydrate', () => withPage(async page => {
  await page.evaluate(value => window.uiChecks.stream(value, 'generating', true), document)
  const frame = page.frameLocator('iframe'); await frame.locator('[data-iui-image]').waitFor({ state: 'attached' })
  assert.equal(await frame.locator('img').count(), 0)
  const element = await page.locator('iframe').elementHandle()
  await page.evaluate(value => window.uiChecks.stream(value, 'ready'), document); await decoded(frame)
  assert.equal(await page.locator('iframe').evaluate((el, previous) => el === previous, element), true)
  assert.equal(await frame.locator('body').evaluate(() => window.activations), 1)
  await page.evaluate(value => window.uiChecks.stream(value, 'ready'), document)
  assert.equal(await frame.locator('[data-iui-saved-image=photo]').count(), 1)
  await page.evaluate(value => window.uiChecks.stream(value, 'generating', true), document)
  await page.evaluate(value => window.uiChecks.stream(value, 'failed'), document)
  await page.locator('[data-ui-phase=failed]').waitFor()
  assert.equal(await page.frameLocator('iframe').locator('img').count(), 0)
}))

test('v3 photos and pinned charts export together and load offline with credits, without a host or external image request', () => withPage(async page => {
  const doc = { ...document, libraries: ['chartjs-4.5.1'], html: document.html + '<div style="height:180px;position:relative"><canvas id="chart"></canvas></div>',
    javascript: 'window.chart=new Chart(document.getElementById("chart"),{type:"bar",data:{labels:["demo"],datasets:[{data:[7]}]},options:{responsive:true,maintainAspectRatio:false,animation:false}});' }
  const frame = await mount(page, doc); await decoded(frame)
  await frame.locator('body').evaluate(() => { if (window.Chart.version !== '4.5.1') throw new Error('Chart missing') })
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 HTML', exact: true }).click()
  const download = await event; const path = join(root, 'artifacts/images-export.html'); await download.saveAs(path)
  await page.goto(pathToFileURL(path).href)
  await page.locator('img').evaluate(async el => { await el.decode() })
  assert.equal(await page.locator('img').getAttribute('src'), image.dataUrl)
  assert.equal(await page.locator('figcaption').textContent(), request.wikipediaTitle)
  assert.equal(await page.getByRole('link', { name: '图片出处与许可' }).getAttribute('href'), image.creditUrl)
  assert.equal(await page.evaluate(() => window.chart.data.datasets[0].data[0]), 7)
}))

test('browser decode failure is visible and does not discard source attribution', () => withPage(async page => {
  await page.evaluate(value => window.uiChecks.mount(value), { ...document, images: [{ ...image, dataUrl: 'data:image/png;base64,AAAA' }] })
  const frame = page.frameLocator('iframe')
  await frame.locator('[data-iui-saved-image]').filter({ hasText: '图片加载失败' }).waitFor()
  await page.locator('[data-runtime-errors]').filter({ hasText: 'saved image could not be decoded' }).waitFor()
  assert.equal(await frame.locator('img').count(), 0)
  assert.equal(await page.locator('[data-image-sources] a').count(), 2)
}))

test('image URL markup is stripped; restored documents render cached bytes without refetching', () => withPage(async page => {
  const doc = { ...document, html: '<img id="remote" src="https://upload.wikimedia.org/remote.png" srcset="https://evil.invalid/a 2x">' + document.html }
  let frame = await mount(page, doc); await decoded(frame)
  assert.equal(await frame.locator('#remote').getAttribute('src'), null)
  assert.equal(await frame.locator('#remote').getAttribute('srcset'), null)
  await page.reload(); await page.waitForFunction(() => window.uiChecks)
  frame = await mount(page, JSON.parse(JSON.stringify(doc))); await decoded(frame)
  assert.equal(await frame.locator('[data-iui-saved-image] img').getAttribute('src'), image.dataUrl)
}))

test('real downloaded Wikimedia photo replays offline and remains readable with its creator and license', { skip: !(process.env.DSH_LIVE_IMAGE_FIXTURE && existsSync(process.env.DSH_LIVE_IMAGE_FIXTURE)) }, () => withPage(async page => {
  const live = JSON.parse(readFileSync(process.env.DSH_LIVE_IMAGE_FIXTURE, 'utf8'))
  assert.equal(live.images[0].status, 'available', 'Run the explicit live image verifier before this integration check')
  const frame = await mount(page, live); await decoded(frame)
  assert.ok(await frame.locator('img').evaluate(el => el.naturalWidth > 100))
  await page.locator('[data-image-sources] summary').click()
  await page.locator('[data-image-sources]').getByText(live.images[0].creator, { exact: false }).waitFor()
  await page.screenshot({ path: join(root, 'artifacts/images-live-offline.png'), fullPage: true })
}))
