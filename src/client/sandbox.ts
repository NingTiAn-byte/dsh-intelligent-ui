import type { UiDocument } from '../shared/document.ts'
import { installFrameRuntime } from './frame-runtime.ts'
import { parseFrameMessage } from './protocol.ts'
import { libraryPayload, CHART_NOTICES } from './chart-library.ts'
import { CHART_VERSION } from '../shared/libraries.ts'
import { DEFAULT_THEME, TEMPLATE_STYLES, type UiTheme } from '../shared/theme.ts'
import { installImageRuntime, imageLabels, type ImageLabels } from './image-runtime.ts'
import { en } from './copy.ts'
export type { BridgeRequest } from './protocol.ts'

const escapeHtml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')

/** Accept only messages from this exact iframe and this mount's random channel. */
export function parseBridgeMessage(event: Pick<MessageEvent, 'source' | 'data'>, source: Window | null, channel: string) {
  const message = parseFrameMessage(event, source, channel)
  return message?.kind === 'prompt' || message?.kind === 'link' ? message : null
}

/** Opaque-origin iframe; no same-origin, network, popup or top-navigation permission. */
export function sanitizeMarkup(html: string): string {
  const template = globalThis.document.createElement('template')
  template.innerHTML = html
  template.content.querySelectorAll('script,iframe,object,embed,base,meta,link,form').forEach(node => node.remove())
  template.content.querySelectorAll('*').forEach(node => {
    for (const attr of [...node.attributes]) {
      if (attr.name.toLowerCase().startsWith('on') || ['srcdoc', 'nonce', 'href', 'action', 'formaction', 'target', 'download', 'src', 'srcset', 'xlink:href'].includes(attr.name.toLowerCase())) node.removeAttribute(attr.name)
    }
  })
  return template.innerHTML
}
export function buildSandboxDocument(document: UiDocument, channel: string, streaming = false, theme: UiTheme = DEFAULT_THEME, labels: ImageLabels = imageLabels(key => en[key])): string {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  // Streaming calls do not yet have their final library declarations. Only these two
  // public tile origins can ever be used; scripts, API requests and other images stay blocked.
  const map = streaming || document.libraries?.includes('leaflet-1.9.4')
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:${map ? ' https://gibs.earthdata.nasa.gov https://basemap.nationalmap.gov' : ''}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
  // Tokenize markup so scripts/event attributes from HTML cannot bypass the explicit code field.
  // The iframe still remains the security boundary; this filter is not a general HTML sanitizer.
  const html = sanitizeMarkup(document.html)
  const bootstrap = `(${installFrameRuntime.toString()})(${JSON.stringify(channel)},${JSON.stringify(nonce)},${streaming},${JSON.stringify(CHART_VERSION)},${JSON.stringify(theme).replaceAll('<', '\\u003c')},${installImageRuntime.toString()},${JSON.stringify(streaming ? [] : document.images ?? []).replaceAll('<', '\\u003c')},${JSON.stringify(labels).replaceAll('<', '\\u003c')});`
  const libraries = libraryPayload(document)
  const chart = libraries.libraries.includes('chartjs-4.5.1')
  const notice = libraries.libraries.length && !streaming ? `<!--\n${CHART_NOTICES.replaceAll('--', '—')}\n-->` : ''
  const libraryTag = libraries.libraries.length && !streaming ? `<style>${libraries.libraryCss}</style><script nonce="${nonce}">${libraries.librarySource.replace(/<\/script/gi, '<\\/script')}</script>` : ''
  const safeJs = (document.javascript + '\n//# sourceURL=dsh-intelligent-ui.generated.js').replace(/<\/script/gi, '<\\/script')
  const guardedJs = chart ? `if(window.Chart?.version === ${JSON.stringify(CHART_VERSION)}){\n${safeJs}\n}else{document.body.inert=true;window.dshUI.reportError(new Error('Offline Chart.js ${CHART_VERSION} could not be initialized.'));}` : safeJs
  // Separate scripts let the bootstrap report syntax errors in the generated code.
  return `<!doctype html>${notice}<html data-iui-theme="${theme.scheme}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="iui-theme" content="${theme.scheme}"><title>${escapeHtml(document.title)}</title><script nonce="${nonce}">${bootstrap}</script><style>${TEMPLATE_STYLES}</style><style id="dsh-generated-style">${streaming ? '' : document.css.replace(/<\/style/gi, '<\\/style')}</style></head><body${streaming ? ' inert' : ''}>${streaming ? '' : html}${libraryTag}${streaming ? '' : `<script nonce="${nonce}">${guardedJs}</script>`}</body></html>`
}
