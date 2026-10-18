import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici'
import { resolveImage } from '../lib/images.js'
import { parseDocument } from '../lib/document.js'
import { parseImages, parseImageRequests, commonsFilename, MAX_IMAGE_BYTES } from '../lib/image-protocol.js'
import * as plugin from '../lib/index.js'
import { png, request, original, thumbnail, image, document } from './image-fixture.mjs'
const policy = { enabled: true, maxBytes: MAX_IMAGE_BYTES, timeoutMs: 5000 }
const bytes = Buffer.from(png, 'base64')
const page = (thumb = thumbnail, orig = original) => ({ query: { pages: [{ ns: 0, title: request.wikipediaTitle, thumbnail: { source: thumb }, original: { source: orig } }] } })
const metadata = (creator = '<a>Fixture &amp; author</a>', license = 'CC0', url = original) => ({ query: { pages: [{ imageinfo: [{ url,
  extmetadata: { Artist: { value: creator }, LicenseShortName: { value: license } } }] }] } })
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
function network(options = {}) {
  const calls = []; let count = 0
  return { calls, fetch: async (url, init) => {
    calls.push(String(url)); count++
    assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.ok(init.signal)
    if (count === 1) return json(options.page ?? page())
    if (count === 2) return json(options.metadata ?? metadata())
    return new Response(options.bytes ?? bytes, { headers: { 'content-type': options.type ?? 'image/png', ...(options.headers ?? {}) } })
  } }
}
async function validator(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-iui-image-')); const ctx = new Context()
  try { const store = new LocalAttachmentStore(ctx, { dshHome: root }); await run(store) }
  finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
}

test('real DSH image decoder accepts matching Commons bytes and plain credits; API tracking parameters are removed', () => validator(async store => {
  const h = network({ page: page(thumbnail + '?utm_source=en.wikipedia.org', original + '?utm_content=original') })
  const result = await resolveImage(request, policy, store, new AbortController().signal, h.fetch)
  assert.equal(result.status, 'available'); assert.equal(result.creator, 'Fixture & author'); assert.equal(result.dataUrl, image.dataUrl)
  assert.equal(result.creditUrl, image.creditUrl); assert.equal(h.calls[2], thumbnail)
  assert.deepEqual(parseImages([result]), [result])
}))

test('unsupported hosts, credentials, local Wikipedia repository, mismatched files and non-article pages never download bytes', () => validator(async store => {
  for (const input of [page('https://private.invalid/x', original), page(thumbnail, original.replace('commons', 'en')),
    page(thumbnail, original.replace('Fixture', 'Other')), page(thumbnail.replace('https://', 'https://user@'), original),
    { query: { pages: [{ ns: 6, thumbnail: { source: thumbnail }, original: { source: original } }] } }]) {
    const h = network({ page: input }); const result = await resolveImage(request, policy, store, new AbortController().signal, h.fetch)
    assert.equal(result.status, 'unavailable'); assert.equal(h.calls.length, 1)
  }
  assert.equal(commonsFilename(thumbnail + '?redirect=https://private.invalid'), null)
}))

test('missing author, unsupported license or mismatched Commons credits cannot be cached', () => validator(async store => {
  for (const input of [metadata('', 'CC0'), metadata('author', 'All rights reserved'), metadata('author', 'CC0', original.replace('Fixture', 'Other'))]) {
    const h = network({ metadata: input }); const result = await resolveImage(request, policy, store, new AbortController().signal, h.fetch)
    assert.equal(result.code, 'ATTRIBUTION_UNAVAILABLE'); assert.equal(h.calls.length, 2)
  }
}))

test('byte limits, SVG, wrong MIME and corrupt raster bytes produce text fallback; body reads are capped', () => validator(async store => {
  for (const options of [{ bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) }, { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } },
    { type: 'image/svg+xml', bytes: '<svg/>' }, { bytes: '<svg/>' }, { type: 'image/jpeg' }]) {
    const h = network(options); const result = await resolveImage(request, policy, store, new AbortController().signal, h.fetch)
    assert.equal(result.status, 'unavailable'); assert.ok(['IMAGE_TOO_LARGE', 'IMAGE_INVALID'].includes(result.code))
    assert.equal(result.dataUrl, undefined)
  }
}))

test('disabled or missing validator does not fetch; caller cancellation propagates rather than persisting a success', () => validator(async store => {
  const h = network()
  assert.equal((await resolveImage(request, { ...policy, enabled: false }, store, new AbortController().signal, h.fetch)).code, 'IMAGES_DISABLED')
  assert.equal((await resolveImage(request, policy, undefined, new AbortController().signal, h.fetch)).code, 'VALIDATOR_UNAVAILABLE')
  assert.equal(h.calls.length, 0)
  const abort = new AbortController()
  await assert.rejects(resolveImage(request, policy, store, abort.signal, async () => { abort.abort(); throw new Error('cancelled') }), { name: 'AbortError' })
  const unavailable = await resolveImage(request, policy, store, new AbortController().signal, async () => { throw new Error('network or redirect refused') })
  assert.equal(unavailable.code, 'SOURCE_UNAVAILABLE')
}))

test('v3 metadata keeps v1/v2 semantics and rejects forged sources, executable data URLs, duplicate IDs and oversized declarations', () => {
  assert.deepEqual(parseDocument(document), document)
  for (const changes of [{ dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }, { creditUrl: 'https://evil.invalid/' },
    { articleUrl: 'https://en.wikipedia.org/wiki/Other' }, { creator: '' }, { license: 'unknown' }, { dataUrl: 'data:image/png;base64,' + 'A'.repeat(400000) }]) {
    assert.equal(parseImages([{ ...image, ...changes }]), null)
  }
  assert.equal(parseImages([image, image]), null)
  assert.equal(parseImageRequests(Array(5).fill(request)), null)
  assert.equal(parseImageRequests([{ ...request, wikipediaTitle: 'A|B' }]), null)
  assert.equal(parseImages([{ ...request, status: 'unavailable', code: 'NO_IMAGE', dataUrl: image.dataUrl }]), null)
  assert.equal(parseDocument({ ...document, version: 1 }), null)
  assert.equal(parseDocument({ ...document, version: 2 }), null)
  assert.equal(parseDocument({ ...document, images: undefined }), null)
  assert.equal(parseDocument({ ...document, libraries: ['chartjs-4.5.1'] }).version, 3)
})

test('actual DSH tool validates requests before network and persists v3 pixels only in metadata/model-independent value; model text omits bytes', () => validator(async store => {
  const ctx = new Context(); const dispatcher = new MockAgent(); dispatcher.disableNetConnect(); const previous = getGlobalDispatcher()
  setGlobalDispatcher(dispatcher)
  try {
    const wiki = dispatcher.get('https://en.wikipedia.org'); const commons = dispatcher.get('https://commons.wikimedia.org'); const upload = dispatcher.get('https://thumb.wikimedia.org')
    wiki.intercept({ path: path => path.startsWith('/w/api.php?'), method: 'GET' }).reply(200, page(), { headers: { 'content-type': 'application/json' } })
    commons.intercept({ path: path => path.startsWith('/w/api.php?'), method: 'GET' }).reply(200, metadata(), { headers: { 'content-type': 'application/json' } })
    upload.intercept({ path: new URL(thumbnail).pathname, method: 'GET' }).reply(200, bytes, { headers: { 'content-type': 'image/png' } })
    await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(SessionProjectionRegistry)
    ctx.provide('attachments', store)
    await ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900 })
    const exec = args => ctx.tools.execute({ callId: 'image-test', name: 'render_intelligent_ui', arguments: args, signal: new AbortController().signal })
    const { version: _version, images: _images, ...fields } = document
    const invalid = await exec({ ...fields, height: 1, images: [request] }); assert.equal(invalid.isError, true)
    const forged = await exec({ ...fields, images: [{ ...request, dataUrl: 'forged', creator: 'forged', imageUrl: 'http://localhost/' }] })
    assert.equal(forged.isError, true)
    const result = await exec({ ...fields, images: [request] })
    assert.equal(result.isError, false); assert.equal(result.meta.intelligentUi.version, 3)
    assert.equal(result.meta.intelligentUi.images[0].creator, 'Fixture & author')
    assert.equal(result.meta.intelligentUi.images[0].dataUrl, image.dataUrl)
    assert.ok(!JSON.stringify(result.content).includes(png)); assert.match(result.content[0].text, /CC0/)
    dispatcher.assertNoPendingInterceptors()
  } finally { setGlobalDispatcher(previous); await dispatcher.close(); await ctx.fiber.dispose() }
}))
