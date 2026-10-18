import type { AttachmentStore, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { decodeHTML } from 'entities'
import { fetch as networkFetch, type Dispatcher, type RequestInit } from 'undici'
import { articleUrl, commonsFilename, creditUrl, reusableLicense, MAX_IMAGE_BYTES, type ImageRequest, type UiImage, type ImageCode } from '../shared/images.ts'

export interface ImagePolicy { enabled: boolean; maxBytes: number; timeoutMs: number; dispatcher?: Dispatcher }
type Fetch = typeof networkFetch
class ImageFailure extends Error { constructor(readonly code: ImageCode) { super(code) } }
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const firstPage = (value: unknown) => {
  const pages = object(object(value).query).pages
  return Array.isArray(pages) && pages.length === 1 ? object(pages[0]) : {}
}
/** All requests are anonymous, fixed-host GETs; redirects are never followed. */
async function read(url: URL, limit: number, signal: AbortSignal, fetcher: Fetch, json: boolean, dispatcher?: Dispatcher): Promise<{ bytes: Uint8Array; type: string }> {
  const options: RequestInit & { dispatcher?: Dispatcher } = { method: 'GET', signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', dispatcher, headers: {
    'user-agent': 'dsh-intelligent-ui/1.1.0 (+https://github.com/deepseek-ai/deepseek-harness)',
    accept: json ? 'application/json' : 'image/png,image/jpeg,image/webp,image/gif',
  } }
  const response = await fetcher(url, options)
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!response.ok || (json ? type !== 'application/json' : !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(type))) {
    await response.body?.cancel(); throw new ImageFailure(json ? 'SOURCE_UNAVAILABLE' : 'IMAGE_INVALID')
  }
  const length = Number(response.headers.get('content-length'))
  if (Number.isFinite(length) && length > limit) { await response.body?.cancel(); throw new ImageFailure('IMAGE_TOO_LARGE') }
  if (!response.body) throw new ImageFailure('SOURCE_UNAVAILABLE')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let count = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      count += value.byteLength
      if (count > limit) { await reader.cancel(); throw new ImageFailure('IMAGE_TOO_LARGE') }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(count); let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return { bytes, type }
}
export async function query(host: string, parameters: Record<string, string>, signal: AbortSignal, fetcher: Fetch = networkFetch, dispatcher?: Dispatcher): Promise<unknown> {
  if (!['en.wikipedia.org', 'zh.wikipedia.org', 'commons.wikimedia.org'].includes(host)) throw new Error('Unsupported media host')
  const url = new URL(`https://${host}/w/api.php`)
  url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...parameters }).toString()
  const result = await read(url, 256000, signal, fetcher, true, dispatcher)
  try { return JSON.parse(new TextDecoder().decode(result.bytes)) }
  catch { throw new ImageFailure('SOURCE_UNAVAILABLE') }
}
export function plainMetadata(value: unknown): string {
  const text = object(value).value
  if (typeof text !== 'string' || text.length > 20000) return ''
  return decodeHTML(text.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 500)
}
/** Resolve one article photo, verify matching Commons credits, fully decode it with DSH, then persist only bounded bytes. */
export async function resolveImage(request: ImageRequest, policy: ImagePolicy, attachments: AttachmentStore | undefined,
  parentSignal: AbortSignal, fetcher: Fetch = networkFetch): Promise<UiImage> {
  parentSignal.throwIfAborted()
  const unavailable = (code: ImageCode): UiImage => ({ ...request, status: 'unavailable', code })
  if (!policy.enabled) return unavailable('IMAGES_DISABLED')
  if (!attachments) return unavailable('VALIDATOR_UNAVAILABLE')
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(policy.timeoutMs)])
  try {
    const page = request.commonsFile ? null : firstPage(await query(`${request.language}.wikipedia.org`, {
      titles: request.wikipediaTitle, redirects: '1', converttitles: '1', prop: 'pageimages', piprop: 'thumbnail|original', pithumbsize: '640', pilicense: 'free',
    }, signal, fetcher, policy.dispatcher))
    if (page && (page.ns !== 0 || page.missing === true)) throw new ImageFailure('NO_IMAGE')
    let thumbnail = page ? object(page.thumbnail).source : undefined
    const filename = request.commonsFile ?? commonsFilename(page ? object(page.original).source : undefined)
    if (!filename || page && commonsFilename(thumbnail) !== filename) throw new ImageFailure('NO_IMAGE')
    const commons = firstPage(await query('commons.wikimedia.org', { titles: 'File:' + filename, prop: 'imageinfo', iiprop: 'extmetadata|url', iiurlwidth: '640' }, signal, fetcher, policy.dispatcher))
    const info = Array.isArray(commons.imageinfo) ? object(commons.imageinfo[0]) : {}
    if (commonsFilename(info.url) !== filename) throw new ImageFailure('ATTRIBUTION_UNAVAILABLE')
    if (request.commonsFile) thumbnail = info.thumburl ?? info.url
    if (commonsFilename(thumbnail) !== filename) throw new ImageFailure('NO_IMAGE')
    const metadata = object(info.extmetadata)
    const creator = plainMetadata(metadata.Artist); const license = plainMetadata(metadata.LicenseShortName)
    if (!creator || !reusableLicense(license)) throw new ImageFailure('ATTRIBUTION_UNAVAILABLE')
    const imageUrl = new URL(thumbnail as string); imageUrl.search = '' // PageImages adds optional attribution-tracking query parameters.
    const result = await read(imageUrl, Math.min(policy.maxBytes, MAX_IMAGE_BYTES), signal, fetcher, false, policy.dispatcher)
    try { await attachments.validateImage({ data: result.bytes, mediaType: result.type as ImageMediaType }) }
    catch { throw new ImageFailure('IMAGE_INVALID') }
    signal.throwIfAborted()
    return { ...request, status: 'available', imageUrl: imageUrl.href, articleUrl: articleUrl(request), creditUrl: creditUrl(filename), creator, license,
      dataUrl: `data:${result.type};base64,${Buffer.from(result.bytes).toString('base64')}` }
  } catch (error) {
    parentSignal.throwIfAborted()
    return unavailable(error instanceof ImageFailure ? error.code : 'SOURCE_UNAVAILABLE')
  }
}
