import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { query, resolveImage, plainMetadata, type ImagePolicy } from './images.ts'
import { commonsFilename, reusableLicense, type ImageRequest, type UiImage } from '../shared/images.ts'
export interface Place { title: string; language: 'zh' | 'en'; latitude: number; longitude: number; source: string; englishTitle?: string }
export async function resolvePlace(title: string, language: 'zh' | 'en', policy: ImagePolicy, parentSignal: AbortSignal): Promise<Place> {
  if (!title.trim() || title.length > 160 || /[|#\x00-\x1f]/.test(title) || /^https?:/i.test(title)) throw new Error('Invalid place title')
  const signal = AbortSignal.any([parentSignal, AbortSignal.timeout(policy.timeoutMs)])
  const other = language === 'zh' ? 'en' : 'zh'
  const read = async (name: string, lang: 'zh' | 'en') => {
    const data = await query(`${lang}.wikipedia.org`, { titles: name, redirects: '1', converttitles: '1', prop: 'coordinates|pageprops|langlinks', coprimary: 'primary', colimit: '1', lllang: lang === 'zh' ? 'en' : 'zh', lllimit: '1' }, signal, undefined, policy.dispatcher) as any
    return data?.query?.pages?.[0]
  }
  const validPage = (p: any) => p?.ns === 0 && !p.missing && typeof p.title === 'string' && !!p.title.trim() && p.title.length <= 160 && p.pageprops?.disambiguation === undefined
  let p = await read(title, language), lang = language
  const hasCoordinates = (p: any) => validPage(p) && Number.isFinite(p.coordinates?.[0]?.lat) && Math.abs(p.coordinates[0].lat) <= 85 && Number.isFinite(p.coordinates[0]?.lon) && Math.abs(p.coordinates[0].lon) <= 180
  if (!hasCoordinates(p)) {
    // Follow an explicit interlanguage identity, never a fuzzy search result.
    // A Latin title paired with zh is also a common model argument mismatch.
    const linked = validPage(p) ? p.langlinks?.find((l: any) => l.lang === other)?.title : undefined
    const fallback = typeof linked === 'string' && linked.trim() && linked.length <= 160 ? linked
      : language === 'zh' && p?.missing && /^[A-Za-z][A-Za-z0-9 '\-(),.]{0,159}$/.test(title) ? title : undefined
    if (fallback) { p = await read(fallback, other); lang = other }
  }
  if (!hasCoordinates(p)) throw new Error(`无法确定“${title}”的坐标，请提供更具体的地点名称或百科条目。`)
  const c = p.coordinates[0], candidate = lang === 'en' ? p.title : p.langlinks?.find((l: any) => l.lang === 'en')?.title
  return { title: p.title, language: lang, latitude: c.lat, longitude: c.lon, source: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`, ...(typeof candidate === 'string' && candidate.trim() && candidate.length <= 160 ? { englishTitle: candidate } : {}) }
}
export async function resolvePlacePhoto(id: string, name: string, place: Place | undefined, title: string, language: 'zh' | 'en', policy: ImagePolicy, attachments: AttachmentStore | undefined, signal: AbortSignal): Promise<UiImage> {
  const english = place?.englishTitle
  const request: ImageRequest = { id, wikipediaTitle: english ?? place?.title ?? title, language: english ? 'en' : place?.language ?? language, alt: name }
  let image = await resolveImage(request, policy, attachments, signal)
  if (image.status === 'available' || !policy.enabled || !attachments || !['NO_IMAGE', 'IMAGE_TOO_LARGE', 'ATTRIBUTION_UNAVAILABLE'].includes(image.code ?? '')) return image
  // Search only the resolved subject. Never substitute a different itinerary stop.
  try {
    const data = await query('commons.wikimedia.org', { generator: 'search', gsrsearch: request.wikipediaTitle, gsrnamespace: '6', gsrlimit: '4', prop: 'imageinfo', iiprop: 'url|extmetadata' }, AbortSignal.any([signal, AbortSignal.timeout(policy.timeoutMs)]), undefined, policy.dispatcher) as any
    for (const page of data?.query?.pages ?? []) {
      const info = page?.imageinfo?.[0], file = commonsFilename(info?.url)
      if (!file || !/\.(jpg|jpeg|png|webp)$/i.test(file) || !plainMetadata(info?.extmetadata?.Artist) || !reusableLicense(plainMetadata(info?.extmetadata?.LicenseShortName))) continue
      const next = await resolveImage({ ...request, commonsFile: file }, policy, attachments, signal)
      if (next.status === 'available') return next
    }
  } catch { signal.throwIfAborted() }
  return image
}
