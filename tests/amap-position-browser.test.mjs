import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { launchBrowser } from './browser-helper.mjs'
import { amapView } from '../lib/amap.js'
import { mapDocument } from '../lib/features.js'
import { root } from '../scripts/environment.mjs'

test('AMap pins match independently drawn static-image control points after resize, zoom, pan and replay', { timeout: 30000 }, async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1200 }, offline: true })
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href)
    await page.waitForFunction(() => window.uiChecks)
    const stops = [
      { name: 'A', longitude: 121.49, latitude: 31.23, description: 'Synthetic control A', source: 'Synthetic' },
      { name: 'B', longitude: 121.51, latitude: 31.24, description: 'Synthetic control B', source: 'Synthetic' },
      { name: 'C', longitude: 121.485, latitude: 31.22, description: 'Synthetic control C', source: 'Synthetic' },
    ]
    const view = amapView(stops), width = 640, height = 360
    // Reference grid calibrated from official AMap marker pixel displacement,
    // intentionally separate from the bounds returned by amapView.
    const project = p => [(p.longitude + 180) / 360 * 512 * 2 ** view.zoom, (1 - Math.asinh(Math.tan(p.latitude * Math.PI / 180)) / Math.PI) / 2 * 512 * 2 ** view.zoom]
    const center = project(view.center)
    const pixels = stops.map(p => { const q = project(p); return [width / 2 + q[0] - center[0], height / 2 + q[1] - center[1]] })
    const dataUrl = await page.evaluate(({ pixels, width, height }) => {
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#eee'; ctx.fillRect(0, 0, width, height)
      ctx.fillStyle = '#f00'; for (const [x, y] of pixels) ctx.fillRect(x - 2, y - 2, 4, 4)
      return canvas.toDataURL('image/png')
    }, { pixels, width, height })
    const doc = mapDocument({ title: 'AMap pixel controls', basemap: 'street', durationMs: 1000, stops }, undefined, { bounds: view.bounds, dataUrl })
    await page.evaluate(doc => window.uiChecks.mount(doc), doc)
    const frame = page.frameLocator('iframe')
    await frame.locator('.iui-pin').first().waitFor()
    async function aligned() {
      const errors = await frame.locator('#iui-map').evaluate((node, pixels) => {
        const image = node.querySelector('.leaflet-image-layer').getBoundingClientRect()
        return [...node.querySelectorAll('.iui-pin')].map((pin, i) => {
          const r = pin.getBoundingClientRect()
          return Math.hypot(r.left + r.width / 2 - image.left - pixels[i][0] / 640 * image.width, r.top + r.height / 2 - image.top - pixels[i][1] / 360 * image.height)
        })
      }, pixels)
      assert.ok(errors.every(error => error < 2), `pin/image pixel errors: ${errors}`)
    }
    await aligned()
    await frame.locator('.leaflet-control-zoom-in').click(); await page.waitForTimeout(400); await aligned()
    await frame.locator('.trip-stop-button').nth(1).click(); await page.waitForTimeout(400); await aligned()
    await page.setViewportSize({ width: 720, height: 1200 }); await page.waitForTimeout(400); await aligned()
    await page.evaluate(doc => window.uiChecks.mount(JSON.parse(JSON.stringify(doc))), doc)
    await frame.locator('.iui-pin').first().waitFor(); await aligned()
  } finally { await browser.close() }
})
