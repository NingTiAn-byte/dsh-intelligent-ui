/** Separate from the v2 queue-acceptance receipts. Reconstructed from DSH's log. */
export const RUN_KEY = 'intelligentUiRuns'
export const MAX_RUN_RECORDS = 100
export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown'
export interface RunStatusEvent {
  version: 1
  requestId: string
  callId: string
  status: RunStatus
  modelCompleted: boolean
  messageId: string
  turn: number | null
  code?: string
}
export interface RunSnapshot { version: 1; runs: readonly RunStatusEvent[] }
const prefix = 'iui-run-v1:'
export function runRpcId(callId: string, requestId: string): string {
  if (!callId || callId.length > 300 || !/^[\w:-]{1,100}$/.test(requestId)) throw new Error('Invalid follow-up identity')
  return prefix + encodeURIComponent(JSON.stringify([callId, requestId]))
}
export function parseRunRpcId(value: unknown): { callId: string; requestId: string } | null {
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.length > 4000) return null
  try {
    const pair: unknown = JSON.parse(decodeURIComponent(value.slice(prefix.length)))
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
      || runRpcId(pair[0], pair[1]) !== value) return null
    return { callId: pair[0], requestId: pair[1] }
  } catch { return null }
}
export function parseRunStatus(value: unknown): RunStatusEvent | null {
  if (!value || typeof value !== 'object') return null
  const row = value as RunStatusEvent
  if (row.version !== 1 || !['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown'].includes(row.status)
    || typeof row.callId !== 'string' || !row.callId || row.callId.length > 300
    || typeof row.requestId !== 'string' || !/^[\w:-]{1,100}$/.test(row.requestId)
    || typeof row.messageId !== 'string' || !row.messageId || row.messageId.length > 300
    || (row.turn !== null && (!Number.isSafeInteger(row.turn) || row.turn < 1))
    || row.modelCompleted !== (row.status === 'completed')
    || (row.code !== undefined && (typeof row.code !== 'string' || row.code.length > 100))) return null
  return { version: 1, callId: row.callId, requestId: row.requestId, messageId: row.messageId,
    turn: row.turn, status: row.status, modelCompleted: row.modelCompleted, ...(row.code ? { code: row.code } : {}) }
}
