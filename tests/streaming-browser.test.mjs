import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { root } from '../scripts/environment.mjs'
const doc = {
  version: 1, title: '流式预览回归', description: '演示数据', height: 300,
  css: 'output{color:rgb(0, 128, 0)}', html: '<label>数量<input id="n" value="3" type="number"></label><output id="total">等待交互</output><button id="ask">解释</button>',
  javascript: `window.runs=(window.runs||0)+1; const n=document.getElementById('n'); const total=document.getElementById('total'); function update(){total.textContent=String(Number(n.value)*12)}; n.addEventListener('input',update); update(); document.getElementById('ask').addEventListener('click',()=>window.dshUI.sendPrompt('总价 '+total.textContent).catch(()=>{}));`,
}
async function withPage(run) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
    page.setDefaultTimeout(5000)
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href)
    await page.waitForFunction(() => window.uiChecks)
    try { await run(page) }
    catch (error) { console.log('Streaming fixture diagnostic:', await page.evaluate(() => ({ host: document.body.innerText, events: window.uiChecks?.messages.slice(-8) })).catch(() => 'page unavailable')); throw error }
  } finally { await browser.close() }
}
async function publish(page, document, phase, newCall = false) {
  await page.evaluate(args => window.uiChecks.stream(...args), [document, phase, newCall])
  await page.locator(`[data-ui-phase="${phase}"]`).waitFor()
}

test('streamed HTML stays inert; final metadata activates once in the same iframe and exports the final document', { timeout: 30000 }, async () => withPage(async page => {
  await publish(page, { ...doc, html: '<p id="stage">第一部分' }, 'generating', true)
  const frame = page.frameLocator('iframe')
  await frame.locator('#stage').waitFor()
  await page.locator('iframe').evaluate(iframe => { window.originalFrame = iframe; iframe.contentWindow.postMessage({ kind: 'document-update', channel: 'wrong', phase: 'ready', html: '<p>forged</p>', css: '', javascript: 'window.runs=999' }, '*') })
  const channel = await page.evaluate(() => window.uiChecks.messages.find(row => row.channel)?.channel)
  await frame.locator('body').evaluate((_body, channel) => {
    window.frameMarker = crypto.randomUUID()
    parent.postMessage({ kind: 'prompt', channel, requestId: 'preview-forged', value: 'must not submit' }, '*')
  }, channel)
  const marker = await frame.locator('body').evaluate(() => window.frameMarker)
  await publish(page, doc, 'generating')
  await frame.locator('#n').waitFor({ state: 'attached' })
  assert.equal(await frame.locator('body').evaluate(() => document.body.inert), true)
  assert.equal(await frame.locator('body').evaluate(() => window.runs), undefined)
  assert.equal(await page.getByRole('button', { name: '发送到当前对话', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '导出 HTML', exact: true }).isDisabled(), true)
  // Even complete arguments are still a preview until the tool returns successful metadata.
  await publish(page, { ...doc }, 'ready')
  await frame.locator('#total').filter({ hasText: '36' }).waitFor()
  assert.equal(await frame.locator('body').evaluate(() => document.body.inert), false)
  assert.equal(await frame.locator('body').evaluate(() => window.runs), 1)
  await frame.locator('#n').fill('7'); await frame.locator('#n').dispatchEvent('input')
  await frame.locator('#total').filter({ hasText: '84' }).waitFor()
  for (let i = 0; i < 3; i++) await publish(page, { ...doc }, 'ready')
  assert.equal(await frame.locator('#n').inputValue(), '7')
  assert.equal(await frame.locator('body').evaluate(() => window.runs), 1)
  assert.equal(await frame.locator('body').evaluate(() => window.frameMarker), marker)
  assert.equal(await page.evaluate(() => window.originalFrame === document.querySelector('iframe')), true)
  assert.equal(await page.locator('iframe').count(), 1)
  await frame.getByRole('button', { name: '解释', exact: true }).click()
  await page.getByRole('button', { name: '发送到当前对话', exact: true }).waitFor()
  assert.match(await page.locator('aside').innerText(), /84/)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.locator('[data-bridge-receipt="cancelled"]').waitFor()
  assert.deepEqual(await page.evaluate(() => window.uiChecks.sent), [])
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 HTML', exact: true }).click()
  const exported = await download
  await page.screenshot({ path: join(root, 'artifacts/streaming-completed.png'), fullPage: true })
  const exportedPath = join(root, 'artifacts/streaming-export.html')
  await exported.saveAs(exportedPath)
  await page.goto(pathToFileURL(exportedPath).href)
  await page.locator('#total').filter({ hasText: '36' }).waitFor()
}))

test('failure/cancellation keeps preview inert and rejects late activation; a new invocation can succeed', { timeout: 30000 }, async () => withPage(async page => {
  for (const reason of ['tool failure', 'cancelled']) {
    await publish(page, { ...doc, description: reason }, 'generating', true)
    const frame = page.frameLocator('iframe')
    await frame.locator('#n').waitFor({ state: 'attached' })
    await publish(page, doc, 'failed')
    await frame.locator('body').evaluate(() => new Promise(resolve => setTimeout(resolve, 50)))
    const channel = await page.evaluate(() => window.uiChecks.messages.find(row => row.channel)?.channel)
    await page.locator('iframe').evaluate((iframe, channel) => iframe.contentWindow.postMessage({ channel, kind: 'document-update', phase: 'ready', html: '<p>late</p>', css: '', javascript: 'window.runs=999' }, '*'), channel)
    assert.equal(await frame.locator('body').evaluate(() => window.runs), undefined)
    assert.equal(await frame.locator('body').evaluate(() => document.body.inert), true)
    assert.equal(await page.getByRole('button', { name: '重置界面', exact: true }).isDisabled(), true)
    await page.screenshot({ path: join(root, 'artifacts/streaming-stopped.png'), fullPage: true })
  }
  await publish(page, doc, 'ready', true)
  await page.frameLocator('iframe').locator('#total').filter({ hasText: '36' }).waitFor()
  assert.equal(await page.frameLocator('iframe').locator('body').evaluate(() => window.runs), 1)
}))

test('unfinished and adversarial markup cannot run scripts or handlers during preview', { timeout: 30000 }, async () => withPage(async page => {
  const html = '<script>window.injected=1</script><svg onload="window.injected=2"></svg><img src="data:image/x,broken" onerror="window.injected=3"><iframe srcdoc="x"></iframe><form><button>bad</button></form><p id="safe">安全预览</p><input value="unfinished'
  await publish(page, { ...doc, html }, 'generating', true)
  const frame = page.frameLocator('iframe')
  await frame.locator('#safe').waitFor()
  assert.equal(await frame.locator('body').evaluate(() => window.injected), undefined)
  assert.equal(await frame.locator('body').evaluate(() => window.runs), undefined)
  assert.equal(await frame.locator('body script,iframe,form,[onload],[onerror],[src]').count(), 0)
  assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts')
}))
