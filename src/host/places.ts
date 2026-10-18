import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { query, resolveImage, plainMetadata, type ImagePolicy } from './images.ts'
import { commonsFilename, reusableLicense, type ImageRequest, type UiImage } from '../shared/images.ts'
export interface Place { title: string; language: 'zh' | 'en'; latitude: number; longitude: number; source: string; englishTitle?: string }
export async function resolvePlace(title: string, language: 'zh' | 'en', policy: ImagePolicy, parentSignal: AbortSignal): Promise<Place> {
  if (!title.trim() || title.length > 160 || /[|#\x00-\x1f]/.test(title) || /^https?:/i.test(title)) throw new Error('Invalid place title')
  const data = await query(`${language}.wikipedia.org`, { titles: title, redirects: '1', converttitles: '1', prop: 'coordinates|pageprops|langlinks', coprimary: 'primary', colimit: '1', lllang: 'en', lllimit: '1' }, AbortSignal.any([parentSignal, AbortSignal.timeout(policy.timeoutMs)]), undefined, policy.dispatcher) as any
  const p = data?.query?.pages?.[0], c = p?.coordinates?.[0]
  if (p?.ns !== 0 || p?.missing || typeof p.title !== 'string' || !p.title.trim() || p.title.length > 160 || p?.pageprops?.disambiguation !== undefined || !Number.isFinite(c?.lat) || Math.abs(c.lat) > 85 || !Number.isFinite(c?.lon) || Math.abs(c.lon) > 180) throw new Error(`无法确定“${title}”的坐标，请提供更具体的地点名称或百科条目。`)
  const candidate = language === 'en' ? p.title : p.langlinks?.find((l: any) => l.lang === 'en')?.title
  return { title: p.title, language, latitude: c.lat, longitude: c.lon, source: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(p.title)}`, ...(typeof candidate === 'string' && candidate.trim() && candidate.length <= 160 ? { englishTitle: candidate } : {}) }
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
