import type { ToolCallBlock, ToolChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import { documentFromMeta, TOOL_NAME, type UiDocument } from '../shared/document.ts'

export interface UiResult { readonly callId: string; readonly document: UiDocument }

/** Read successful documents from DSH's existing turn projection, including PTC children. */
export function collectResults(nodes: readonly ToolChatData[]): readonly UiResult[] {
  const results = new Map<string, UiResult>()
  function visit(block: ToolCallBlock): void {
    if ('kind' in block && block.name === TOOL_NAME && !block.isError) {
      const document = documentFromMeta(block.meta)
      if (document) results.set(block.callId, { callId: block.callId, document })
    }
    for (const child of block.subCalls) visit(child)
  }
  for (const node of nodes) visit(node.root)
  return [...results.values()]
}
