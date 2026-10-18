export const MAX_IMAGES = 4
export const MAX_IMAGE_BYTES = 256000
export const MAX_TOTAL_IMAGE_BYTES = MAX_IMAGE_BYTES * MAX_IMAGES
export const IMAGE_CODES = ['NO_IMAGE', 'SOURCE_UNAVAILABLE', 'ATTRIBUTION_UNAVAILABLE', 'IMAGE_TOO_LARGE', 'IMAGE_INVALID', 'IMAGES_DISABLED', 'VALIDATOR_UNAVAILABLE'] as const
export type ImageCode = typeof IMAGE_CODES[number]
export interface ImageRequest { id: string; wikipediaTitle: string; language: 'en' | 'zh'; alt: string; commonsFile?: string }
export interface UiImage extends ImageRequest {
  status: 'available' | 'unavailable'
  dataUrl?: string
  imageUrl?: string
  articleUrl?: string
  creditUrl?: string
  creator?: string
  license?: string
  code?: ImageCode
}
export const IMAGE_REQUEST_PROPERTIES = {
  id: { type: 'string', required: true, description: 'Unique image ID: 1–40 ASCII letters, digits, underscore or hyphen. Use <figure data-iui-image="ID"></figure> as its placeholder.' },
  wikipediaTitle: { type: 'string', required: true, description: 'Precise Wikipedia article title, 1–160 characters. No URL, pipe or fragment. Use a main-namespace article, not File: or Special: pages.' },
  language: { type: 'string', enum: ['en', 'zh'], required: true },
  commonsFile: { type: 'string', description: 'Optional exact Commons filename returned by search_intelligent_ui_images, without File: prefix. Uses this file instead of the article thumbnail.' },
  alt: { type: 'string', required: true, description: 'Accessible description of the pictured subject, at most 300 characters; no implementation notes.' },
} as const
export const IMAGE_ASSET_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  ...IMAGE_REQUEST_PROPERTIES,
  status: { type: 'string', enum: ['available', 'unavailable'], required: true },
  dataUrl: { type: 'string' }, imageUrl: { type: 'string' }, articleUrl: { type: 'string' }, creditUrl: { type: 'string' },
  creator: { type: 'string' }, license: { type: 'string' }, code: { type: 'string', enum: IMAGE_CODES },
} } as const
export function parseImageRequests(value: unknown): ImageRequest[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_IMAGES) return null
  const result: ImageRequest[] = []; const ids = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(row.id) || ids.has(row.id)
      || !['en', 'zh'].includes(String(row.language)) || typeof row.wikipediaTitle !== 'string'
      || !row.wikipediaTitle.trim() || row.wikipediaTitle.length > 160 || /[|#\x00-\x1f\x7f]/.test(row.wikipediaTitle)
      || /^https?:/i.test(row.wikipediaTitle) || typeof row.alt !== 'string' || !row.alt.trim() || row.alt.length > 300) return null
    if (row.commonsFile !== undefined && (typeof row.commonsFile !== 'string' || !row.commonsFile.trim() || row.commonsFile.length > 300 || /[\/\\|#\x00-\x1f\x7f]/.test(row.commonsFile) || /^File:/i.test(row.commonsFile))) return null
    ids.add(row.id)
    result.push({ id: row.id, wikipediaTitle: row.wikipediaTitle.trim(), language: row.language as 'en' | 'zh', alt: row.alt.trim(), ...(typeof row.commonsFile === 'string' ? { commonsFile: row.commonsFile.replaceAll(' ', '_') } : {}) })
  }
  return result
}
export function commonsFilename(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(url.hostname)
      || url.username || url.password || url.port || url.hash
      || [...url.searchParams].some(([key, value]) => !['utm_source', 'utm_campaign', 'utm_content'].includes(key) || value.length > 200)) return null
    const match = /^\/wikipedia\/commons\/(?:thumb\/)?[a-f0-9]\/[a-f0-9]{2}\/([^/]+)(?:\/[^/]+)?$/.exec(url.pathname)
    if (!match) return null
    const filename = decodeURIComponent(match[1]).replaceAll(' ', '_')
    return filename.length <= 300 && !/[\/\\|#\x00-\x1f\x7f]/.test(filename) ? filename : null
  } catch { return null }
}
export function articleUrl(request: ImageRequest): string { return request.commonsFile ? creditUrl(request.commonsFile) : `https://${request.language}.wikipedia.org/wiki/${encodeURIComponent(request.wikipediaTitle)}` }
export function creditUrl(filename: string): string { return `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename)}` }
export function reusableLicense(value: string): boolean {
  return /^(?:CC BY(?:-SA)? (?:1\.0|2\.[05]|[34]\.0)|CC0(?: 1\.0)?|Public domain)$/.test(value)
}
export function imageDataBytes(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 40) return null
  const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match || match[1].length % 4 !== 0) return null
  const bytes = match[1].length / 4 * 3 - (match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0)
  return bytes > 0 && bytes <= MAX_IMAGE_BYTES ? bytes : null
}
/** Persisted metadata is validated independently of the model's request parameters. */
export function parseImages(value: unknown): UiImage[] | null {
  const requests = parseImageRequests(value)
  if (!requests || !Array.isArray(value)) return null
  const result: UiImage[] = []; let total = 0
  for (const [index, request] of requests.entries()) {
    const row = value[index] as Record<string, unknown>
    if (row.status === 'unavailable') {
      if (!IMAGE_CODES.includes(row.code as ImageCode) || ['dataUrl', 'imageUrl', 'articleUrl', 'creditUrl', 'creator', 'license'].some(key => row[key] !== undefined)) return null
      result.push({ ...request, status: 'unavailable', code: row.code as ImageCode }); continue
    }
    const bytes = imageDataBytes(row.dataUrl)
    const filename = commonsFilename(row.imageUrl)
    if (row.status !== 'available' || bytes === null || !filename || request.commonsFile !== undefined && filename !== request.commonsFile || row.articleUrl !== articleUrl(request) || row.creditUrl !== creditUrl(filename)
      || typeof row.creator !== 'string' || !row.creator.trim() || row.creator.length > 500
      || typeof row.license !== 'string' || !reusableLicense(row.license) || row.code !== undefined) return null
    total += bytes
    if (total > MAX_TOTAL_IMAGE_BYTES) return null
    result.push({ ...request, status: 'available', dataUrl: row.dataUrl as string, imageUrl: row.imageUrl as string,
      articleUrl: row.articleUrl as string, creditUrl: row.creditUrl as string, creator: row.creator, license: row.license })
  }
  return result
}
