import type { ToolCallBlock, ToolChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import { documentFromMeta, TOOL_NAME, type UiDocument } from '../shared/document.ts'
import type { UiTurn } from './stream-definition.ts'
import { tableFromMeta, TABLE_TOOL_NAME, type UiTable } from '../shared/table.ts'
import { COMPONENT_TOOLS } from '../shared/features.ts'

export type UiPhase = 'generating' | 'ready' | 'failed'
export interface UiStreamResult { readonly callId: string; readonly document: UiDocument; readonly phase: UiPhase; readonly error?: string }
export type PresentationResult = (UiStreamResult & { kind: 'ui' }) | {
  kind: 'table'; callId: string; table: UiTable | null; title: string; phase: UiPhase
}

/** Preserve tool/subcall order and one result per call across both presentation types. */
export function collectPresentationResults(nodes: readonly ToolChatData[], turn: UiTurn): readonly PresentationResult[] {
  const ui = new Map(collectStreamResults(nodes, turn).map(result => [result.callId, result]))
  const results = new Map<string, PresentationResult>()
  function visit(block: ToolCallBlock): void {
    const complete = 'kind' in block
    const table = complete && !block.isError ? tableFromMeta(block.meta) : null
    if (block.name === TABLE_TOOL_NAME || table) {
      const interrupted = !complete && (turn.closed || turn.closedSteps.includes(block.step))
      results.set(block.callId, { kind: 'table', callId: block.callId, table,
        title: table?.title || block.args.textPrefix('title', 300) || '',
        phase: table ? 'ready' : complete || interrupted || block.args.invalid ? 'failed' : 'generating' })
    } else if (ui.has(block.callId)) results.set(block.callId, { kind: 'ui', ...ui.get(block.callId)! })
    for (const child of block.subCalls) visit(child)
  }
  for (const node of nodes) visit(node.root)
  return [...results.values()]
}

/** Read on every render: PartialArguments grows in place and tracks these observations. */
export function collectStreamResults(nodes: readonly ToolChatData[], turn: UiTurn): readonly UiStreamResult[] {
  const results = new Map<string, UiStreamResult>()
  function visit(block: ToolCallBlock): void {
    const complete = 'kind' in block
    const saved = complete && !block.isError ? documentFromMeta(block.meta) : null
    if (block.name === TOOL_NAME || COMPONENT_TOOLS.includes(block.name as typeof COMPONENT_TOOLS[number]) || saved) {
      if (saved) results.set(block.callId, { callId: block.callId, document: saved, phase: 'ready' })
      else {
        const args = block.args
        // Bound allocation, including when a model emits a huge unfinished string.
        const html = args.textPrefix('html', 200000) ?? ''
        const css = args.textPrefix('css', 200000) ?? ''
        const oversized = args.stringExceeds('html', 200000) || args.stringExceeds('css', 200000)
          || args.stringExceeds('javascript', 200000) || html.length + css.length > 200000
        const invalid = args.invalid || oversized
        const interrupted = !complete && (turn.closed || turn.closedSteps.includes(block.step))
        const height = args.value('height')
        const document: UiDocument = {
          version: 1, title: args.textPrefix('title', 200) || 'Intelligent UI',
          description: args.textPrefix('description', 2000) ?? '',
          html: invalid ? '' : html, css: invalid || !args.complete('css') ? '' : css,
          javascript: '', height: typeof height === 'number' && Number.isFinite(height) && height >= 180 && height <= 900 ? height : 300,
        }
        const error = complete && block.isError ? block.content?.filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 2000) : undefined
        results.set(block.callId, { callId: block.callId, document, phase: complete || interrupted || invalid ? 'failed' : 'generating', ...(error ? { error } : {}) })
      }
    }
    for (const child of block.subCalls) visit(child)
  }
  for (const node of nodes) visit(node.root)
  return [...results.values()]
}
