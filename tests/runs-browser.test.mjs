import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from '../scripts/environment.mjs'
import { getTemplate } from '../lib/templates.js'
async function browserTest(run) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage(); const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href)
    await page.waitForFunction(() => window.uiChecks)
    await page.evaluate(doc => window.uiChecks.mount(doc), getTemplate('calculator'))
    await page.locator('[data-runtime-status]').filter({ hasText: '交互界面已加载' }).waitFor()
    const frame = page.frameLocator('iframe')
    await frame.locator('#followup').waitFor()
    await frame.locator('body').evaluate(() => { window.runEvents = []; window.dshUI.onRunStatus(row => window.runEvents.push(row)) })
    await run(page, frame)
    assert.deepEqual(errors, [])
    assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
  } finally { await browser.close() }
}
const status = (requestId, value, callId = 'check-call') => ({ version: 1, requestId, callId, messageId: 'message-' + requestId, turn: value === 'queued' ? null : 2,
  status: value, modelCompleted: value === 'completed' })
async function publish(page, rows) { await page.evaluate(runs => window.uiChecks.runs({ version: 1, runs }), rows) }
async function send(page, frame) {
  await frame.locator('#followup').click()
  await page.getByRole('button', { name: '发送到当前对话', exact: true }).click()
  await page.locator('[data-bridge-receipt="queued"]').waitFor()
  return page.evaluate(() => window.uiChecks.requests.at(-1))
}

test('browser separates queue receipt from model completion and scopes each status to its widget and request', { timeout: 30000 }, () => browserTest(async (page, frame) => {
  await frame.locator('#quantity').fill('7'); await frame.locator('#quantity').dispatchEvent('input')
  const first = await send(page, frame)
  await publish(page, [status(first, 'queued'), status('foreign', 'completed', 'another-call')])
  await page.locator('[data-model-run="queued"]').waitFor()
  assert.equal(await page.locator('[data-model-run="completed"]').count(), 0)
  await publish(page, [status(first, 'running')])
  await page.locator('[data-model-run="running"]').waitFor()
  await frame.locator('#bridge-status').filter({ hasText: '模型处理中' }).waitFor()
  assert.equal(await frame.locator('#quantity').inputValue(), '7')
  const second = await send(page, frame)
  await publish(page, [status(first, 'failed'), status(second, 'running')])
  await page.locator('[data-model-run="failed"]').waitFor()
  await frame.locator('#bridge-status').filter({ hasText: '模型处理中' }).waitFor()
  await publish(page, [status(first, 'failed'), status(second, 'completed')])
  await page.locator('[data-model-run="completed"]').waitFor()
  await frame.locator('#bridge-status').filter({ hasText: '已完成' }).waitFor()
  const rows = await frame.locator('body').evaluate(() => window.dshUI.getRunStatuses())
  assert.equal(rows.find(row => row.requestId === first).modelCompleted, false)
  assert.equal(rows.find(row => row.requestId === second).modelCompleted, true)
  assert.equal(rows.some(row => row.requestId === 'foreign'), false)
  assert.equal(await page.locator('[data-bridge-receipt="queued"]').count(), 1)
  await page.screenshot({ path: join(root, 'artifacts/runs-browser.png'), fullPage: true })
}))

test('browser restores model status after remount with a new channel and never sends a prompt on restoration', { timeout: 30000 }, () => browserTest(async (page, frame) => {
  const id = await send(page, frame)
  await publish(page, [status(id, 'completed')]); await page.locator('[data-model-run="completed"]').waitFor()
  const oldChannel = await page.evaluate(() => window.uiChecks.messages.find(row => row.kind === 'prompt').channel)
  await page.evaluate(doc => window.uiChecks.mount(doc), getTemplate('calculator'))
  await publish(page, [status(id, 'completed')])
  await page.locator('[data-model-run="completed"]').waitFor()
  await page.waitForFunction(() => document.querySelector('iframe').contentWindow !== null)
  await frame.locator('body').evaluate(() => { window.replayed = []; window.dshUI.onRunStatus(row => window.replayed.push(row)) })
  await frame.locator('body').evaluate(async () => { while (!window.replayed.length) await new Promise(r => setTimeout(r, 20)) })
  assert.equal(await frame.locator('body').evaluate(() => window.replayed.at(-1).requestId), id)
  await page.evaluate(({ channel, value }) => document.querySelector('iframe').contentWindow.postMessage({ channel, kind: 'run-status', value }, '*'), { channel: oldChannel, value: status(id, 'failed') })
  assert.equal(await page.locator('[data-model-run="completed"]').count(), 1)
  assert.equal(await page.evaluate(() => window.uiChecks.sent.length), 0)
}))

test('browser marks observation timeout unknown and recovers on a later authoritative result without cancelling or resending', { timeout: 30000 }, () => browserTest(async (page, frame) => {
  const id = await send(page, frame)
  await page.clock.install()
  await publish(page, [status(id, 'running')]); await page.locator('[data-model-run="running"]').waitFor()
  await page.clock.fastForward(300001)
  await page.locator('[data-model-run="unknown"]').waitFor()
  await publish(page, [status(id, 'completed')]); await page.locator('[data-model-run="completed"]').waitFor()
  assert.equal(await page.evaluate(() => window.uiChecks.sent.length), 1)
  await frame.locator('#bridge-status').filter({ hasText: '已完成' }).waitFor()
}))

test('fast model completion before prompt RPC resolves is preserved by template; unknown versions are ignored', { timeout: 30000 }, () => browserTest(async (page, frame) => {
  await page.evaluate(() => { window.uiChecks.mode = 'defer' })
  await frame.locator('#followup').click(); await page.getByRole('button', { name: '发送到当前对话', exact: true }).click()
  await page.waitForFunction(() => typeof window.uiChecks.finish === 'function')
  const id = await page.evaluate(() => window.uiChecks.requests.at(-1))
  await publish(page, [status(id, 'completed')]); await page.locator('[data-model-run="completed"]').waitFor()
  await frame.locator('#bridge-status').filter({ hasText: '已完成' }).waitFor()
  await page.evaluate(() => window.uiChecks.finish())
  await page.locator('[data-bridge-receipt="queued"]').waitFor()
  await frame.locator('#bridge-status').filter({ hasText: '已完成' }).waitFor()
  await page.evaluate(value => {
    const channel = window.uiChecks.messages.find(row => row.kind === 'prompt').channel
    document.querySelector('iframe').contentWindow.postMessage({ channel, kind: 'run-status', value: { ...value, version: 99 } }, '*')
  }, status(id, 'failed'))
  assert.equal(await frame.locator('body').evaluate(() => window.dshUI.getRunStatuses().at(-1).status), 'completed')
}))
