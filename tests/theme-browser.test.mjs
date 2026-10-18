import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { root } from '../scripts/environment.mjs'
import { getTemplate, TEMPLATE_NAMES } from '../lib/templates.js'
import { makeTheme } from '../lib/theme.js'
async function withPage(run) {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 1100, height: 1300 } })
    const page = await context.newPage(); page.setDefaultTimeout(5000)
    const errors = []; const network = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()) })
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href)
    await page.waitForFunction(() => window.uiChecks)
    try { await run(page, context); assert.deepEqual(errors, []); assert.deepEqual(network, []) }
    catch (error) { console.log('Theme diagnostic:', await page.evaluate(() => ({ text: document.body.innerText.slice(-1500), messages: window.uiChecks?.messages.slice(-6) })).catch(() => 'closed')); throw error }
  } finally { await browser.close() }
}
async function mount(page, name) {
  const doc = getTemplate(name)
  await page.evaluate(doc => window.uiChecks.mount(doc), doc)
  await page.getByTitle(doc.title, { exact: true }).waitFor()
  await page.locator('[data-runtime-status]').filter({ hasText: '已加载' }).waitFor()
  return page.frameLocator('iframe')
}
async function setTheme(page, scheme, overrides = {}) {
  const theme = { ...makeTheme(scheme), ...overrides }
  await page.evaluate(theme => window.uiChecks.setTheme(theme), theme)
  await page.frameLocator('iframe').locator(`html[data-iui-theme="${scheme}"]`).waitFor()
  return theme
}
const chartState = frame => frame.locator('canvas').evaluate(canvas => {
  const chart = window.Chart.getChart(canvas)
  return { id: chart.id, count: Object.keys(window.Chart.instances).length, color: chart.options.plugins.legend.labels.color,
    grid: chart.options.scales?.y?.grid?.color, series: chart.data.datasets.at(-1).backgroundColor,
    visible: chart.isDatasetVisible(0), pieVisible: chart.getDataVisibility(0), fontSize: chart.options.plugins.legend.labels.font.size }
})

test('all six templates use live semantic colors on light/dark and remain usable on narrow screens', { timeout: 30000 }, async () => withPage(async page => {
  for (const name of TEMPLATE_NAMES) {
    const frame = await mount(page, name)
    await setTheme(page, 'light')
    await frame.locator('body').evaluate(() => { window.themeMarker = crypto.randomUUID() })
    const marker = await frame.locator('body').evaluate(() => window.themeMarker)
    await setTheme(page, 'dark')
    assert.equal(await frame.locator('body').evaluate(() => window.themeMarker), marker)
    assert.equal(await frame.locator('body').evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(21, 21, 23)')
    if (name !== 'flowchart') assert.equal(await frame.locator('input,select').first().evaluate(element => getComputedStyle(element).color), 'rgb(237, 240, 245)')
    if (name === 'flowchart') assert.equal(await frame.locator('svg g').last().evaluate(element => getComputedStyle(element).fill), 'rgb(237, 240, 245)')
    await page.setViewportSize({ width: 375, height: 1000 })
    assert.equal(await frame.locator('body').evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth + 1), true)
    const height = await frame.locator('body').evaluate(body => {
      const style = getComputedStyle(body)
      return Math.max(180, Math.min(4000, Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height) + parseFloat(style.marginTop) + parseFloat(style.marginBottom))))
    })
    await page.waitForFunction(height => Math.abs(parseFloat(document.querySelector('iframe').style.height) - height) <= 1, height)
    await page.screenshot({ path: join(root, `artifacts/theme-${name}-dark.png`), fullPage: true })
    await setTheme(page, 'light')
    assert.equal(await frame.locator('body').evaluate(() => window.themeMarker), marker)
    assert.equal(await frame.locator('body').evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)')
    assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
    await page.setViewportSize({ width: 1100, height: 1300 })
  }
}))

test('theme switching preserves input, keyboard focus, template selection and pending follow-up receipts', { timeout: 30000 }, async () => withPage(async page => {
  let frame = await mount(page, 'calculator')
  await frame.locator('#quantity').fill('7')
  await frame.locator('#quantity').press('Tab')
  assert.equal(await frame.locator('#price').evaluate(element => element === document.activeElement), true)
  await setTheme(page, 'dark')
  assert.equal(await frame.locator('#quantity').inputValue(), '7')
  assert.equal(await frame.locator('#total').innerText(), '84.00')
  assert.equal(await frame.locator('#price').evaluate(element => element === document.activeElement), true)
  assert.equal(await frame.locator('#price').evaluate(element => getComputedStyle(element).outlineWidth), '3px')
  await frame.locator('#followup').click()
  await page.getByRole('button', { name: '发送到当前对话', exact: true }).waitFor()
  await setTheme(page, 'light')
  assert.match(await page.locator('aside').innerText(), /84\.00/)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.locator('[data-bridge-receipt="cancelled"]').waitFor()
  assert.deepEqual(await page.evaluate(() => window.uiChecks.sent), [])
  frame = await mount(page, 'comparison')
  await frame.locator('#sort').selectOption('score')
  await frame.getByRole('button', { name: '选择 方案 C', exact: true }).click()
  await setTheme(page, 'dark')
  assert.equal(await frame.locator('#sort').inputValue(), 'score')
  assert.match(await frame.locator('#selected').innerText(), /方案 C/)
  frame = await mount(page, 'flowchart')
  await frame.locator('#next').click()
  await setTheme(page, 'light')
  assert.match(await frame.locator('#step-detail').innerText(), /2\/3/)
}))

test('chart recoloring preserves instance, data and legend visibility and follows font settings', { timeout: 30000 }, async () => withPage(async page => {
  for (const name of ['chart_line', 'chart_bar', 'chart_pie']) {
    const frame = await mount(page, name)
    await setTheme(page, 'light')
    await frame.locator('#amount').fill('5000')
    await frame.locator('canvas').evaluate(canvas => {
      const chart = window.Chart.getChart(canvas)
      if (chart.config.type === 'pie') chart.toggleDataVisibility(0)
      else chart.setDatasetVisibility(0, false)
      chart.update('none')
    })
    const before = await chartState(frame)
    const dark = await setTheme(page, 'dark', { fontSize: 18, fontFamily: '"Trebuchet MS", sans-serif' })
    const after = await chartState(frame)
    assert.equal(after.id, before.id); assert.equal(after.count, 1)
    assert.equal(after.color, dark.colors.text)
    assert.equal(after.fontSize, 18)
    if (name === 'chart_pie') { assert.equal(after.pieVisible, false); assert.equal(after.series[0], dark.colors.chart1) }
    else { assert.equal(after.visible, false); assert.equal(after.grid, dark.colors.grid); assert.equal(after.series, dark.colors.chart1) }
    assert.equal(await frame.locator('#amount').inputValue(), '5000')
    assert.match(await frame.locator('#summary').innerText(), /22900\.00/)
    await setTheme(page, 'light')
    assert.equal((await chartState(frame)).id, before.id)
    assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
  }
}))

test('streaming and failed previews accept theme changes without enabling scripts or replacing the frame', { timeout: 30000 }, async () => withPage(async page => {
  const doc = getTemplate('calculator'); doc.javascript = 'window.runs=(window.runs||0)+1;\n' + doc.javascript
  await page.evaluate(doc => window.uiChecks.stream(doc, 'generating', true), doc)
  let frame = page.frameLocator('iframe')
  await frame.locator('#quantity').waitFor({ state: 'attached' })
  await frame.locator('body').evaluate(() => { window.marker = 'stream-theme' })
  await setTheme(page, 'dark')
  assert.equal(await frame.locator('body').evaluate(() => document.body.inert), true)
  assert.equal(await frame.locator('body').evaluate(() => window.runs), undefined)
  await page.evaluate(doc => window.uiChecks.stream(doc, 'ready'), doc)
  await frame.locator('#quantity').fill('7')
  await setTheme(page, 'light')
  assert.equal(await frame.locator('body').evaluate(() => window.marker), 'stream-theme')
  assert.equal(await frame.locator('body').evaluate(() => window.runs), 1)
  assert.equal(await frame.locator('#total').innerText(), '84.00')
  await page.evaluate(doc => window.uiChecks.stream(doc, 'generating', true), doc)
  frame = page.frameLocator('iframe'); await frame.locator('#quantity').waitFor({ state: 'attached' })
  await page.evaluate(doc => window.uiChecks.stream(doc, 'failed'), doc)
  await setTheme(page, 'dark')
  assert.equal(await frame.locator('body').evaluate(() => window.runs), undefined)
  assert.equal(await frame.locator('body').evaluate(() => document.body.inert), true)
}))

test('theme messages reject foreign/stale channels and invalid colors; subscriptions can be removed', { timeout: 30000 }, async () => withPage(async page => {
  const frame = await mount(page, 'calculator')
  await setTheme(page, 'light')
  const channel = await page.evaluate(() => window.uiChecks.messages.find(row => row.channel).channel)
  await frame.locator('body').evaluate(() => { window.changes = 0; window.stopTheme = window.dshUI.onThemeChange(() => { window.changes++ }) })
  await page.evaluate(args => window.postMessage({ channel: args.channel, kind: 'theme-update', theme: args.theme }, '*'), { channel, theme: makeTheme('dark') })
  await frame.locator('body').evaluate((_element, args) => window.postMessage({ channel: args.channel, kind: 'theme-update', theme: args.theme }, '*'), { channel, theme: makeTheme('dark') })
  await page.locator('iframe').evaluate((element, args) => element.contentWindow.postMessage({ channel: 'stale', kind: 'theme-update', theme: args.theme }, '*'), { theme: makeTheme('dark') })
  const invalid = makeTheme('dark'); invalid.colors.bg = 'url(https://example.com/x)'
  await page.locator('iframe').evaluate((element, args) => element.contentWindow.postMessage({ channel: args.channel, kind: 'theme-update', theme: args.theme }, '*'), { channel, theme: invalid })
  await frame.locator('body').evaluate(() => new Promise(resolve => setTimeout(resolve, 50)))
  assert.equal(await frame.locator('html').getAttribute('data-iui-theme'), 'light')
  assert.equal(await frame.locator('body').evaluate(() => window.changes), 0)
  await setTheme(page, 'dark')
  assert.equal(await frame.locator('body').evaluate(() => window.changes), 1)
  await frame.locator('body').evaluate(() => { window.stopTheme(); window.stopTheme() })
  await setTheme(page, 'light')
  assert.equal(await frame.locator('body').evaluate(() => window.changes), 1)
  assert.equal(await frame.locator('body').evaluate(() => Object.isFrozen(window.dshUI.getTheme().colors)), true)
}))

test('exports lock the current theme, chart palette and font and stay independent from OS changes', { timeout: 30000 }, async () => withPage(async (page, context) => {
  await mount(page, 'chart_line')
  const dark = await setTheme(page, 'dark', { fontSize: 18, fontFamily: '"Trebuchet MS", sans-serif' })
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 HTML', exact: true }).click()
  const destination = join(root, 'artifacts/theme-dark-export.html'); await (await download).saveAs(destination)
  assert.match(readFileSync(destination, 'utf8'), /name="iui-theme" content="dark"/)
  await page.goto(pathToFileURL(destination).href)
  assert.equal(await page.locator('body').evaluate(() => window.dshUI.getTheme().scheme), 'dark')
  assert.equal(await page.locator('canvas').evaluate(canvas => window.Chart.getChart(canvas).options.plugins.legend.labels.color), dark.colors.text)
  assert.equal(await page.locator('body').evaluate(() => getComputedStyle(document.body).fontSize), '18px')
  await page.emulateMedia({ colorScheme: 'light' })
  assert.equal(await page.locator('html').getAttribute('data-iui-theme'), 'dark')
  await page.locator('#amount').fill('5000')
  assert.match(await page.locator('#summary').innerText(), /22900\.00/)
  await page.screenshot({ path: join(root, 'artifacts/theme-export-dark.png'), fullPage: true })
  writeFileSync(join(root, 'artifacts/theme-browser-result.json'), JSON.stringify({ templates: TEMPLATE_NAMES, schemes: ['light', 'dark'], retainedState: true, retainedChartInstance: true, retainedLegendVisibility: true, exportedTheme: 'dark', offline: true, modelCalled: false }, null, 2))
}))

test('preview system preference follows OS changes and manual selection keeps the same widget', { timeout: 30000 }, async () => withPage(async page => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto(pathToFileURL(join(root, 'preview/index.html')).href)
  const frame = page.frameLocator('iframe')
  await frame.locator('#count').fill('7')
  await frame.locator('body').evaluate(() => { window.previewMarker = 'keep' })
  await page.emulateMedia({ colorScheme: 'dark' })
  await frame.locator('html[data-iui-theme="dark"]').waitFor()
  assert.equal(await frame.locator('#count').inputValue(), '7')
  await page.getByLabel('预览主题').selectOption('light')
  await frame.locator('html[data-iui-theme="light"]').waitFor()
  assert.equal(await frame.locator('body').evaluate(() => window.previewMarker), 'keep')
}))
