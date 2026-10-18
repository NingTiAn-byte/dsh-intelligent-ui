import type { UiTable } from '../shared/table.ts'
import { themeVariables, type UiTheme } from '../shared/theme.ts'
import type { CopyKey } from './copy.ts'
import type { UiPhase } from './stream-results.ts'

const STYLES = `
[data-intelligent-table]{background:var(--iui-bg);color:var(--iui-text);border:1px solid var(--iui-border);border-radius:16px;padding:16px;min-width:0;max-width:100%;margin:12px 0;font-family:var(--iui-font-family);font-size:var(--iui-font-size);line-height:1.65}
[data-intelligent-table] .iui-table-scroll{max-height:560px;overflow:auto;max-width:100%;border:1px solid var(--iui-border);border-radius:8px}
[data-intelligent-table] .iui-table-scroll:focus-visible{outline:2px solid var(--iui-focus);outline-offset:3px}
[data-intelligent-table] table{border-collapse:collapse;width:100%;font:inherit;color:inherit}
[data-intelligent-table] caption{text-align:left;font-weight:600;padding:16px 12px;background:var(--iui-bg);font-size:1.1em}
[data-intelligent-table] th,[data-intelligent-table] td{text-align:left;vertical-align:top;border-bottom:1px solid var(--iui-border);padding:10px 12px;min-width:9rem;max-width:32rem;overflow-wrap:anywhere;white-space:pre-wrap}
[data-intelligent-table] th{background:var(--iui-surface);font-weight:500;color:var(--iui-muted)}
[data-intelligent-table] .iui-table-source{color:var(--iui-muted);white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0}
[data-intelligent-table] [role=alert]{color:var(--iui-error)}
`
export function TableCard({ table, phase, title, callId, theme, t }: {
  table: UiTable | null; phase: UiPhase; title: string; callId: string; theme: UiTheme; t: (key: CopyKey) => string
}) {
  const label = table?.title || title || t('tableTitle')
  return <section data-intelligent-table data-intelligent-ui-call={callId} data-ui-theme={theme.scheme}
    aria-label={label} style={{ ...themeVariables(theme), colorScheme: theme.scheme }}>
    <style>{STYLES}</style>
    {phase === 'ready' && table ? <>
      <div className="iui-table-scroll" role="region" aria-label={`${label} — ${t('tableScroll')}`} tabIndex={0}>
        <table><caption>{label}</caption><thead><tr>{table.columns.map((column, index) => <th key={index} scope="col">{column}</th>)}</tr></thead>
          <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table>
      </div>
      {table.rows.length === 0 && <p role="status">{t('tableEmpty')}</p>}
      <p className="iui-table-source">{t('tableSource')}{table.source || t('tableSourceMissing')}</p>
    </> : <><strong>{label}</strong><p role={phase === 'failed' ? 'alert' : 'status'}>{t(phase === 'failed' ? 'tableFailed' : 'tablePreparing')}</p></>}
  </section>
}
