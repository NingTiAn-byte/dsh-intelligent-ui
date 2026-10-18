import type { UiImage } from '../shared/images.ts'
import type { CopyKey } from './copy.ts'
export interface ImageLabels { heading: string; unavailable: string; credit: string; article: string; loadFailed: string }
export function imageLabels(t: (key: CopyKey) => string): ImageLabels {
  return { heading: t('imageHeading'), unavailable: t('imageUnavailable'),
    credit: t('imageCredit'), article: t('imageArticle'), loadFailed: t('imageLoadFailed') }
}
/** Serialized into the frame. Uses only saved raster bytes, never a remote image URL. */
export function installImageRuntime(labels: ImageLabels, report: (message: string) => void, resize: () => void,
  openLink: (url: string) => Promise<unknown>) {
  let disposed = false
  let applied = false
  function link(label: string, url: string): HTMLElement {
    if (parent === window) {
      const anchor = document.createElement('a'); anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.referrerPolicy = 'no-referrer'
      anchor.textContent = label; return anchor
    }
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = 'iui-link-button'
    button.addEventListener('click', () => { void openLink(url).catch(() => { /* The host owns confirmation and visible cancellation/failure receipts. */ }) })
    return button
  }
  function update(value: unknown): void {
    if (disposed || applied || !document.body) return
    if (!Array.isArray(value) || value.length > 4) { report('Invalid saved image declaration.'); return }
    applied = true
    if (!value.length) return
    const fallback = document.createElement('section'); fallback.dataset.iuiImageGallery = ''
    const heading = document.createElement('h3'); heading.textContent = labels.heading; fallback.appendChild(heading)
    for (const item of value) {
      const row = item as UiImage
      if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(row.id) || typeof row.alt !== 'string' || row.alt.length > 300
        || typeof row.wikipediaTitle !== 'string' || row.wikipediaTitle.length > 160) { report('Invalid saved image metadata.'); continue }
      const figure = document.createElement('figure'); figure.dataset.iuiSavedImage = row.id
      const caption = document.createElement('figcaption'); caption.textContent = row.wikipediaTitle; figure.appendChild(caption)
      const note = document.createElement('p'); note.textContent = labels.unavailable; note.setAttribute('role', 'status')
      if (row.status === 'available' && typeof row.dataUrl === 'string' && row.dataUrl.length < 341400
        && /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(row.dataUrl)
        && typeof row.creditUrl === 'string' && row.creditUrl.startsWith('https://commons.wikimedia.org/wiki/File:')
        && typeof row.articleUrl === 'string' && (/^https:\/\/(en|zh)\.wikipedia\.org\/wiki\//.test(row.articleUrl) || !!row.commonsFile && row.articleUrl === row.creditUrl)
        && typeof row.creator === 'string' && row.creator.length <= 500 && typeof row.license === 'string' && row.license.length <= 100) {
        const image = document.createElement('img'); image.alt = row.alt; image.referrerPolicy = 'no-referrer'
        image.addEventListener('load', resize, { once: true })
        image.addEventListener('error', () => { if (disposed) return; image.remove(); note.hidden = false; note.textContent = labels.loadFailed; report('A saved image could not be decoded by the browser.'); resize() }, { once: true })
        image.src = row.dataUrl; figure.prepend(image)
        const credit = document.createElement('p'); credit.textContent = `${row.creator} · ${row.license}`
        figure.append(credit, link(labels.credit, row.creditUrl), document.createTextNode(' '), link(labels.article, row.articleUrl))
        note.hidden = true; note.textContent = ''
      }
      figure.appendChild(note)
      const placeholder = document.querySelector(`[data-iui-image="${row.id}"]`)
      if (placeholder) placeholder.replaceWith(figure)
      else fallback.appendChild(figure)
    }
    if (fallback.querySelector('figure')) document.body.appendChild(fallback)
    resize()
  }
  return { update, dispose: () => { disposed = true } }
}
