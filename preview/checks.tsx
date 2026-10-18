/** Offline browser harness. This entry is never included in the DSH client bundle. */
import { createRoot } from 'react-dom/client'
import { Widget } from '../src/client/widget.tsx'
import { zh } from '../src/client/copy.ts'
import type { UiDocument } from '../src/shared/document.ts'
import type { UiPhase } from '../src/client/stream-results.ts'
import { makeTheme, type UiTheme } from '../src/shared/theme.ts'
import { parseTable, type UiTable } from '../src/shared/table.ts'
import { TableCard } from '../src/client/table.tsx'
import type { RunSnapshot } from '../src/shared/runs.ts'

interface Checks {
  mount: (document: UiDocument, mode?: 'ok' | 'fail' | 'defer') => void
  unmount: () => void
  stream: (document: UiDocument, phase: UiPhase, newCall?: boolean) => void
  setTheme: (theme: UiTheme) => void
  table: (value: unknown, phase?: UiPhase) => void
  runs: (value?: RunSnapshot) => void
  requests: string[]
  mode: 'ok' | 'fail' | 'defer'
  sent: string[]
  messages: Record<string, unknown>[]
  finish?: () => void
}
declare global { interface Window { uiChecks: Checks } }
const root = createRoot(document.getElementById('root')!)
let generation = 0
let currentDocument: UiDocument | null = null
let currentPhase: UiPhase = 'ready'
let currentTheme = makeTheme()
let runSnapshot: RunSnapshot | undefined
let currentTable: { table: UiTable | null; phase: UiPhase } | null = null
function render(): void {
  root.render(currentTable ? <TableCard table={currentTable.table} phase={currentTable.phase} title="测试表格" callId="table-check" theme={currentTheme} t={key => zh[key]} /> : currentDocument && <Widget key={generation} callId="check-call" runSnapshot={runSnapshot} document={currentDocument} phase={currentPhase} theme={currentTheme}
    t={(key, params) => zh[key].replace('{message}', params?.message ?? '')}
    setTheme={value => { currentTheme = makeTheme(value === 'system' ? 'light' : value); render() }}
    sendPrompt={async (text, requestId) => {
      checks.sent.push(text)
      checks.requests.push(requestId)
      if (checks.mode === 'fail') throw new Error('Simulated queue rejection')
      if (checks.mode === 'defer') await new Promise<void>(resolve => { checks.finish = resolve })
    }} />)
}
const checks: Checks = {
  mode: 'ok', sent: [], messages: [], requests: [],
  runs: value => { runSnapshot = value; render() },
  mount: (document, mode = 'ok') => {
    currentTable = null
    runSnapshot = undefined
    checks.mode = mode; checks.sent = []; checks.messages = []; checks.requests = []; checks.finish = undefined
    generation++; currentDocument = document; currentPhase = 'ready'; render()
  },
  unmount: () => { currentDocument = null; currentTable = null; render() },
  stream: (document, phase, newCall = false) => {
    currentTable = null
    if (newCall) { generation++; checks.messages = []; checks.sent = [] }
    currentDocument = document; currentPhase = phase; render()
  },
  setTheme: theme => { currentTheme = theme; render() },
  table: (value, phase = 'ready') => { const table = parseTable(value); currentTable = { table, phase: phase === 'ready' && !table ? 'failed' : phase }; render() },
}
window.uiChecks = checks
window.addEventListener('message', event => {
  if (event.source === document.querySelector('iframe')?.contentWindow && typeof event.data === 'object' && event.data)
    checks.messages.push(event.data)
})
