import { parseLibraries, type UiLibrary } from './libraries.ts'
import { parseImages, type UiImage } from './images.ts'
export const TOOL_NAME = 'render_intelligent_ui'
export const DOCUMENT_VERSION = 1

export interface UiDocument {
  version: 1 | 2 | 3
  /** Required and non-empty for v2, optional in v3; v1 has no library declaration. */
  libraries?: UiLibrary[]
  /** v3 includes bounded, attributed article images; older versions have none. */
  images?: UiImage[]
  title: string
  description: string
  html: string
  css: string
  javascript: string
  height: number
}

/** Validate persisted or model-generated input at its JSON boundary. */
export function parseDocument(value: unknown): UiDocument | null {
  if (typeof value !== 'object' || value === null) return null
  const d = value as Record<string, unknown>
  if ((d.version !== DOCUMENT_VERSION && d.version !== 2 && d.version !== 3) || typeof d.title !== 'string' || !d.title.trim()
    || typeof d.description !== 'string' || typeof d.html !== 'string'
    || typeof d.css !== 'string' || typeof d.javascript !== 'string'
    || typeof d.height !== 'number' || !Number.isFinite(d.height)
    || d.height < 180 || d.height > 900) return null
  if (d.title.length > 200 || d.description.length > 2000
    || d.html.length + d.css.length + d.javascript.length > 200000) return null
  const libraries = d.version === 2 || d.version === 3 && d.libraries !== undefined ? parseLibraries(d.libraries) : undefined
  if (d.version === 2 ? !libraries?.length : d.version === 1 ? d.libraries !== undefined : d.libraries !== undefined && !libraries?.length) return null
  const images = d.version === 3 ? parseImages(d.images) : undefined
  if (d.version === 3 ? !images : d.images !== undefined) return null
  return { version: d.version, title: d.title, description: d.description, html: d.html,
    css: d.css, javascript: d.javascript, height: d.height, ...(libraries ? { libraries } : {}), ...(images ? { images } : {}) }
}

export function documentFromMeta(meta: unknown): UiDocument | null {
  if (typeof meta !== 'object' || meta === null) return null
  return parseDocument((meta as Record<string, unknown>).intelligentUi)
}
