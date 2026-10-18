import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { root } from '../scripts/environment.mjs'


test('real browser: calculation, iframe confinement, confirmation bridge, reset and screenshot', { timeout: 60000 }, async () => {

  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } })
    const errors = []; page.on('pageerror', error => errors.push(error.message))
    await page.goto(pathToFileURL(join(root, 'preview/index.html')).href)
    const iframe = page.frameLocator('iframe')
    await iframe.locator('#count').fill('7')
    await iframe.locator('#count').dispatchEvent('input')
    assert.equal(await iframe.locator('#total').textContent(), '84')
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts')
    const opaque = await iframe.locator('body').evaluate(() => { try { return parent.document !== undefined } catch { return false } })
    assert.equal(opaque, false)
    const networkDenied = await iframe.locator('body').evaluate(async () => { try { await fetch('https://example.com'); return false } catch { return true } })
    assert.equal(networkDenied, true)
    // Foreign sources cannot stage a request, even when they know a channel.
    await page.evaluate(() => window.postMessage({ channel: 'fake', kind: 'prompt', value: 'forged' }, '*'))
    assert.equal(await page.getByRole('button', { name: '发送到当前对话' }).count(), 0)
    await iframe.locator('#follow').click()
    await page.getByRole('button', { name: '发送到当前对话' }).waitFor()
    assert.equal(await page.locator('#sent').textContent(), '')
    await page.getByRole('button', { name: '发送到当前对话' }).click()
    await page.waitForFunction(() => document.getElementById('sent').textContent.includes('持久化'))
    await page.getByRole('button', { name: '重置界面' }).click()
    assert.equal(await page.frameLocator('iframe').locator('#total').textContent(), '36')
    mkdirSync(join(root, 'artifacts'), { recursive: true })
    await page.screenshot({ path: join(root, 'artifacts/preview.png'), fullPage: true })
    writeFileSync(join(root, 'artifacts/browser-result.json'), JSON.stringify({ calculation: '7 × 12 = 84', opaqueOrigin: true, networkDenied, confirmationRequired: true, reset: true, pageErrors: errors }, null, 2))
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
