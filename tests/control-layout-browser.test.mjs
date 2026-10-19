import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from './browser-helper.mjs'
import { root } from '../scripts/environment.mjs'
import { makeTheme } from '../lib/theme.js'

test('control rows prevent the 272px sidebar overflow without shrinking A/B or changing their actions', { timeout: 30000 }, async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1100 }, offline: true })
    await page.goto(pathToFileURL(join(root, 'preview/checks.html')).href)
    await page.waitForFunction(() => window.uiChecks)
    const doc = {
      version: 1, title: 'Control layout regression', description: 'Synthetic sidebar reproduction', height: 400,
      html: '<div class="panel"><div class="control-row"><div class="dpad"><button>↑</button><button>←</button><button>→</button><button>↓</button></div><div class="ab"><button id="a">A</button><button id="b">B</button></div></div><output id="clicks">0</output></div>',
      css: '.panel{width:272px;max-width:100%;padding:12px;border:1px solid gray}.control-row{display:flex;align-items:flex-end;justify-content:space-between;gap:12px}.dpad{display:grid;grid-template-columns:repeat(3,44px);grid-template-rows:repeat(3,44px);gap:3px}.dpad button{padding:0}.ab{display:flex;gap:10px}.ab button{width:58px;height:58px;padding:0;border-radius:50%;background:#b3305d}',
      javascript: 'let clicks=0;for(const id of ["a","b"])document.getElementById(id).onclick=()=>document.getElementById("clicks").textContent=String(++clicks)',
    }
    await page.evaluate(doc => window.uiChecks.mount(doc), doc)
    await page.locator('[data-runtime-status][data-settled=true]').waitFor()
    const frame = page.frameLocator('iframe')
    async function metrics() {
      return frame.locator('.panel').evaluate(panel => {
        const p = panel.getBoundingClientRect(), d = panel.querySelector('.dpad').getBoundingClientRect()
        return [...panel.querySelectorAll('.ab button')].map(button => {
          const b = button.getBoundingClientRect()
          return { inside: b.left >= p.left + 12 && b.right <= p.right - 12 && b.top >= p.top && b.bottom <= p.bottom, overlap: b.left < d.right && b.right > d.left && b.top < d.bottom && b.bottom > d.top, width: b.width, height: b.height }
        })
      })
    }
    assert.ok((await metrics()).some(button => !button.inside), 'reproduce the original non-wrapping layout defect')
    await frame.locator('.control-row').evaluate(row => { row.classList.add('iui-control-row'); row.querySelector('.ab').classList.add('iui-action-keys') })
    for (const width of [240, 272, 360, 480]) {
      await frame.locator('.panel').evaluate((panel, width) => { panel.style.width = width + 'px' }, width)
      for (const fontSize of [14, 22]) {
        await page.evaluate(theme => window.uiChecks.setTheme(theme), { ...makeTheme('dark'), fontSize })
        const buttons = await metrics()
        assert.ok(buttons.every(button => button.inside && !button.overlap && button.width >= 44 && button.height >= 44), JSON.stringify({ width, fontSize, buttons }))
      }
    }
    await page.setViewportSize({ width: 320, height: 1100 })
    assert.ok((await metrics()).every(button => button.inside && !button.overlap))
    await frame.locator('#a').click(); await frame.locator('#b').click()
    assert.equal(await frame.locator('#clicks').textContent(), '2')
    assert.equal(await frame.locator('#a').evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(179, 48, 93)')
    assert.equal(await page.locator('[data-runtime-errors]').count(), 0)
  } finally { await browser.close() }
})
