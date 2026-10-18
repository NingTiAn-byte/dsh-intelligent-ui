/** Versioned messages stay private to one iframe mount and its parent. */
export const MIN_FRAME_HEIGHT = 180
export const MAX_FRAME_HEIGHT = 4000
export const MAX_RUNTIME_ISSUES = 10
export type ReceiptStatus = 'pending-confirmation' | 'sending' | 'queued' | 'opened' | 'cancelled' | 'failed' | 'unknown'
export interface BridgeReceipt { requestId: string; status: ReceiptStatus; code?: string; message?: string; modelCompleted: false }
export interface BridgeRequest { kind: 'prompt' | 'link'; requestId: string; value: string }
export interface RuntimeIssue { phase: 'script' | 'promise' | 'resource' | 'policy'; message: string; line?: number; column?: number }
export type FrameMessage = BridgeRequest | { kind: 'resize'; height: number } | { kind: 'ready' } | { kind: 'connected' } | { kind: 'runtime-error'; issue: RuntimeIssue }

/** Validate data from generated code; never accept another frame or a previous mount. */
export function parseFrameMessage(event: Pick<MessageEvent, 'source' | 'data'>, source: Window | null, channel: string): FrameMessage | null {
  if (!source || event.source !== source || typeof event.data !== 'object' || event.data === null) return null
  const d = event.data as Record<string, unknown>
  if (d.channel !== channel) return null
  if (d.kind === 'ready' || d.kind === 'connected') return { kind: d.kind }
  if (d.kind === 'resize' && typeof d.height === 'number' && Number.isFinite(d.height) && d.height > 0)
    return { kind: 'resize', height: Math.max(MIN_FRAME_HEIGHT, Math.min(MAX_FRAME_HEIGHT, Math.ceil(d.height))) }
  if (d.kind === 'runtime-error' && typeof d.phase === 'string' && ['script', 'promise', 'resource', 'policy'].includes(d.phase)
    && typeof d.message === 'string' && d.message.length > 0 && d.message.length <= 2000) {
    const issue: RuntimeIssue = { phase: d.phase as RuntimeIssue['phase'], message: d.message }
    if (typeof d.line === 'number' && Number.isSafeInteger(d.line) && d.line > 0) issue.line = d.line
    if (typeof d.column === 'number' && Number.isSafeInteger(d.column) && d.column > 0) issue.column = d.column
    return { kind: 'runtime-error', issue }
  }
  if (typeof d.requestId !== 'string' || !/^[\w:-]{1,100}$/.test(d.requestId) || typeof d.value !== 'string') return null
  if (d.kind === 'prompt' && d.value.trim() && d.value.length <= 4000)
    return { kind: 'prompt', requestId: d.requestId, value: d.value.trim() }
  if (d.kind === 'link' && d.value.length <= 2048) {
    try {
      const url = new URL(d.value)
      if (url.protocol === 'https:' && !url.username && !url.password)
        return { kind: 'link', requestId: d.requestId, value: url.href }
    } catch (_error) { /* Malformed URLs never reach the host action. */ }
  }
  return null
}
