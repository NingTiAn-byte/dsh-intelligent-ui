import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import * as plugin from '../lib/index.js'
import { parseTable, tableFromMeta } from '../lib/table.js'
const sample = { title: '季度收入', columns: ['季度', '收入（元）'], rows: [['Q1', '100'], ['Q2', '200']], source: '用户提供的演示数据' }
async function setup(config = {}) {
  const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900, ...config }); await fiber
  return { ctx, fiber }
}
const call = (ctx, arguments_, signal = new AbortController().signal) => ctx.tools.execute({ callId: 'table-test', name: 'render_intelligent_table', arguments: arguments_, signal })

test('table tool uses real DSH schema, saves only versioned text data and unregisters on unload', async () => {
  const { ctx, fiber } = await setup()
  try {
    const schema = ctx.tools.schemas().find(t => t.name === 'render_intelligent_table').parameters
    assert.deepEqual(schema.required, ['title', 'columns', 'rows', 'source'])
    assert.equal(schema.properties.rows.items.items.type, 'string')
    const result = await call(ctx, sample)
    assert.equal(result.isError, false)
    assert.deepEqual(tableFromMeta(JSON.parse(JSON.stringify(result.meta))), { version: 1, ...sample })
    assert.equal(result.meta.intelligentUi, undefined)
    assert.match(result.content[0].text, /2 rows, 2 columns/)
    assert.ok((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'intelligent-ui-table'))
    await fiber.dispose()
    assert.equal(ctx.tools.schemas().some(t => t.name === 'render_intelligent_table'), false)
    assert.equal((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'intelligent-ui-table'), false)
  } finally { await ctx.fiber.dispose() }
})

test('table enforces original per-field limits, matching widths and DSH aggregate/configured caps', async () => {
  const { ctx } = await setup()
  try {
    const wide = { ...sample, columns: Array(12).fill('列'), rows: Array.from({ length: 200 }, () => Array(12).fill('数据')) }
    assert.equal((await call(ctx, wide)).isError, false)
    assert.equal((await call(ctx, { ...sample, rows: [] })).isError, false)
    const bad = [null, { ...sample, columns: [] }, { ...wide, columns: Array(13).fill('列') },
      { ...sample, rows: Array(201).fill(['Q1', '100']) }, { ...sample, rows: [['Q1']] },
      { ...sample, rows: [['Q1', '100', 'extra']] }, { ...sample, rows: [['Q1', 100]] },
      { ...sample, rows: [['Q1', null]] }, { ...sample, title: 'x'.repeat(301) },
      { ...sample, columns: ['x'.repeat(201), '列'] }, { ...sample, source: 'x'.repeat(1001) },
      { ...sample, rows: [['Q1', 'x'.repeat(2001)]] },
      { ...wide, rows: Array.from({ length: 200 }, () => Array(12).fill('x'.repeat(100))) }]
    for (const input of bad) assert.equal((await call(ctx, input)).isError, true)
    const controller = new AbortController(); controller.abort()
    assert.equal((await call(ctx, sample, controller.signal)).isError, true)
  } finally { await ctx.fiber.dispose() }
  const limited = await setup({ maxDocumentChars: 1000 })
  try { assert.equal((await call(limited.ctx, { ...sample, rows: [['a', 'x'.repeat(1000)]] })).isError, true) }
  finally { await limited.ctx.fiber.dispose() }
})

test('table replay validates untrusted metadata and clones data while preserving markup as literal text', () => {
  const value = { version: 1, ...sample, rows: [['<script>window.pwned=1</script>', '<img src=x onerror=alert(1)>']], extra: 'discard' }
  const parsed = parseTable(value)
  assert.equal(parsed.rows[0][0], value.rows[0][0]); assert.equal(parsed.extra, undefined)
  parsed.rows[0][0] = 'changed'; parsed.columns[0] = 'changed'
  assert.equal(value.columns[0], '季度'); assert.match(value.rows[0][0], /script/)
  for (const input of [null, {}, { intelligentTable: { ...value, version: 2 } }, { intelligentTable: { ...value, rows: [[]] } }]) assert.equal(tableFromMeta(input), null)
  assert.ok(parseTable({ version: 1, title: '', source: '', columns: [''], rows: [['']] }), 'Match original empty-string field semantics')
})
