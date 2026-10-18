import type { BridgeReceipt } from './protocol.ts'
import type { UiTheme, UiColors } from '../shared/theme.ts'
import type { RunStatusEvent } from '../shared/runs.ts'
import type { UiImage } from '../shared/images.ts'
import type { installImageRuntime, ImageLabels } from './image-runtime.ts'

/** Serialized into the isolated frame; all runtime dependencies must stay inside this function. */
export function installFrameRuntime(channel: string, nonce: string, streaming: boolean, chartVersion: string, initialTheme: UiTheme,
  imageInstaller: typeof installImageRuntime, initialImages: readonly UiImage[], imageLabels: ImageLabels): void {
  type Pending = { id: string; kind: 'prompt' | 'link'; value: string; sent: boolean; resolve: (value: BridgeReceipt) => void; reject: (error: Error) => void }
  let pending: Pending | null = null
  let connected = false
  let counter = 0
  let lastHeight = 0
  let scheduled = false
  let activated = !streaming
  let stopped = false
  let disposed = false
  const issues: Record<string, unknown>[] = []
  const issueKeys = new Set<string>()
  const listeners = new Set<(receipt: BridgeReceipt) => void>()
  const runListeners = new Set<(value: RunStatusEvent) => void>()
  const runs = new Map<string, RunStatusEvent>()
  const themeListeners = new Set<(theme: Readonly<UiTheme>) => void>()
  const colorKeys = Object.keys(initialTheme.colors) as (keyof UiColors)[]
  let currentTheme: Readonly<UiTheme> = initialTheme
  let themeSignature = ''
  const imageRuntime = imageInstaller(imageLabels, message => report('resource', message), schedule, url => request('link', url))
  function applyTheme(value: unknown): void {
    if (typeof value !== 'object' || value === null) return
    const t = value as UiTheme
    if (t.version !== 1 || !['light', 'dark'].includes(t.scheme) || !t.colors || typeof t.colors !== 'object'
      || Object.keys(t.colors).length !== colorKeys.length || typeof t.fontSize !== 'number'
      || !Number.isFinite(t.fontSize) || t.fontSize < 8 || t.fontSize > 48 || typeof t.fontFamily !== 'string'
      || t.fontFamily.length > 300 || !CSS.supports('font-family', t.fontFamily)) return
    for (const key of colorKeys) {
      const color = t.colors[key]
      if (typeof color !== 'string' || color.length > 200 || color.includes('var(') || !CSS.supports('color', color)) return
    }
    const signature = JSON.stringify(t)
    if (signature === themeSignature) return
    themeSignature = signature
    currentTheme = Object.freeze({ version: 1, scheme: t.scheme, fontSize: t.fontSize, fontFamily: t.fontFamily, colors: Object.freeze({ ...t.colors }) })
    const root = document.documentElement
    root.dataset.iuiTheme = t.scheme; root.style.colorScheme = t.scheme
    for (const key of colorKeys) root.style.setProperty('--iui-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), t.colors[key])
    root.style.setProperty('--iui-font-size', `${t.fontSize}px`)
    root.style.setProperty('--iui-font-family', t.fontFamily)
    document.querySelector('meta[name="iui-theme"]')?.setAttribute('content', t.scheme)
    for (const listener of themeListeners) { try { listener(currentTheme) } catch (error) { report('script', error) } }
    schedule()
  }
  type ChartApi = { version: string; instances: Record<string, { canvas: HTMLCanvasElement | null; destroy: () => void }> }
  function charts(): ChartApi | undefined { return (window as unknown as { Chart?: ChartApi }).Chart }
  function disposeCharts(orphanedOnly = false): void {
    for (const chart of Object.values(charts()?.instances ?? {})) {
      if (orphanedOnly && chart.canvas?.isConnected) continue
      try { chart.destroy() } catch (error) { report('resource', error) }
    }
  }
  function dispose(): void { window.dispatchEvent(new Event('dsh-ui-dispose')); stopped = true; disposed = true; themeListeners.clear(); runListeners.clear(); runs.clear(); imageRuntime.dispose(); disposeCharts() }
  function loadLibraries(data: Record<string, unknown>): boolean {
    const libraries = data.libraries ?? []
    if (Array.isArray(libraries) && libraries.length === 0) return true
    if (!Array.isArray(libraries) || libraries.length > 2 || new Set(libraries).size !== libraries.length || libraries.some(id => ![`chartjs-${chartVersion}`, 'leaflet-1.9.4'].includes(id))
      || typeof data.librarySource !== 'string' || data.librarySource.length > 650000 || data.libraryCss !== undefined && (typeof data.libraryCss !== 'string' || data.libraryCss.length > 30000)) {
      report('resource', 'Invalid offline chart library declaration.'); return false
    }
    const script = document.createElement('script'); script.nonce = nonce; script.textContent = data.librarySource
    const style = document.createElement('style'); style.textContent = typeof data.libraryCss === 'string' ? data.libraryCss : ''; document.head.appendChild(style)
    document.head.appendChild(script)
    if (libraries.includes(`chartjs-${chartVersion}`) && charts()?.version !== chartVersion) { report('resource', `Offline Chart.js ${chartVersion} could not be initialized.`); return false }
    if (libraries.includes('leaflet-1.9.4') && (window as any).L?.version !== '1.9.4') { report('resource', 'Offline Leaflet could not be initialized.'); return false }
    return true
  }
  function send(data: Record<string, unknown>): void { parent.postMessage({ ...data, channel }, '*') }
  function report(phase: string, value: unknown, line?: number, column?: number): void {
    const message = (value instanceof Error ? value.message : String(value)).slice(0, 2000) || 'Unknown error'
    const key = `${phase}:${message}:${line}:${column}`
    if (issueKeys.has(key) || issues.length >= 10) return
    issueKeys.add(key)
    const issue = { kind: 'runtime-error', phase, message, line, column }
    issues.push(issue); send(issue)
  }
  function measure(): void {
    scheduled = false
    if (!document.body) return
    const body = document.body
    const style = getComputedStyle(body)
    const height = Math.ceil(Math.max(body.getBoundingClientRect().height, body.scrollHeight)
      + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0))
    if (height !== lastHeight) { lastHeight = height; send({ kind: 'resize', height: Math.max(1, height) }) }
  }
  function schedule(): void {
    if (scheduled) return
    scheduled = true; requestAnimationFrame(measure)
  }
  function notify(receipt: BridgeReceipt): void {
    for (const listener of listeners) {
      try { listener(receipt) } catch (error) { report('script', error) }
    }
  }
  function dispatchPending(): void {
    if (!connected || !pending || pending.sent) return
    pending.sent = true
    send({ kind: pending.kind, value: pending.value, requestId: pending.id })
  }
  function request(kind: 'prompt' | 'link', value: string): Promise<BridgeReceipt> {
    const promise = new Promise<BridgeReceipt>((resolve, reject) => {
      if (parent === window) { reject(Object.assign(new Error('This action requires a DSH chat host.'), { code: 'HOST_UNAVAILABLE' })); return }
      if (!activated || stopped) { reject(Object.assign(new Error('The preview is inactive.'), { code: 'PREVIEW_INACTIVE' })); return }
      if (pending) { reject(Object.assign(new Error('A request is already awaiting confirmation.'), { code: 'BUSY' })); return }
      if (typeof value !== 'string' || !value.trim() || value.length > (kind === 'prompt' ? 4000 : 2048)) {
        reject(Object.assign(new Error('Invalid bridge request.'), { code: 'INVALID_REQUEST' })); return
      }
      if (kind === 'link') {
        try {
          const url = new URL(value)
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only HTTPS links without credentials are allowed.')
        } catch (error) { reject(error); return }
      }
      const id = `${channel}:${++counter}`
      pending = { id, kind, value, sent: false, resolve, reject }
      dispatchPending()
    })
    // Existing saved widgets can ignore the new Promise without producing cancellation errors.
    void promise.catch(() => {})
    return promise
  }
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.channel !== channel) return
    const data = event.data
    if (data.kind === 'dispose') { dispose(); return }
    if (data.kind === 'run-status') {
      if (disposed) return
      const value = data.value as RunStatusEvent | undefined
      if (!value || value.version !== 1 || typeof value.requestId !== 'string' || !/^[\w:-]{1,100}$/.test(value.requestId)
        || typeof value.callId !== 'string' || !value.callId || value.callId.length > 300
        || typeof value.messageId !== 'string' || !value.messageId || value.messageId.length > 300
        || (value.turn !== null && (!Number.isSafeInteger(value.turn) || value.turn < 1))
        || !['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(value.status)
        || value.modelCompleted !== (value.status === 'completed')
        || (value.code !== undefined && (typeof value.code !== 'string' || value.code.length > 100))) return
      const row: RunStatusEvent = Object.freeze({ version: 1, requestId: value.requestId, callId: value.callId,
        messageId: value.messageId, turn: value.turn, status: value.status, modelCompleted: value.modelCompleted,
        ...(value.code ? { code: value.code } : {}) })
      if (JSON.stringify(runs.get(row.requestId)) === JSON.stringify(row)) return
      runs.set(row.requestId, row)
      if (runs.size > 100) runs.delete(runs.keys().next().value!)
      for (const listener of runListeners) { try { listener(row) } catch (error) { report('script', error) } }
      return
    }
    if (data.kind === 'theme-update') { if (!disposed) applyTheme(data.theme); return }
    if (data.kind === 'document-update') {
      if (!streaming || activated || stopped || !document.body) return
      if (data.phase === 'failed') { stopped = true; document.body.inert = true; return }
      if (!['generating', 'ready'].includes(data.phase) || typeof data.html !== 'string' || typeof data.css !== 'string'
        || typeof data.javascript !== 'string' || data.html.length + data.css.length + data.javascript.length > 1200000) return
      document.body.innerHTML = data.html
      document.getElementById('dsh-generated-style')!.textContent = data.css
      if (data.phase === 'ready') {
        if (!loadLibraries(data)) { stopped = true; document.body.inert = true; return }
        // The parent sends ready only for validated, successful result metadata.
        // Lock before execution: repeated publications cannot rerun generated code.
        activated = true; document.body.inert = false
        imageRuntime.update(data.images ?? [])
        const script = document.createElement('script'); script.nonce = nonce
        script.textContent = data.javascript + '\n//# sourceURL=dsh-intelligent-ui.generated.js'
        document.body.appendChild(script)
        imageRuntime.update(data.images ?? [])
      }
      schedule(); return
    }
    if (data.kind === 'connect') {
      connected = true
      send({ kind: 'connected' }); for (const issue of issues) send(issue); lastHeight = 0; schedule(); dispatchPending(); return
    }
    if (data.kind !== 'receipt' || !pending || data.requestId !== pending.id
      || !['pending-confirmation', 'sending', 'queued', 'opened', 'cancelled', 'failed', 'unknown'].includes(data.status)) return
    const receipt: BridgeReceipt = { requestId: pending.id, status: data.status, modelCompleted: false }
    if (typeof data.code === 'string') receipt.code = data.code.slice(0, 100)
    if (typeof data.message === 'string') receipt.message = data.message.slice(0, 2000)
    const settled = pending
    if (receipt.status === 'queued' || receipt.status === 'opened' || receipt.status === 'cancelled' || receipt.status === 'failed' || receipt.status === 'unknown') pending = null
    notify(receipt)
    if (receipt.status === 'queued' || receipt.status === 'opened') settled.resolve(receipt)
    if (receipt.status === 'cancelled' || receipt.status === 'failed' || receipt.status === 'unknown')
      settled.reject(Object.assign(new Error(receipt.message ?? receipt.status), { code: receipt.code ?? receipt.status.toUpperCase(), receipt }))
  })
  window.addEventListener('error', event => {
    if (event instanceof ErrorEvent) report('script', event.message, event.lineno, event.colno)
    else report('resource', 'A generated resource could not be loaded.')
  }, true)
  window.addEventListener('unhandledrejection', event => report('promise', event.reason))
  document.addEventListener('securitypolicyviolation', event => report('policy', `Blocked by sandbox policy: ${event.violatedDirective}`))
  Object.defineProperty(window, 'dshUI', { value: Object.freeze({
    version: 3,
    sendPrompt: (text: string) => request('prompt', text),
    openLink: (url: string) => request('link', url),
    onReceipt: (listener: (receipt: BridgeReceipt) => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    getRunStatuses: () => Object.freeze([...runs.values()]),
    onRunStatus: (listener: (value: RunStatusEvent) => void) => {
      runListeners.add(listener)
      for (const row of runs.values()) { try { listener(row) } catch (error) { report('script', error) } }
      return () => { runListeners.delete(listener) }
    },
    reportError: (error: unknown) => report('script', error),
    getTheme: () => currentTheme,
    onThemeChange: (listener: (theme: Readonly<UiTheme>) => void) => { themeListeners.add(listener); return () => { themeListeners.delete(listener) } },
  }), configurable: false, writable: false })
  window.addEventListener('DOMContentLoaded', () => {
    if (!streaming) imageRuntime.update(initialImages)
    new ResizeObserver(schedule).observe(document.body)
    new MutationObserver(() => { disposeCharts(true); schedule() }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true })
    document.fonts.ready.then(schedule).catch(error => report('resource', error))
    schedule()
  }, { once: true })
  window.addEventListener('resize', schedule)
  window.addEventListener('pagehide', dispose)
  window.addEventListener('unload', dispose)
  window.addEventListener('load', () => { send({ kind: 'ready' }); schedule() }, { once: true })
  applyTheme(initialTheme)
}
