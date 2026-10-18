import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import * as plugin from '../lib/index.js'
import { documentFromMeta } from '../lib/document.js'
import { getTemplate, TEMPLATE_NAMES } from '../lib/templates.js'

const args = { title: 'Calculator', description: 'Synthetic test, units: items.', html: '<output>4</output>', css: '', javascript: '', height: 300 }
async function setup(config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900, ...config })
  await fiber
  return { ctx, fiber }
}
function call(ctx, arguments_, signal = new AbortController().signal) {
  return ctx.tools.execute({ callId: 'ui-test', name: 'render_intelligent_ui', arguments: arguments_, signal })
}
test('actual DSH registry validates, executes and produces replayable metadata', async () => {
  const { ctx } = await setup()
  try {
    assert.equal(ctx.tools.schemas().find(t => t.name === 'render_intelligent_ui').parameters.required.includes('html'), true)
    const result = await call(ctx, args)
    assert.equal(result.isError, false)
    assert.equal(result.value.version, 1)
    assert.match(result.content[0].text, /Calculator/)
    const replay = JSON.parse(JSON.stringify({ content: result.content, meta: result.meta }))
    assert.deepEqual(documentFromMeta(replay.meta), result.value)
    assert.equal(replay.value, undefined)
  } finally { await ctx.fiber.dispose() }
})
test('malformed arguments, configured size and height caps become tool errors', async () => {
  const { ctx } = await setup({ maxDocumentChars: 1000, maxHeight: 500 })
  try {
    for (const input of [{ ...args, height: '300' }, { ...args, html: 'x'.repeat(1001) }, { ...args, height: 600 }]) {
      assert.equal((await call(ctx, input)).isError, true)
    }
  } finally { await ctx.fiber.dispose() }
})
test('aborted calls do not produce successful UI; disposal removes registrations', async () => {
  const { ctx, fiber } = await setup()
  try {
    const controller = new AbortController(); controller.abort()
    assert.equal((await call(ctx, args, controller.signal)).isError, true)
    await fiber.dispose()
    assert.equal(ctx.tools.schemas().some(t => t.name === 'render_intelligent_ui'), false)
  } finally { await ctx.fiber.dispose() }
})
test('old or missing metadata never executes a document', () => {
  assert.equal(documentFromMeta(null), null)
  assert.equal(documentFromMeta({ intelligentUi: { ...args, version: 2 } }), null)
})

test('template tool returns renderable documents and generation guidance; unload removes both tools and guidance', async () => {
  const { ctx, fiber } = await setup()
  for (const template of TEMPLATE_NAMES) {
    const result = await ctx.tools.execute({ callId: `template-${template}`, name: 'get_intelligent_ui_template', arguments: { template }, signal: new AbortController().signal })
    assert.equal(result.isError, false)
    const { version, ...args } = JSON.parse(result.value)
    assert.equal(version, template.startsWith('chart_') ? 2 : 1)
    assert.ok(args.javascript.includes('finally'))
    assert.equal((await call(ctx, args)).isError, false)
    assert.equal(result.meta?.intelligentUi, undefined, 'reading a template never creates a rendered card')
  }
  const bad = await ctx.tools.execute({ callId: 'bad-template', name: 'get_intelligent_ui_template', arguments: { template: 'missing' }, signal: new AbortController().signal })
  assert.equal(bad.isError, true)
  const prompt = await ctx.systemPrompt.assemble()
  assert.ok(prompt.sections.some(section => section.name === 'intelligent-ui-generation' && section.text.includes('modelCompleted:false')))
  await fiber.dispose()
  assert.equal(ctx.tools.schemas().some(tool => tool.name === 'get_intelligent_ui_template'), false)
  assert.equal((await ctx.systemPrompt.assemble()).sections.some(section => section.name === 'intelligent-ui-generation'), false)
  await ctx.fiber.dispose()
})

test('pinned chart library produces v2 metadata; empty declarations preserve v1 and unsupported libraries fail', async () => {
  const { ctx } = await setup()
  try {
    const chart = getTemplate('chart_line')
    const { version, ...input } = chart
    const result = await call(ctx, input)
    assert.equal(result.isError, false)
    assert.equal(result.value.version, 2)
    assert.deepEqual(result.value.libraries, ['chartjs-4.5.1'])
    assert.deepEqual(documentFromMeta(JSON.parse(JSON.stringify(result.meta))), chart)
    assert.ok(!JSON.stringify(result.meta).includes('Chart.js v4.5.1'), 'Library code belongs to runtime, not persisted model source')
    const empty = await call(ctx, { ...args, libraries: [] })
    assert.equal(empty.isError, false)
    assert.equal(empty.value.version, 1)
    assert.equal(empty.value.libraries, undefined)
    for (const libraries of [['chartjs-4.5.0'], ['https://example.com/chart.js'], ['chartjs-4.5.1', 'chartjs-4.5.1'], 'chartjs-4.5.1', null]) {
      assert.equal((await call(ctx, { ...args, libraries })).isError, true)
    }
    assert.equal(documentFromMeta({ intelligentUi: { ...chart, libraries: ['chartjs-4.5.2'] } }), null)
    assert.equal(documentFromMeta({ intelligentUi: { ...chart, version: 1 } }), null)
    const changed = getTemplate('chart_line'); changed.libraries.pop()
    assert.deepEqual(getTemplate('chart_line').libraries, ['chartjs-4.5.1'])
  } finally { await ctx.fiber.dispose() }
})
