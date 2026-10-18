import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from '../scripts/environment.mjs'
import { getTemplate, TEMPLATE_NAMES } from '../lib/templates.js'

const document = javascript => ({ version: 1, title: 'Runtime check', description: 'Offline controlled fixture; no model calls.', html: '<div id="content">Test</div>', css: '', javascript, height: 300 })
async function withPage(run) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } })
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href)
    await page.waitForFunction(() => window.uiChecks !== undefined)
    try { await run(page) }
    catch (error) {
      console.log('Offline diagnostic:', await page.evaluate(() => ({ host: document.body.innerText, messages: window.uiChecks.messages.slice(-8) })))
      throw error
    }
  } finally { await browser.close() }
}
async function mount(page, doc, mode = 'ok') {
  await page.evaluate(({ doc, mode }) => window.uiChecks.mount(doc, mode), { doc, mode })
  await page.locator('[data-runtime-status]').filter({ hasText: /已加载|运行错误/ }).waitFor()
  return page.frameLocator('iframe')
}
async function propose(frame, text = '当前数量为 7，总价 84') {
  await frame.locator('body').evaluate((_element, text) => {
    window.receipts = []; window.result = null
    window.stopReceipts?.()
    window.stopReceipts = window.dshUI.onReceipt(receipt => window.receipts.push(receipt))
    window.dshUI.sendPrompt(text).then(value => { window.result = value }).catch(error => { window.result = { status: 'rejected', code: error.code } })
  }, text)
}
async function waitResult(frame, status) {
  await frame.locator('body').evaluate((_element, status) => new Promise((resolve, reject) => {
    let attempts = 0
    const check = () => window.result?.status === status ? resolve() : ++attempts > 300 ? reject(new Error('Missing receipt: ' + JSON.stringify(window.result))) : setTimeout(check, 10)
    check()
  }), status)
  return frame.locator('body').evaluate(() => window.result)
}

test('auto-height grows, shrinks and clamps without remounting; foreign and stale reports are ignored', { timeout: 30000 }, async () => withPage(async page => {
  const doc = document('window.marker = crypto.randomUUID();')
  doc.html = '<div id="content" style="height:220px">Grow and shrink</div>'
  const frame = await mount(page, doc)
  const marker = await frame.locator('body').evaluate(() => window.marker)
  await page.waitForFunction(() => parseFloat(document.querySelector('iframe').style.height) >= 250)
  const oldChannel = await page.evaluate(() => window.uiChecks.messages.find(row => row.channel)?.channel)
  await frame.locator('#content').evaluate(element => { element.style.height = '850px' })
  await page.waitForFunction(() => parseFloat(document.querySelector('iframe').style.height) >= 880)
  await frame.locator('#content').evaluate(element => { element.style.height = '100px' })
  await page.waitForFunction(() => parseFloat(document.querySelector('iframe').style.height) === 180)
  assert.equal(await frame.locator('body').evaluate(() => window.marker), marker)
  await frame.locator('#content').evaluate(element => { element.style.height = '8000px' })
  await page.waitForFunction(() => parseFloat(document.querySelector('iframe').style.height) === 4000)
  await page.evaluate(channel => window.postMessage({ channel, kind: 'resize', height: 222 }, '*'), oldChannel)
  assert.equal(await page.locator('iframe').evaluate(frame => parseFloat(frame.style.height)), 4000)
  await page.getByRole('button', { name: '重置界面', exact: true }).click()
  await page.waitForFunction(() => parseFloat(document.querySelector('iframe').style.height) < 4000)
  await page.frameLocator('iframe').locator('body').evaluate((_element, channel) => parent.postMessage({ channel, kind: 'resize', height: 3999 }, '*'), oldChannel)
  assert.notEqual(await page.locator('iframe').evaluate(frame => parseFloat(frame.style.height)), 3999)
}))

test('runtime feedback catches synchronous, syntax, asynchronous, explicit and CSP errors; reset clears reports', { timeout: 30000 }, async () => withPage(async page => {
  for (const [script, expected] of [
    ['throw new Error("sync failure")', 'sync failure'],
    ['function invalid( {', /Unexpected|Invalid|expected|end of input/i],
    ['Promise.reject(new Error("async failure"))', 'async failure'],
    ['window.dshUI.reportError(new Error("caught initialization failure"))', 'caught initialization failure'],
    ['fetch("https://example.com").catch(() => {})', 'Blocked by sandbox policy'],
  ]) {
    await mount(page, document(script))
    await page.locator('[data-runtime-errors]').getByText(expected, { exact: false }).first().waitFor()
    assert.match(await page.locator('[data-runtime-status]').textContent(), /运行错误/)
  }
  await mount(page, document('document.getElementById("content").textContent="clean"'))
  assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
}))

test('follow-up promises receive matching pending, sending and queued receipts; cancellation, duplicate clicks and busy requests do not resend', { timeout: 30000 }, async () => withPage(async page => {
  const frame = await mount(page, document(''))
  await propose(frame)
  await page.locator('[data-bridge-receipt="pending-confirmation"]').waitFor()
  assert.equal(await page.evaluate(() => window.uiChecks.sent.length), 0)
  await page.evaluate(() => {
    const channel = window.uiChecks.messages.find(row => row.kind === 'prompt').channel
    document.querySelector('iframe').contentWindow.postMessage({ channel, kind: 'receipt', requestId: 'wrong-id', status: 'queued', modelCompleted: false }, '*')
  })
  assert.equal(await frame.locator('body').evaluate(() => window.result), null)
  await frame.locator('body').evaluate(() => window.dshUI.sendPrompt('duplicate').catch(error => { window.duplicateCode = error.code }))
  assert.equal(await frame.locator('body').evaluate(() => window.duplicateCode), 'BUSY')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal((await waitResult(frame, 'rejected')).code, 'CANCELLED')
  assert.equal(await page.evaluate(() => window.uiChecks.sent.length), 0)
  await propose(frame)
  await page.getByRole('button', { name: '发送到当前对话', exact: true }).evaluate(button => { button.click(); button.click() })
  const result = await waitResult(frame, 'queued')
  assert.equal(result.modelCompleted, false)
  assert.equal(await page.evaluate(() => window.uiChecks.sent.length), 1)
  const receipts = await frame.locator('body').evaluate(() => window.receipts)
  assert.deepEqual(receipts.map(row => row.status), ['pending-confirmation', 'sending', 'queued'])
  assert.ok(receipts.every(row => row.requestId === result.requestId))
  assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
  await page.screenshot({ path: join(root, 'artifacts/runtime-receipts.png'), fullPage: true })
}))

test('queue failures reject the iframe promise and permit retry; late completion after remount cannot update the new widget', { timeout: 30000 }, async () => withPage(async page => {
  let frame = await mount(page, document(''), 'fail')
  await propose(frame)
  await page.getByRole('button', { name: '发送到当前对话', exact: true }).click()
  assert.equal((await waitResult(frame, 'rejected')).code, 'SEND_FAILED')
  await page.locator('[data-bridge-receipt="failed"]').filter({ hasText: 'Simulated queue rejection' }).waitFor()
  await page.evaluate(() => { window.uiChecks.mode = 'defer' })
  await propose(frame, 'retry')
  await page.getByRole('button', { name: '发送到当前对话', exact: true }).click()
  await page.locator('[data-bridge-receipt="sending"]').waitFor()
  await page.waitForFunction(() => typeof window.uiChecks.finish === 'function')
  await page.evaluate(() => { window.lateFinish = window.uiChecks.finish })
  frame = await mount(page, document('window.marker="new mount"'))
  await page.evaluate(() => window.lateFinish())
  assert.equal(await page.locator('[data-bridge-receipt]').count(), 0)
  assert.equal(await frame.locator('body').evaluate(() => window.marker), 'new mount')
  assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
}))

test('original generation templates run offline with working validation, selection, reset and current-value follow-up', { timeout: 30000 }, async () => withPage(async page => {
  for (const name of ['calculator', 'comparison', 'flowchart']) {
    const frame = await mount(page, getTemplate(name))
    let expected
    if (name === 'calculator') {
      await frame.locator('#quantity').fill('7'); await frame.locator('#quantity').dispatchEvent('input')
      assert.equal(await frame.locator('#total').textContent(), '84.00')
      await frame.locator('#quantity').fill(''); await frame.locator('#quantity').dispatchEvent('input')
      assert.equal(await frame.locator('#followup').isDisabled(), true)
      assert.equal(await frame.locator('#total').textContent(), '—')
      await frame.locator('#quantity').fill('7'); await frame.locator('#quantity').dispatchEvent('input'); expected = '84.00'
    } else if (name === 'comparison') {
      await frame.locator('#sort').selectOption('score')
      assert.match(await frame.locator('#rows tr').first().textContent(), /方案 B/)
      await frame.getByRole('button', { name: '选择 方案 C', exact: true }).click(); expected = '方案 C'
    } else {
      await frame.getByRole('button', { name: '下一步', exact: true }).click()
      assert.match(await frame.locator('#step-detail').textContent(), /2\/3/); expected = '第 2 步'
    }
    await frame.locator('#followup').click()
    await page.getByRole('button', { name: '发送到当前对话', exact: true }).waitFor()
    assert.ok((await page.locator('aside').textContent()).includes(expected))
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await frame.locator('#followup').waitFor({ state: 'visible' })
    await frame.locator('#reset').click()
    assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
    assert.equal(await page.evaluate(() => window.uiChecks.sent.length), 0)
  }
  await page.screenshot({ path: join(root, 'artifacts/template-flowchart.png'), fullPage: true })
  writeFileSync(join(root, 'artifacts/runtime-upgrade-browser.json'), JSON.stringify({ autoHeight: true, shrink: true, maxHeight: 4000, runtimeErrors: ['script', 'syntax', 'promise', 'explicit', 'policy'], receipts: ['pending-confirmation', 'sending', 'queued', 'cancelled', 'failed'], templates: ['calculator', 'comparison', 'flowchart'], lateCompletionIsolated: true, modelCalled: false }, null, 2))
}))

test('requests made before the host handshake are retained until confirmation, and runtime report floods are bounded', { timeout: 30000 }, async () => withPage(async page => {
  const frame = await mount(page, document(`window.result=null; window.dshUI.sendPrompt('early controlled fixture').then(value=>{window.result=value}).catch(error=>{window.result={status:'rejected',code:error.code}});`))
  await page.getByRole('button', { name: '发送到当前对话', exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.uiChecks.sent.length), 0)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal((await waitResult(frame, 'rejected')).code, 'CANCELLED')
  await frame.locator('body').evaluate(() => { for (let index = 0; index < 30; index++) window.dshUI.reportError(`issue-${index}`) })
  await page.waitForFunction(() => document.querySelectorAll('[data-runtime-errors] li').length === 10)
  assert.equal(await page.locator('[data-runtime-errors] li').count(), 10)
}))

test('exported templates retain working controls and reject chat actions explicitly outside DSH', { timeout: 30000 }, async () => withPage(async page => {
  await mount(page, getTemplate('calculator'))
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 HTML', exact: true }).click()
  const download = await downloadEvent
  const destination = join(root, 'artifacts/runtime-export.html')
  await download.saveAs(destination)
  await page.goto(pathToFileURL(destination).href)
  await page.locator('#quantity').fill('7'); await page.locator('#quantity').dispatchEvent('input')
  assert.equal(await page.locator('#total').textContent(), '84.00')
  assert.equal(await page.evaluate(async () => {
    try { await window.dshUI.sendPrompt('offline request'); return 'unexpected' }
    catch (error) { return error.code }
  }), 'HOST_UNAVAILABLE')
}))
