export const TABLE_TOOL_NAME = 'render_intelligent_table'
export const TABLE_MAX_CHARS = 200000
export interface UiTable { version: 1; title: string; columns: string[]; rows: string[][]; source: string }
export function parseTable(value: unknown): UiTable | null {
  if (!value || typeof value !== 'object') return null
  const table = value as Record<string, unknown>
  if (table.version !== 1 || typeof table.title !== 'string' || table.title.length > 300
    || typeof table.source !== 'string' || table.source.length > 1000
    || !Array.isArray(table.columns) || table.columns.length < 1 || table.columns.length > 12
    || !Array.isArray(table.rows) || table.rows.length > 200) return null
  let chars = table.title.length + table.source.length
  const columns: string[] = []
  for (const column of table.columns) {
    if (typeof column !== 'string' || column.length > 200) return null
    chars += column.length; columns.push(column)
  }
  const rows: string[][] = []
  for (const row of table.rows) {
    if (!Array.isArray(row) || row.length !== columns.length) return null
    const cells: string[] = []
    for (const cell of row) {
      if (typeof cell !== 'string' || cell.length > 2000) return null
      chars += cell.length
      if (chars > TABLE_MAX_CHARS) return null
      cells.push(cell)
    }
    rows.push(cells)
  }
  return { version: 1, title: table.title, columns, rows, source: table.source }
}
export function tableChars(table: UiTable): number {
  return table.title.length + table.source.length + table.columns.reduce((n, cell) => n + cell.length, 0)
    + table.rows.reduce((n, row) => n + row.reduce((m, cell) => m + cell.length, 0), 0)
}
export function tableFromMeta(meta: unknown): UiTable | null {
  return meta && typeof meta === 'object' ? parseTable((meta as Record<string, unknown>).intelligentTable) : null
}
