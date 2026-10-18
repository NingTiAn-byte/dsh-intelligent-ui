import type { ConversationMatch, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-tools/types'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { documentFromMeta, TOOL_NAME } from '../shared/document.ts'
import { tableFromMeta, TABLE_TOOL_NAME } from '../shared/table.ts'
import { COMPONENT_TOOLS } from '../shared/features.ts'

export interface UiTurn { readonly turn: number; readonly closed: boolean; readonly closedSteps: readonly number[] }
export interface UiNodeData extends UiTurn { readonly rootCallId: string }
interface State { readonly hasUi: boolean }
declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap { 'intelligent-ui': UiNodeData }
}

function identifiesUi(event: ConversationMatch['event']): boolean {
  const known = (name: string | undefined) => name === TOOL_NAME || name === TABLE_TOOL_NAME || COMPONENT_TOOLS.includes(name as typeof COMPONENT_TOOLS[number])
  if (event.type === 'tool/call') return known(event.data.name)
  if (event.type === 'tool/result') return documentFromMeta(event.data.meta) !== null || tableFromMeta(event.data.meta) !== null
  if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') return known(event.data.name)
  if (event.type !== 'assistant/live-chunk') return false
  const chunk = event.data.chunk
  return chunk.type === 'tool-call-delta' ? known(chunk.name)
    : chunk.type === 'block-end' && chunk.block.type === 'tool-call' && known(chunk.block.name)
}
/** Own only placement/lifetime. DSH's existing tool projection owns arguments and results. */
export const streamDefinition: ConversationNodeDefinition<State> = {
  kind: 'intelligent-ui', target: 'chat',
  match: event => {
    if (event.type === 'assistant/live-chunk') {
      const chunk = event.data.chunk
      if (chunk.type === 'tool-call-delta') return { id: String(chunk.id), role: 'start' }
      if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') return { id: String(chunk.block.id), role: 'start' }
    }
    if (event.type === 'tool/call') return { id: String(event.data.callId), role: 'start' }
    if (event.type === 'tool/result' && event.surfaceOp === 'append') return { id: String(event.data.message.source.callId), role: 'start' }
    if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
      const root: unknown = event.data.rootCallId
      return typeof root === 'string' && root ? { id: root, role: 'start' } : null
    }
    return null
  },
  start: (_context, match) => ({ hasUi: identifiesUi(match.event) }),
  update: (context, match) => context.state.hasUi || !identifiesUi(match.event) ? context.state : { hasUi: true },
  publication: match => match.event.type === 'assistant/live-chunk' ? 'animation-frame' : 'immediate',
  buildViewNode: context => {
    const first = context.start ?? context.matches[0]
    if (!context.state?.hasUi || !first) return null
    const current = context.current.get('chat') as ChatNode<'intelligent-ui'> | undefined
    const location = first.location
    if (location.kind !== 'step' && location.kind !== 'turn') return null
    const turn = location.turn.turn
    const closed = location.turn.status === 'closed'
    const closedStep = location.kind === 'step' && location.step.status === 'closed' ? location.step.step : undefined
    if (current?.location === location && current.data.closed === closed && current.data.closedSteps[0] === closedStep) return current
    const data: UiNodeData = { turn, rootCallId: context.id, closed, closedSteps: closedStep === undefined ? [] : [closedStep] }
    return {
      key: context.key, kind: 'intelligent-ui', id: context.id, target: 'chat',
      anchorSeq: first.event.seq + 0.02, location, visibility: 'visible', groupTree: 'turn', data,
    } satisfies ChatNode<'intelligent-ui'>
  },
}
