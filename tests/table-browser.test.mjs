import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { root } from '../scripts/environment.mjs'
import { makeTheme } from '../lib/theme.js'
const sample = { version: 1, title: '季度收入', columns: ['季度', '收入（元）'], rows: [['Q1', '100'], ['Q2', '200']], source: '用户提供的演示数据' }
async function withPage(run) {
  const browser = await launchBrowser()
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 375, height: 900 } })
    const page = await context.newPage(); page.setDefaultTimeout(5000)
    const errors = []; const requests = []
    page.on('pageerror', e => errors.push(e.message)); page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()) })
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href)
    await page.waitForFunction(() => window.uiChecks)
    await run(page); assert.deepEqual(errors, []); assert.deepEqual(requests, [])
  } finally { await browser.close() }
}
test('controlled table renders text safely, exposes caption/headers/source and keeps theme/font/focus/scroll state', async () => withPage(async page => {
  const sampleWide = { ...sample, columns: Array.from({ length: 12 }, (_, i) => `列 ${i + 1}`), rows: Array.from({ length: 200 }, (_, i) => Array.from({ length: 12 }, (_, j) => `${i + 1}/${j + 1}`)) }
  sampleWide.rows[0][0] = '<script>window.pwned=1</script>'
  sampleWide.rows[0][1] = '<img src="https://invalid.example/x" onerror="window.pwned=1">'
  await page.evaluate(value => window.uiChecks.table(value), sampleWide)
  await page.getByRole('table', { name: sample.title }).waitFor()
  assert.equal(await page.getByRole('columnheader').count(), 12)
  assert.equal(await page.locator('tbody tr').count(), 200)
  assert.equal(await page.locator('td').first().innerText(), sampleWide.rows[0][0])
  assert.equal(await page.locator('[data-intelligent-table] script,[data-intelligent-table] img,iframe').count(), 0)
  assert.equal(await page.evaluate(() => window.pwned), undefined)
  const region = page.getByRole('region', { name: `${sample.title} — 表格滚动区域`, exact: true })
  await region.focus()
  const before = await region.evaluate(el => { el.scrollLeft = 200; el.scrollTop = 180; window.tableElement = el; return { x: el.scrollLeft, y: el.scrollTop, overflow: el.scrollWidth > el.clientWidth, bounded: el.scrollHeight > el.clientHeight } })
  assert.ok(before.overflow && before.bounded && before.x > 0 && before.y > 0)
  const dark = makeTheme('dark')
  await page.evaluate(theme => window.uiChecks.setTheme(theme), dark)
  await page.locator('[data-intelligent-table][data-ui-theme=dark]').waitFor()
  assert.deepEqual(await region.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop, same: el === window.tableElement, focus: el === document.activeElement })), { x: before.x, y: before.y, same: true, focus: true })
  await page.evaluate(theme => window.uiChecks.setTheme(theme), { ...dark, fontSize: 20 })
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-intelligent-table] table')).fontSize === '20px')
  assert.equal(await region.evaluate(el => el === window.tableElement && el === document.activeElement && el.scrollLeft === 200 && el.scrollTop > 0), true)
  assert.equal(await page.locator('table').evaluate(el => getComputedStyle(el).fontSize), '20px')
  assert.equal(await page.locator('[data-intelligent-table]').evaluate(el => getComputedStyle(el).color), 'rgb(237, 240, 245)')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)
  await page.getByText('数据来源：用户提供的演示数据', { exact: true }).waitFor()
  await page.screenshot({ path: join(root, 'artifacts/table-dark-narrow.png'), fullPage: true })
  await page.evaluate(theme => window.uiChecks.setTheme(theme), makeTheme('light'))
  await page.locator('[data-intelligent-table][data-ui-theme=light]').waitFor()
  assert.equal(await page.locator('[data-intelligent-table]').evaluate(el => getComputedStyle(el).color), 'rgb(15, 17, 21)')
}))
test('empty, invalid, preparing and stopped tables have visible bounded states without partial data', async () => withPage(async page => {
  await page.evaluate(value => window.uiChecks.table(value), { ...sample, rows: [] })
  await page.getByText('暂无数据行。', { exact: true }).waitFor()
  assert.equal(await page.locator('tbody tr').count(), 0)
  await page.getByText('数据来源：用户提供的演示数据', { exact: true }).waitFor()
  await page.evaluate(value => window.uiChecks.table(value), { ...sample, rows: [['Q1']] })
  await page.getByRole('alert').waitFor(); assert.equal(await page.locator('table').count(), 0)
  await page.evaluate(value => window.uiChecks.table(value, 'generating'), sample)
  await page.getByText('正在准备表格…', { exact: true }).waitFor(); assert.equal(await page.locator('table').count(), 0)
  await page.evaluate(value => window.uiChecks.table(value, 'failed'), sample)
  await page.getByRole('alert').waitFor(); assert.equal(await page.locator('table').count(), 0)
  await page.evaluate(value => window.uiChecks.table(JSON.parse(JSON.stringify(value))), sample)
  await page.getByRole('table', { name: sample.title }).waitFor(); assert.equal(await page.locator('tbody tr').count(), 2)
  await page.evaluate(() => window.uiChecks.unmount()); await page.locator('[data-intelligent-table]').waitFor({ state: 'detached' })
}))
