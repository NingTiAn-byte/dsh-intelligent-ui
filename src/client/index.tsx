import type { Context } from '@deepseek-ai/cordis'
import { useMemo } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ToolChatData } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { hostTheme } from './host-theme.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { documentFromMeta, TOOL_NAME } from '../shared/document.ts'
import { tableFromMeta, TABLE_TOOL_NAME } from '../shared/table.ts'
import { TableCard } from './table.tsx'
import { Widget } from './widget.tsx'
import { streamDefinition } from './stream-definition.ts'
import { collectStreamResults, collectPresentationResults } from './stream-results.ts'
import { en, zh, type CopyKey } from './copy.ts'
import { RUN_KEY, runRpcId, type RunSnapshot } from '../shared/runs.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { COMPONENT_TOOLS } from '../shared/features.ts'
export { collectResults } from './results.ts'
export { collectStreamResults, collectPresentationResults, streamDefinition }

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { intelligentUi: CopyKey }
}
interface Actions { sendPrompt: (text: string, requestId: string, callId: string) => Promise<void>; setTheme: (theme: 'light' | 'dark' | 'system') => void }
type Props = ToolCallViewProps & PropsLocale<'intelligentUi'>
function IntelligentUiView(props: Props) {
  const meta = props.phase === 'result' ? props.block.meta : undefined
  const doc = useMemo(() => documentFromMeta(meta), [meta])
  if (props.phase !== 'result') return <p role="status">{props.t('preparing')}</p>
  if (props.block.isError) return <p role="alert">{props.t('failed')}</p>
  if (!doc) return <p role="alert">{props.t('unavailable')}</p>
  return <p role="status">{props.t('saved')}</p>
}
function IntelligentTableView(props: Props) {
  if (props.phase !== 'result') return <p role="status">{props.t('tablePreparing')}</p>
  if (props.block.isError) return <p role="alert">{props.t('tableFailed')}</p>
  if (!tableFromMeta(props.block.meta)) return <p role="alert">{props.t('tableFailed')}</p>
  return <p role="status">{props.t('tableSaved')}</p>
}
interface ResultsInjected extends Actions {
  keyedHooks: { results: (turn: string) => HostObservable<readonly ToolChatData[]> }
  hooks: { theme: HostObservable<ThemeSnapshot>; runs: HostObservable<RunSnapshot | undefined> }
}
function IntelligentUiResults({ node, useResults, useTheme, useRuns, sendPrompt, setTheme, t }: PropsRuntime<'conversation.chat.node', 'intelligent-ui'> & InjectFace<ResultsInjected> & PropsLocale<'intelligentUi'>) {
  const snapshot = useTheme(value => value)
  const runs = useRuns(value => value)
  const theme = useMemo(() => hostTheme(snapshot), [snapshot])
  const nodes = useResults(String(node.data.turn))
  const results = collectPresentationResults((nodes ?? []).filter(row => row.root.callId === node.data.rootCallId), node.data)
  return <div data-intelligent-ui-results data-intelligent-ui-turn={node.data.turn}>{results.map(result =>
    result.kind === 'table' ? <TableCard key={result.callId} callId={result.callId} table={result.table} title={result.title} phase={result.phase} theme={theme} t={t} />
      : <Widget key={result.callId} callId={result.callId} document={result.document} phase={result.phase} error={result.error} theme={theme} runSnapshot={runs}
          sendPrompt={(text, requestId) => sendPrompt(text, requestId, result.callId)} setTheme={setTheme} t={t} />)}</div>
}
export const inject = ['slots', 'locale', 'conversation', 'sessions', 'uiConversation', 'theme']
export function apply(ctx: Context): void {
  const sessions = ctx.sessions
  if (!sessions) throw new Error('Intelligent UI requires the DSH client sessions service')
  ctx.effect(() => ctx.locale.register('intelligentUi', { zh, en }), 'intelligent-ui locales')
  ctx.effect(() => ctx.uiConversation.events.register(streamDefinition), 'intelligent-ui live results')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: TOOL_NAME, locale: 'intelligentUi',
  }, IntelligentUiView))
  for (const name of COMPONENT_TOOLS) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: name, locale: 'intelligentUi' }, IntelligentUiView))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: TABLE_TOOL_NAME, locale: 'intelligentUi',
  }, IntelligentTableView))
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node', key: 'intelligent-ui', locale: 'intelligentUi',
    inject: sessionId => {
      const scoped = sessions.scope(sessionId as SessionId)
      if (!scoped) throw new Error('Intelligent UI session scope is unavailable')
      // A Session scope is a foreign Cordis context; resolve through its public lookup.
      const conversation = scoped.get('conversation')
      if (!conversation) throw new Error('Intelligent UI requires a scoped DSH conversation')
      const binding = sessions.binding(sessionId as SessionId)
      if (!binding) throw new Error('Intelligent UI session binding is unavailable')
      const chat = ctx.uiConversation.binding(binding).target('chat')
      return {
        setTheme: (theme: 'light' | 'dark' | 'system') => ctx.theme.setTheme(theme),
        sendPrompt: async (text: string, requestId: string, callId: string) => {
          // SessionFace accepts an explicit RPC identity; DSH persists it in the admitted message's source.
          const result = await binding.session.prompt([{ type: 'text', text }], 'queue', undefined, runRpcId(callId, requestId) as SessionRequestId)
          if (!result.ok) throw new Error(`Follow-up submission failed: ${result.error.code}: ${result.error.message}`)
        },
        hooks: { runs: binding.session.projections.faceOf(RUN_KEY) as HostObservable<RunSnapshot | undefined>, theme: {
          getSnapshot: () => ctx.theme.getTheme(),
          subscribe: (listener: () => void) => {
            let active = true
            // Resolve CSS alias overrides after ui-layout has presented this snapshot.
            const stop = ctx.on('theme/change', () => queueMicrotask(() => { if (active) listener() }))
            return () => { active = false; stop() }
          },
        } },
        keyedHooks: { results: (turn: string) => {
          const snapshot = chat.getSnapshot()
          if (!snapshot) throw new Error('Intelligent UI Chat target is unavailable')
          return snapshot.nodes.turnDataSource(Number(turn), 'tool-call')
        } },
      }
    },
  }, IntelligentUiResults))
}
