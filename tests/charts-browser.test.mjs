import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { root } from '../scripts/environment.mjs'
import { getTemplate } from '../lib/templates.js'

async function withPage(run) {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({ viewport: { width: 1100, height: 1200 }, offline: true })
    const page = await context.newPage()
    page.setDefaultTimeout(5000)
    const network = []; const errors = []
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()) })
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href)
    await page.waitForFunction(() => window.uiChecks)
    try { await run(page, context, network, errors) }
    catch (error) { console.log('Chart diagnostic:', await page.evaluate(() => ({ text: document.body.innerText.slice(-2500), messages: window.uiChecks?.messages.slice(-5) })).catch(() => 'closed')); throw error }
  } finally { await browser.close() }
}
async function mount(page, name) {
  await page.evaluate(doc => window.uiChecks.mount(doc), getTemplate(name))
  const frame = page.frameLocator('iframe')
  await frame.locator('canvas').waitFor()
  await frame.locator('canvas').evaluate(canvas => {
    if (!window.Chart?.getChart(canvas)) throw new Error('Chart was not initialized')
  })
  return frame
}
async function state(frame) {
  return frame.locator('canvas').evaluate(canvas => {
    const chart = window.Chart.getChart(canvas)
    return { version: window.Chart.version, count: Object.keys(window.Chart.instances).length, id: chart?.id, type: chart?.config.type, datasets: chart?.data.datasets.map(dataset => [...dataset.data]), width: chart?.width }
  })
}

test('three offline chart templates paint, update current values, change type and resize without duplicate instances', { timeout: 30000 }, async () => withPage(async (page, context, network, errors) => {
  for (const type of ['line', 'bar', 'pie']) {
    const frame = await mount(page, `chart_${type}`)
    assert.deepEqual((({ version, count, type }) => ({ version, count, type }))(await state(frame)), { version: '4.5.1', count: 1, type })
    assert.equal(await page.evaluate(() => typeof window.Chart), 'undefined', 'Chart.js must never execute in the parent')
    const painted = await frame.locator('canvas').evaluate(canvas => [...canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data].some((value, index) => index % 4 === 3 && value > 0))
    assert.equal(painted, true)
    await frame.locator('#income').fill('7000'); await frame.locator('#amount').fill('5000')
    await frame.locator('#amount').dispatchEvent('input')
    assert.match(await frame.locator('#summary').innerText(), /支出 22900\.00.*结余 19100\.00/)
    assert.equal((await state(frame)).datasets.at(-1)[0], 5000)
    assert.match(await frame.locator('#chart-rows tr').first().innerText(), /7000\.00.*5000\.00.*2000\.00/s)
    const before = await state(frame)
    await frame.locator('#chart-type').selectOption(type === 'bar' ? 'line' : 'bar')
    const switched = await state(frame)
    assert.equal(switched.count, 1)
    assert.notEqual(switched.id, before.id)
    await page.setViewportSize({ width: 440, height: 1000 })
    await page.waitForFunction(() => document.querySelector('iframe').getBoundingClientRect().width < 500)
    await frame.locator('canvas').evaluate(canvas => new Promise((resolve, reject) => {
      let attempts = 0; const poll = () => window.Chart.getChart(canvas).width < 400 ? resolve() : ++attempts > 100 ? reject(new Error('Chart did not resize')) : setTimeout(poll, 10); poll()
    }))
    assert.equal(await frame.locator('#amount').inputValue(), '5000')
    await frame.locator('#followup').click()
    await page.getByRole('button', { name: '发送到当前对话', exact: true }).waitFor()
    assert.match(await page.locator('aside').innerText(), /1 月 5000\.00 元.*累计支出 22900\.00 元/)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await page.locator('[data-bridge-receipt="cancelled"]').waitFor()
    assert.deepEqual(await page.evaluate(() => window.uiChecks.sent), [])
    assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
    await page.setViewportSize({ width: 1100, height: 1200 })
  }
  assert.deepEqual(network, []); assert.deepEqual(errors, [])
  await page.screenshot({ path: join(root, 'artifacts/offline-charts.png'), fullPage: true })
}))

test('invalid, empty and zero-total chart data have visible recovery and readable data', { timeout: 30000 }, async () => withPage(async page => {
  const frame = await mount(page, 'chart_pie')
  await frame.locator('#amount').fill('')
  assert.match(await frame.locator('#validation').innerText(), /请填写/)
  assert.equal((await state(frame)).count, 0)
  assert.equal(await frame.locator('#followup').isDisabled(), true)
  await frame.locator('#amount').fill('9999999')
  assert.match(await frame.locator('#validation').innerText(), /有限数值/)
  await frame.locator('#reset').click()
  assert.equal((await state(frame)).count, 1)
  for (let index = 0; index < 6; index++) { await frame.locator('#month').selectOption(String(index)); await frame.locator('#amount').fill('0') }
  assert.match(await frame.locator('#chart-empty').innerText(), /无法计算占比/)
  assert.equal((await state(frame)).count, 0)
  assert.equal(await frame.locator('#chart-rows tr').count(), 6)
  await frame.locator('#clear-data').click()
  assert.match(await frame.locator('#chart-empty').innerText(), /暂无数据/)
  assert.equal(await frame.locator('#followup').isDisabled(), true)
  await frame.locator('#reset').click()
  assert.equal((await state(frame)).count, 1)
  assert.equal(await frame.locator('#amount').inputValue(), '3200')
  assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
}))

test('streaming chart waits for successful metadata, keeps its frame and initializes only once', { timeout: 30000 }, async () => withPage(async page => {
  const doc = getTemplate('chart_line')
  await page.evaluate(doc => window.uiChecks.stream(doc, 'generating', true), doc)
  const frame = page.frameLocator('iframe')
  await frame.locator('#budget-chart').waitFor({ state: 'attached' })
  assert.equal(await frame.locator('body').evaluate(() => typeof window.Chart), 'undefined')
  assert.equal(await frame.locator('body').evaluate(() => document.body.inert), true)
  await frame.locator('body').evaluate(() => { window.frameMarker = 'same-chart-frame' })
  await page.evaluate(doc => window.uiChecks.stream(doc, 'ready'), doc)
  await frame.locator('canvas').evaluate(canvas => new Promise((resolve, reject) => {
    let attempts = 0; const poll = () => window.Chart?.getChart(canvas) ? resolve() : ++attempts > 100 ? reject(new Error('Chart not loaded')) : setTimeout(poll, 10); poll()
  }))
  const first = await state(frame)
  await frame.locator('#amount').fill('5000')
  await page.evaluate(doc => window.uiChecks.stream(doc, 'ready'), doc)
  assert.equal((await state(frame)).id, first.id)
  assert.equal(await frame.locator('#amount').inputValue(), '5000')
  assert.equal(await frame.locator('body').evaluate(() => window.frameMarker), 'same-chart-frame')
  assert.equal(await page.locator('iframe').count(), 1)
  assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
}))

test('missing chart runtime reports resource failure and never runs the generated script; cancellation loads no library', { timeout: 30000 }, async () => withPage(async page => {
  const doc = getTemplate('chart_bar')
  await page.evaluate(doc => window.uiChecks.stream(doc, 'generating', true), doc)
  const frame = page.frameLocator('iframe')
  await frame.locator('canvas').waitFor({ state: 'attached' })
  const channel = await page.evaluate(() => window.uiChecks.messages.find(row => row.channel).channel)
  await page.locator('iframe').evaluate((element, channel) => element.contentWindow.postMessage({ kind: 'document-update', channel, phase: 'ready', libraries: ['chartjs-4.5.1'], librarySource: '/* simulated missing vendor */', html: '<p>fallback</p>', css: '', javascript: 'window.mustNotRun=true' }, '*'), channel)
  await page.locator('[data-runtime-errors]').filter({ hasText: 'Offline Chart.js' }).waitFor()
  assert.equal(await frame.locator('body').evaluate(() => window.mustNotRun), undefined)
  assert.equal(await frame.locator('body').evaluate(() => document.body.inert), true)
  await page.evaluate(doc => window.uiChecks.stream(doc, 'generating', true), doc)
  await page.frameLocator('iframe').locator('canvas').waitFor({ state: 'attached' })
  await page.evaluate(doc => window.uiChecks.stream(doc, 'failed'), doc)
  assert.equal(await page.frameLocator('iframe').locator('body').evaluate(() => typeof window.Chart), 'undefined')
}))

test('offline export contains the pinned runtime and licenses and replays independently', { timeout: 30000 }, async () => withPage(async (page, context, network, errors) => {
  const frame = await mount(page, 'chart_bar')
  await frame.locator('#amount').fill('5000')
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 HTML', exact: true }).click()
  const destination = join(root, 'artifacts/offline-chart-export.html'); await (await download).saveAs(destination)
  const text = readFileSync(destination, 'utf8')
  assert.match(text, /Chart\.js v4\.5\.1/)
  assert.match(text, /Permission is hereby granted/)
  assert.match(text, /Jukka Kurkela/)
  await page.goto(pathToFileURL(destination).href)
  assert.equal(await page.locator('canvas').evaluate(canvas => window.Chart.getChart(canvas).config.type), 'bar')
  assert.equal(await page.locator('#amount').inputValue(), '3200', 'Export replays the saved document defaults')
  await page.locator('#amount').fill('5000')
  assert.match(await page.locator('#summary').innerText(), /22900\.00/)
  assert.equal(await page.evaluate(async () => { try { await window.dshUI.sendPrompt('offline'); return 'unexpected' } catch (error) { return error.code } }), 'HOST_UNAVAILABLE')
  assert.deepEqual(network, []); assert.deepEqual(errors, [])
  writeFileSync(join(root, 'artifacts/offline-charts-result.json'), JSON.stringify({ chartVersion: '4.5.1', types: ['line', 'bar', 'pie'], offline: true, requests: network, modelCalled: false, independentExport: true }, null, 2))
}))

test('orphaned charts and pagehide dispose instances; reset and unmount release iframe browsing contexts', { timeout: 30000 }, async () => withPage(async page => {
  let frame = await mount(page, 'chart_line')
  await page.evaluate(() => { window.cleanupEvents = []; window.addEventListener('message', event => { if (event.data?.kind === 'test-chart-cleanup') window.cleanupEvents.push(event.data.marker) }) })
  await frame.locator('canvas').evaluate(canvas => {
    window.Chart.register({ id: 'test-cleanup', afterDestroy: () => parent.postMessage({ kind: 'test-chart-cleanup', marker: 'pagehide' }, '*') })
    // Observe the real cleanup handler while its context is alive. Browsers may
    // discard queued postMessage tasks from an iframe removed during reset.
    window.dispatchEvent(new Event('pagehide'))
    if (Object.keys(window.Chart.instances).length !== 0) throw new Error('Pagehide did not dispose chart instances')
  })
  await page.waitForFunction(() => window.cleanupEvents.includes('pagehide'))
  const resetContext = await (await page.locator('iframe').elementHandle()).contentFrame()
  const resetDetached = page.waitForEvent('framedetached', { predicate: candidate => candidate === resetContext })
  await page.getByRole('button', { name: '重置界面', exact: true }).click()
  await resetDetached
  assert.equal(resetContext.isDetached(), true)
  frame = page.frameLocator('iframe')
  await frame.locator('canvas').waitFor()
  assert.equal((await state(frame)).count, 1)
  await frame.locator('canvas').evaluate(canvas => canvas.remove())
  await frame.locator('body').evaluate(() => new Promise((resolve, reject) => {
    let attempts = 0; const poll = () => Object.keys(window.Chart.instances).length === 0 ? resolve() : ++attempts > 100 ? reject(new Error('Orphan not disposed')) : setTimeout(poll, 10); poll()
  }))
  frame = await mount(page, 'chart_pie')
  const oldContext = await (await page.locator('iframe').elementHandle()).contentFrame()
  const detached = page.waitForEvent('framedetached', { predicate: candidate => candidate === oldContext })
  await page.evaluate(() => window.uiChecks.unmount())
  await detached
  await page.locator('iframe').waitFor({ state: 'detached' })
  assert.equal(oldContext.isDetached(), true)
  assert.equal(page.frames().length, 1)
}))
