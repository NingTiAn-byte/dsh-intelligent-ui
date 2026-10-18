import { launchBrowser } from './browser-helper.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from '../scripts/environment.mjs'
import { makeTheme } from '../lib/theme.js'
test('custom game skins retain their colors on hover and selection while neutral controls keep their states',async()=>{
 const browser=await launchBrowser()
 try{
  const context=await browser.newContext({offline:true});const page=await context.newPage()
  await page.goto(pathToFileURL(join(root,'preview/checks.html')).href);await page.waitForFunction(()=>window.uiChecks)
  await page.evaluate(d=>window.uiChecks.mount(d),{version:1,title:'Scene skin',description:'',height:300,html:'<h2>Scene</h2><button id="a" class="skin-a">A</button><button id="cart" class="skin-cart" aria-pressed="true">SNAKE</button><button id="neutral">Pause</button>',css:'.skin-a{background:#b43720;color:white}.skin-cart{background:#25262d;color:#f4ead6}',javascript:''})
  const f=page.frameLocator('iframe');await page.locator('[data-runtime-status][data-settled=true]').waitFor()
  const background=l=>l.evaluate(e=>getComputedStyle(e).backgroundColor)
  const neutral=await background(f.locator('#neutral'));await f.locator('#neutral').hover();await page.waitForTimeout(200);assert.notEqual(await background(f.locator('#neutral')),neutral,'neutral hover must still be visible')
  await f.locator('#a').hover();assert.equal(await background(f.locator('#a')),'rgb(180, 55, 32)')
  await f.locator('#cart').hover();assert.equal(await background(f.locator('#cart')),'rgb(37, 38, 45)')
  await page.evaluate(t=>window.uiChecks.setTheme(t),makeTheme('dark'))
  await f.locator('html[data-iui-theme=dark]').waitFor();assert.equal(await background(f.locator('#cart')),'rgb(37, 38, 45)')
  assert.equal(await page.locator('[data-runtime-errors]').count(),0)
 }finally{await browser.close()}
})
