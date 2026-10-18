import type {} from '@deepseek-ai/dsh-agent/types'
import type {} from '@deepseek-ai/dsh-session-controller/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { RUN_KEY, MAX_RUN_RECORDS, parseRunRpcId, type RunSnapshot, type RunStatusEvent } from '../shared/runs.ts'

interface PendingMessage { id: string; rpcId: string | null }
interface Record extends RunStatusEvent { admitted: boolean }
export interface RunsState {
  queues: { 'next-turn': PendingMessage[]; 'next-step': PendingMessage[] }
  openTurn: number | null
  stepped: boolean
  runs: Record[]
}
const rowSchema = z.object({ version: z.literal(1), requestId: z.string(), callId: z.string(), messageId: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled', 'unknown']), modelCompleted: z.boolean(),
  turn: z.number().nullable(), code: z.string().optional() })
const pendingSchema = z.object({ id: z.string(), rpcId: z.string().nullable() })
const stateSchema: z.ZodType<RunsState> = z.object({
  queues: z.object({ 'next-turn': z.array(pendingSchema), 'next-step': z.array(pendingSchema) }),
  openTurn: z.number().nullable(), stepped: z.boolean(), runs: z.array(rowSchema.extend({ admitted: z.boolean() })).max(MAX_RUN_RECORDS),
})
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { intelligentUiRuns: RunsState }
  interface SessionProjectionMap { intelligentUiRuns: RunSnapshot }
}
function identity(message: UserMessage): PendingMessage {
  const source = message.source
  return { id: message.id, rpcId: source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string' ? source.rpcId : null }
}
function track(state: RunsState, message: PendingMessage): Record | undefined {
  const owner = parseRunRpcId(message.rpcId)
  if (!owner) return undefined
  let row = state.runs.find(row => row.messageId === message.id)
  if (!row) {
    row = { version: 1, ...owner, messageId: message.id, status: 'queued', modelCompleted: false, turn: null, admitted: false }
    state.runs.push(row)
    // Keep active records preferentially. An evicted record is never recreated by a turn ending.
    if (state.runs.length > MAX_RUN_RECORDS) {
      const terminal = state.runs.findIndex(row => !['queued', 'running'].includes(row.status))
      state.runs.splice(terminal < 0 ? 0 : terminal, 1)
    }
  }
  return row
}
/** All correlation comes from committed splices, admitted message IDs and their exact turn. */
export const runsProjection = {
  key: RUN_KEY, stateVersion: 1, stateSchema,
  init: () => ({ queues: { 'next-turn': [], 'next-step': [] }, openTurn: null, stepped: false, runs: [] }),
  apply: (previous, event) => {
    if (!['agent/inbox/spliced', 'turn/start', 'step/start', 'user/message', 'turn/end'].includes(event.type)) return previous
    const state: RunsState = { ...previous, queues: { ...previous.queues }, runs: previous.runs.map(row => ({ ...row })) }
    switch (event.type) {
      case 'agent/inbox/spliced': {
        const { target, start, removedCount = 0, inserted, outcome } = event.data
        const queue = [...state.queues[target]]
        const incoming = inserted.map(identity)
        const removed = queue.splice(start, removedCount, ...incoming)
        state.queues[target] = queue
        for (const message of removed) {
          if (incoming.some(other => other.id === message.id)) continue // Queue edits retain the same occurrence.
          const row = state.runs.find(row => row.messageId === message.id)
          if (!row || !['queued', 'running'].includes(row.status)) continue
          if (outcome === 'canceled') { row.status = 'cancelled'; row.code = 'QUEUE_REMOVED' }
          else if (state.openTurn !== null) { row.status = 'running'; row.turn = state.openTurn }
          else { row.status = 'unknown'; row.code = 'CLAIM_WITHOUT_TURN' }
        }
        for (const message of incoming) {
          const row = track(state, message)
          // Queue steering removes then reinserts the same identity; the insertion proves it remains pending.
          if (row && (row.status === 'queued' || row.code === 'QUEUE_REMOVED')) {
            row.status = 'queued'; row.turn = null; delete row.code
          }
        }
        break
      }
      case 'turn/start': state.openTurn = event.data.turn; state.stepped = false; break
      case 'step/start': if (state.openTurn === event.data.turn) state.stepped = true; break
      case 'user/message': {
        const row = track(state, identity(event.data))
        if (row && state.openTurn !== null && ['queued', 'running'].includes(row.status)) {
          row.status = 'running'; row.turn = state.openTurn; row.admitted = true
        }
        break
      }
      case 'turn/end': {
        const { turn, reason } = event.data
        for (const row of state.runs) {
          if (row.turn !== turn || row.status !== 'running') continue
          switch (reason.kind) {
            case 'completed':
              row.status = row.admitted && state.openTurn === turn && state.stepped ? 'completed' : 'unknown'
              if (row.status === 'unknown') row.code = 'INPUT_NOT_ADMITTED'
              break
            case 'aborted': row.status = 'cancelled'; row.code = 'RUN_CANCELLED'; break
            case 'error': row.status = 'failed'; row.code = 'RUN_ERROR'; break
            case 'blocked': row.status = 'failed'; row.code = 'RUN_BLOCKED'; break
            case 'max-tokens': row.status = 'failed'; row.code = 'OUTPUT_INCOMPLETE'; break
            default: row.status = 'unknown'; row.code = reason.kind === 'interrupted' ? 'RUN_INTERRUPTED' : 'RUN_OUTCOME_UNKNOWN'
          }
          row.modelCompleted = row.status === 'completed'
        }
        if (state.openTurn === turn) { state.openTurn = null; state.stepped = false }
        break
      }
    }
    return state
  },
  wire: {
    viewSchema: z.object({ version: z.literal(1), runs: z.array(rowSchema).max(MAX_RUN_RECORDS) }),
    view: state => ({ version: 1, runs: state.runs.map(({ admitted: _admitted, ...row }) => row) }),
  },
} satisfies ProjectionDefinition<'intelligentUiRuns'>
