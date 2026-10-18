import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { DEFAULT_THEME, themeVariables, WIDGET_STYLES, type UiTheme } from '../shared/theme.ts'
import type { UiDocument } from '../shared/document.ts'
import { buildSandboxDocument, sanitizeMarkup } from './sandbox.ts'
import type { UiPhase } from './stream-results.ts'
import { libraryPayload } from './chart-library.ts'
import { parseFrameMessage, MAX_RUNTIME_ISSUES, type BridgeRequest, type BridgeReceipt, type RuntimeIssue, type ReceiptStatus } from './protocol.ts'
import type { CopyKey } from './copy.ts'
import { MAX_RUN_RECORDS, parseRunStatus, type RunSnapshot, type RunStatus, type RunStatusEvent } from '../shared/runs.ts'
import { imageLabels } from './image-runtime.ts'

export interface WidgetProps {
  document: UiDocument
  phase?: UiPhase
  callId?: string
  theme?: UiTheme
  /** Resolves when DSH accepts the queued prompt, not when a model finishes. */
  sendPrompt: (text: string, requestId: string) => Promise<void>
  runSnapshot?: RunSnapshot
  t: (key: CopyKey, params?: Record<string, string>) => string
  setTheme?: (theme: 'light' | 'dark' | 'system') => void
}
interface Mount { channel: string; target: Window; closed: boolean; receipts: Map<string, BridgeReceipt> }
const receiptKeys: Record<ReceiptStatus, CopyKey> = {
  'pending-confirmation': 'receiptPending', sending: 'sending', queued: 'receiptQueued',
  opened: 'receiptOpened', cancelled: 'receiptCancelled', failed: 'receiptFailed', unknown: 'receiptUnknown',
}
const phaseKeys: Record<RuntimeIssue['phase'], CopyKey> = { script: 'scriptError', promise: 'promiseError', resource: 'resourceError', policy: 'policyError' }
const runKeys: Record<RunStatus, CopyKey> = { queued: 'runQueued', running: 'runRunning', completed: 'runCompleted',
  failed: 'runFailed', cancelled: 'runCancelled', unknown: 'runUnknown' }
export const RUN_OBSERVATION_TIMEOUT_MS = 300000

/** Documents replay; transient values reset only on reset/remount, not resize or receipts. */
export function Widget({ document: doc, phase = 'ready', callId, theme = DEFAULT_THEME, sendPrompt, runSnapshot, setTheme, t }: WidgetProps) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [generation, setGeneration] = useState(0)
  const [request, setRequest] = useState<BridgeRequest | null>(null)
  const pending = useRef<BridgeRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const sending = useRef(false)
  const [height, setHeight] = useState(doc.height)
  const [ready, setReady] = useState(false)
  const [issues, setIssues] = useState<RuntimeIssue[]>([])
  const [receipt, setReceipt] = useState<BridgeReceipt | null>(null)
  const [accepted, setAccepted] = useState<string[]>([])
  const [stale, setStale] = useState(false)
  const runs = useMemo(() => runSnapshot?.version === 1 && Array.isArray(runSnapshot.runs)
    ? runSnapshot.runs.map(parseRunStatus).filter((row): row is RunStatusEvent => row !== null && row.callId === callId).slice(-MAX_RUN_RECORDS) : [], [runSnapshot, callId])
  const active = useRef<Mount | null>(null)
  const currentPhase = useRef(phase)
  currentPhase.current = phase
  const channel = useMemo(() => crypto.randomUUID(), [generation])
  // A call owns one iframe for its whole lifecycle. Only explicit reset replaces it.
  const source = useMemo(() => buildSandboxDocument(doc, channel, phase !== 'ready', theme, imageLabels(t)), [channel])
  function reply(mount: Mount, row: BridgeReceipt): void {
    mount.receipts.set(row.requestId, row)
    if (mount.receipts.size > 100) mount.receipts.delete(mount.receipts.keys().next().value!)
    mount.target.postMessage({ ...row, channel: mount.channel, kind: 'receipt' }, '*')
  }
  useEffect(() => {
    const target = frame.current?.contentWindow
    if (!target) return
    const mount: Mount = { channel, target, closed: false, receipts: new Map() }
    active.current = mount
    pending.current = null; sending.current = false
    setRequest(null); setBusy(false); setHeight(doc.height); setReady(false); setIssues([]); setReceipt(null)
    setAccepted([])
    const listener = (event: MessageEvent) => {
      const message = parseFrameMessage(event, target, channel)
      if (!message) return
      if (message.kind === 'resize') { setHeight(previous => previous === message.height ? previous : message.height); return }
      if (message.kind === 'ready') { target.postMessage({ channel, kind: 'connect' }, '*'); return }
      if (message.kind === 'connected') { setReady(true); return }
      if (message.kind === 'runtime-error') {
        setIssues(previous => previous.length >= MAX_RUNTIME_ISSUES || previous.some(issue => JSON.stringify(issue) === JSON.stringify(message.issue))
          ? previous : [...previous, message.issue]); return
      }
      if (currentPhase.current !== 'ready') return
      const known = mount.receipts.get(message.requestId)
      if (known) { reply(mount, known); return }
      if (pending.current || sending.current) {
        reply(mount, { requestId: message.requestId, status: 'failed', code: 'BUSY', message: t('requestBusy'), modelCompleted: false }); return
      }
      pending.current = message; setRequest(message)
      const row: BridgeReceipt = { requestId: message.requestId, status: 'pending-confirmation', modelCompleted: false }
      reply(mount, row); setReceipt(row)
    }
    window.addEventListener('message', listener)
    target.postMessage({ channel, kind: 'connect' }, '*')
    return () => {
      mount.closed = true
      window.removeEventListener('message', listener)
      target.postMessage({ channel, kind: 'dispose' }, '*')
      if (pending.current) reply(mount, { requestId: pending.current.requestId, status: sending.current ? 'unknown' : 'cancelled', code: sending.current ? 'OUTCOME_UNKNOWN' : 'UNMOUNTED', message: t('requestUnmounted'), modelCompleted: false })
      pending.current = null
      if (active.current === mount) active.current = null
    }
  }, [channel])
  useEffect(() => {
    if (!ready) return
    frame.current?.contentWindow?.postMessage({
      channel, kind: 'document-update', phase,
      html: phase === 'failed' ? '' : sanitizeMarkup(doc.html),
      css: doc.css, javascript: phase === 'ready' ? doc.javascript : '',
      images: phase === 'ready' ? doc.images ?? [] : [],
      ...(phase === 'ready' ? libraryPayload(doc) : {}),
    }, '*')
  }, [channel, ready, doc, phase])
  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage({ channel, kind: 'theme-update', theme }, '*')
  }, [channel, ready, theme])
  useEffect(() => {
    setStale(false)
    if (!runs.some(row => row.status === 'queued' || row.status === 'running')) return
    // Observation timeout is not model cancellation or failure. A later authoritative update recovers it.
    const timer = setTimeout(() => setStale(true), RUN_OBSERVATION_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [runs])
  useEffect(() => {
    if (!ready) return
    for (const row of runs) {
      const value: RunStatusEvent = stale && ['queued', 'running'].includes(row.status)
        ? { ...row, status: 'unknown', modelCompleted: false, code: 'OBSERVATION_TIMEOUT' } : row
      frame.current?.contentWindow?.postMessage({ channel, kind: 'run-status', value }, '*')
    }
  }, [channel, ready, runs, stale])
  function cancel(): void {
    const mount = active.current; const current = pending.current
    if (!mount || !current || sending.current) return
    const row: BridgeReceipt = { requestId: current.requestId, status: 'cancelled', code: 'CANCELLED', message: t('receiptCancelled'), modelCompleted: false }
    reply(mount, row); setReceipt(row); pending.current = null; setRequest(null)
  }
  function reset(): void { cancel(); setGeneration(value => value + 1) }
  async function confirm(): Promise<void> {
    const mount = active.current; const current = pending.current
    if (!mount || !current || sending.current) return
    sending.current = true; setBusy(true)
    const working: BridgeReceipt = { requestId: current.requestId, status: 'sending', modelCompleted: false }
    reply(mount, working); setReceipt(working)
    try {
      if (current.kind === 'link') window.open(current.value, '_blank', 'noopener,noreferrer')
      else await sendPrompt(current.value, current.requestId)
      if (mount.closed) return
      const row: BridgeReceipt = { requestId: current.requestId, status: current.kind === 'prompt' ? 'queued' : 'opened', modelCompleted: false }
      reply(mount, row); setReceipt(row)
      if (current.kind === 'prompt') setAccepted(previous => [...previous, current.requestId].slice(-MAX_RUN_RECORDS))
    } catch (failure) {
      if (mount.closed) return
      const message = (failure instanceof Error ? failure.message : String(failure)).slice(0, 2000)
      const row: BridgeReceipt = { requestId: current.requestId, status: 'failed', code: 'SEND_FAILED', message, modelCompleted: false }
      reply(mount, row); setReceipt(row)
    } finally {
      if (!mount.closed) { pending.current = null; setRequest(null); sending.current = false; setBusy(false) }
    }
  }
  function download(): void {
    const url = URL.createObjectURL(new Blob([buildSandboxDocument(doc, crypto.randomUUID(), false, theme, imageLabels(t))], { type: 'text/html' }))
    const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = 'intelligent-ui.html'; anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const contentHeading = /<h[1-3](?:\s|>)/i.test(doc.html)
  return <section data-intelligent-ui-widget data-intelligent-ui-call={callId} data-ui-theme={theme.scheme} aria-label={doc.title} style={{ ...themeVariables(theme), colorScheme: theme.scheme } as CSSProperties}>
    <style>{WIDGET_STYLES}</style>
    <header className="iui-widget-toolbar">
      <strong className="iui-widget-title" data-generic={contentHeading}>{contentHeading ? t('ready') : doc.title}</strong>
      <div className="iui-widget-actions">
      <button type="button" disabled={busy || phase !== 'ready'} onClick={reset}>{t('reload')}</button>
      <button type="button" disabled={phase !== 'ready'} title={t('exportTheme')} onClick={download}>{t('export')}</button>
      {setTheme ? <label className="iui-widget-theme">{t('themeControl')} <select aria-label={t('themeControl')} value="" onChange={e => { if (e.target.value) setTheme(e.target.value as 'light' | 'dark' | 'system') }}><option value="">{t('themeSelect')}</option><option value="light">{t('themeLight')}</option><option value="dark">{t('themeDark')}</option><option value="system">{t('themeSystem')}</option></select></label> : null}
      </div>
    </header>
    {doc.description && <details className="iui-widget-description"><summary>{t('widgetDetails')}</summary><p>{doc.description}</p></details>}
    <p className="iui-runtime" data-settled={phase === 'ready' && ready && !issues.length} role={phase === 'failed' ? 'alert' : 'status'} data-ui-phase={phase} data-runtime-status>{t(phase === 'generating' ? 'streamGenerating' : phase === 'failed' ? 'streamFailed' : issues.length ? 'runtimeFailed' : ready ? 'runtimeReady' : 'runtimeLoading')}</p>
    <iframe key={channel} ref={frame} title={doc.title} srcDoc={source} sandbox="allow-scripts" referrerPolicy="no-referrer"
      onLoad={() => frame.current?.contentWindow?.postMessage({ channel, kind: 'connect' }, '*')}
      style={{ width: '100%', height, border: 0, display: 'block' }} />
    {issues.length > 0 && <div role="alert" data-runtime-errors style={{ padding: 12 }}>
      <strong>{t('runtimeFailed')}</strong><ul>{issues.map((issue, index) => <li key={index}>
        {t(phaseKeys[issue.phase])}: {issue.message}{issue.line ? ` (${issue.line}:${issue.column ?? 0})` : ''}
      </li>)}</ul><p>{t('runtimeRecovery')}</p>
    </div>}
    {phase === 'ready' && doc.images?.length ? <aside data-image-sources><details><summary>{t('imageHeading')} · {doc.images.length}</summary>
      {doc.images.map(image => <p key={image.id}>
        {image.wikipediaTitle}：{image.status === 'available' ? <>
          {image.creator} · {image.license} · <a href={image.creditUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('imageCredit')}</a>{' '}
          <a href={image.articleUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('imageArticle')}</a>
        </> : <>{t('imageUnavailable')}</>}
      </p>)}
    </details></aside> : null}
    {request && <aside style={{ padding: 12 }}>
      <p>{t('pending')}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{request.value}</pre>
      <button type="button" disabled={busy} onClick={() => { void confirm() }}>{busy ? t('sending') : t(request.kind === 'prompt' ? 'send' : 'open')}</button>{' '}
      <button type="button" disabled={busy} onClick={cancel}>{t('dismiss')}</button>
    </aside>}
    {receipt && <p role={receipt.status === 'failed' ? 'alert' : 'status'} data-bridge-receipt={receipt.status} style={{ padding: 12 }}>
      {t(receiptKeys[receipt.status])}{receipt.message && receipt.status === 'failed' ? `: ${receipt.message}` : ''}
    </p>}
    {(runs.length > 0 || accepted.length > 0) && <aside data-model-runs style={{ padding: 12 }} aria-label={t('runHeading')}>
      <strong>{t('runHeading')}</strong>
      {runs.map((row, index) => {
        const status = stale && ['queued', 'running'].includes(row.status) ? 'unknown' : row.status
        return <p key={row.requestId} role={status === 'failed' ? 'alert' : 'status'} data-model-run={status} data-run-request={row.requestId}>
          {t('runItem')} {index + 1}：{t(runKeys[status])}{row.code ? ` (${row.code})` : ''}
        </p>
      })}
      {accepted.some(id => !runs.some(row => row.requestId === id)) && <p role="status" data-model-run="unknown">{t('runUnavailable')}</p>}
    </aside>}
  </section>
}
