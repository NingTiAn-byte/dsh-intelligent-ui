import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { harness, resolveExisting, requireProjectionSource } from '../scripts/environment.mjs'
import { getTemplate } from '../lib/templates.js'
import { document as imageDocument } from './image-fixture.mjs'
import { mapDocument, chartDocument, planDocument, workflowDocument, meetingDocument } from '../lib/features.js'
const { tsImport } = await import(pathToFileURL(resolveExisting('tsx/esm/api')).href)
requireProjectionSource()
const load = relative => tsImport(pathToFileURL(join(harness, relative)).href, import.meta.url)
const { ConversationNodeAssembler } = await load('packages/client/ui-conversation/src/client/conversation/assembler.ts')
const { toolDefinition } = await load('packages/client/ui-chat/src/client/conversation-nodes/tool.ts')
const { chatViewDefinition } = await load('packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts')
const { processGroupDefinition } = await load('packages/client/ui-chat/src/client/conversation-nodes/process-groups.ts')
const { PartialArguments } = await load('packages/util/values/src/index.ts')
let factory
runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { URL, window: { __ModuleLoader__: { load: row => { factory = row.factory } } } })
const { streamDefinition, collectStreamResults, collectPresentationResults } = factory(createRequire(import.meta.url))
const doc = { version: 1, title: 'Projection', description: '', height: 300, css: 'p{color:green}', html: '<p>Hello</p>', javascript: 'window.runs=1' }

test('failed map results retain the actual tool error during live projection and saved replay', () => {
  const h = setup()
  const call = event('tool/call', 3, { step: 1, callId: 'map-error', name: 'render_intelligent_map', arguments: '{"title":"上海行程"}' })
  h.assembler.append(call)
  const result = event('tool/result', 4, { step: 1, message: { role: 'tool', source: { callId: 'map-error' }, content: [{ type: 'text', text: 'Error: 无法确定安福路的坐标' }], isError: true } }, { surfaceOp: 'append' })
  h.assembler.append(result)
  const row = h.read().results[0]
  assert.equal(row.phase, 'failed'); assert.match(row.error, /安福路/); assert.equal(row.document.javascript, '')
  h.assembler.replaceWindow(JSON.parse(JSON.stringify([call, result])), false)
  assert.match(h.read().results[0].error, /安福路/)
})
test('all specialized tools retain one permanent node through native and PTC execution and JSON history replay', () => {
  const documents = [
    ['render_intelligent_map', mapDocument({ title: '香港', basemap: 'world', durationMs: 6000, stops: [{ name: '香港', latitude: 22.3, longitude: 114.2, description: '', source: '用户坐标' }] })],
    ['render_intelligent_chart', chartDocument({ title: '图', kind: 'bar', labels: ['A'], values: [1], unit: '件', source: '演示' })],
    ['plan_intelligent_ui', planDocument('比较', 'SVG', ['节点', '连线'])],
    ['render_intelligent_workflow', workflowDocument('待办', [{ title: '第一步', description: '', status: 'pending' }])],
    ['choose_intelligent_meeting_time', meetingDocument({ title: '评审', status: 'selected', selected: '2026-10-20T10:00:00+08:00', timezone: 'Asia/Hong_Kong', durationMinutes: 30 })],
  ]
  for (const [name, saved] of documents) {
    const h = setup(); h.assembler.append(event('tool/call', 3, { step: 1, callId: name, name, arguments: '{}' })); const key = h.read().node.key
    assert.equal(h.read().results[0].phase, 'generating')
    const result = event('tool/result', 4, { step: 1, message: { role: 'tool', source: { callId: name }, content: [], isError: false }, meta: { intelligentUi: saved } }, { surfaceOp: 'append' })
    h.assembler.append(result); assert.equal(h.read().node.key, key); assert.equal(h.read().results[0].phase, 'ready')
    h.assembler.replaceWindow([event('turn/start', 1, {}), event('step/start', 2, { step: 1 }), JSON.parse(JSON.stringify(result))], false); assert.equal(h.read().results[0].document.title, saved.title)
    const nested = setup(); nested.assembler.append(event('tool/call', 3, { step: 1, callId: 'code', name: 'run_code', arguments: '{}' }))
    nested.assembler.append({ type: 'event', event: { type: 'tool/ptc-dispatch', seq: 4, time: 4, data: { rootCallId: 'code', parentCallId: 'code', subCallId: `code:${name}`, name, arguments: {}, isError: false, content: [], meta: { intelligentUi: saved } } } })
    assert.equal(nested.read().results[0].phase, 'ready'); assert.equal(nested.read().results[0].document.title, saved.title)
  }
})
const event = (type, seq, data, extra = {}) => ({ type: 'event', event: { type, seq, time: seq, data: { turn: 1, ...data }, ...extra } })
function setup() {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [toolDefinition, streamDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
    { entries: () => [processGroupDefinition], forTarget: target => target === 'chat' ? processGroupDefinition : undefined },
  )
  assembler.replaceWindow([event('turn/start', 1, {}), event('step/start', 2, { step: 1 })], false)
  assembler.activateTarget('chat')
  function snapshot() { assembler.flush(); return assembler.snapshot('chat') }
  function read(collect = collectStreamResults) {
    const snapshotValue = snapshot()
    const node = snapshotValue.nodes.values().find(node => node.kind === 'intelligent-ui')
    return { node, results: node ? collect(snapshotValue.nodes.values().filter(row => row.kind === 'tool-call' && row.data.root.callId === node.data.rootCallId).map(node => node.data), node.data) : [] }
  }
  function delta(seq, argumentsDelta, name, id = 'ui-1', index = 0) {
    assembler.append({ type: 'transient', event: { type: 'assistant/live-chunk', seq, time: seq, data: { turn: 1, step: 1, attemptId: 'attempt', chunk: { type: 'tool-call-delta', index, id, argumentsDelta, ...(name ? { name } : {}) } } } })
  }
  return { assembler, delta, read, snapshot }
}

test('real DSH assembler publishes observed JSON prefixes, keeps one outer node through success and turn end, and replays old metadata', () => {
  const h = setup()
  assert.equal(h.read().node, undefined)
  const raw = JSON.stringify(doc)
  const split = raw.indexOf('Hello') + 2
  h.delta(2.1, raw.slice(0, split), 'render_intelligent_ui')
  const first = h.read()
  assert.equal(first.node.groupTree, 'turn')
  assert.equal(first.results[0].document.html, '<p>He')
  assert.equal(first.results[0].document.javascript, '')
  assert.equal(first.results[0].phase, 'generating')
  let publications = 0
  const unsubscribe = h.snapshot().nodes.turnDataSource(1, 'tool-call').subscribe(() => { publications++ })
  h.delta(2.2, raw.slice(split))
  assert.equal(h.read().results[0].document.html, doc.html)
  assert.ok(publications > 0, 'Observed argument changes must notify the card source')
  unsubscribe()
  assert.equal(h.read().results[0].phase, 'generating')
  h.assembler.append(event('tool/call', 3, { step: 1, callId: 'ui-1', name: 'render_intelligent_ui', arguments: raw }))
  assert.equal(h.read().results[0].phase, 'generating')
  const result = event('tool/result', 4, { step: 1, message: { role: 'tool', source: { callId: 'ui-1' }, content: [], isError: false }, meta: { intelligentUi: doc } }, { surfaceOp: 'append' })
  h.assembler.append(result)
  assert.equal(h.read().results[0].phase, 'ready')
  assert.equal(h.read().results[0].document.javascript, doc.javascript)
  h.assembler.append(event('step/end', 5, { step: 1 }))
  h.assembler.append(event('turn/end', 6, { reason: { kind: 'completed' } }))
  const final = h.read()
  assert.equal(final.node.key, first.node.key)
  assert.equal(final.node.anchorSeq, first.node.anchorSeq)
  assert.equal(final.results.length, 1)
  assert.equal(final.results[0].phase, 'ready')
  h.assembler.replaceWindow([event('tool/call', 3, { step: 1, callId: 'ui-1', name: 'render_intelligent_ui', arguments: raw }), result, event('turn/end', 6, { reason: { kind: 'completed' } })], false)
  assert.equal(h.read().results[0].phase, 'ready')
})

test('structured table survives real DSH success, closed process and result-only history replay; interrupted args stay inactive', () => {
  const h = setup()
  const table = { version: 1, title: '受控表格', columns: ['项目'], rows: [['<script>literal</script>']], source: '演示' }
  h.delta(2.1, '{"title":"受控表', 'render_intelligent_table')
  const first = h.read(collectPresentationResults)
  assert.equal(first.results[0].kind, 'table'); assert.equal(first.results[0].phase, 'generating'); assert.equal(first.results[0].table, null)
  h.assembler.append(event('tool/call', 3, { step: 1, callId: 'ui-1', name: 'render_intelligent_table', arguments: JSON.stringify(table) }))
  const result = event('tool/result', 4, { step: 1, message: { role: 'tool', source: { callId: 'ui-1' }, content: [], isError: false }, meta: { intelligentTable: table } }, { surfaceOp: 'append' })
  h.assembler.append(result); h.assembler.append(event('step/end', 5, { step: 1 })); h.assembler.append(event('turn/end', 6, { reason: { kind: 'completed' } }))
  const final = h.read(collectPresentationResults)
  assert.equal(final.node.key, first.node.key); assert.equal(final.node.groupTree, 'turn')
  assert.equal(final.results.length, 1); assert.equal(final.results[0].phase, 'ready'); assert.equal(final.results[0].table.rows[0][0], table.rows[0][0])
  h.assembler.replaceWindow([JSON.parse(JSON.stringify(result))], false)
  assert.equal(h.read(collectPresentationResults).results[0].phase, 'ready')
  const stopped = setup(); stopped.delta(2.1, '{"title":"停止', 'render_intelligent_table')
  stopped.assembler.append(event('step/end', 3, { step: 1 }))
  assert.equal(stopped.read(collectPresentationResults).results[0].phase, 'failed')
})

test('mixed table/UI PTC results preserve order, deduplicate calls and reject malformed or failed table metadata', () => {
  const h = setup(); const table = { version: 1, title: 'Table', columns: ['A'], rows: [['one']], source: 'Synthetic' }
  h.assembler.append(event('tool/call', 3, { step: 1, callId: 'code', name: 'run_code', arguments: '{}' }))
  const child = (seq, id, name, meta, isError = false) => ({ type: 'event', event: { type: 'tool/ptc-dispatch', seq, time: seq, data: { rootCallId: 'code', parentCallId: 'code', subCallId: id, name, arguments: name === 'render_intelligent_table' ? table : doc, content: [], isError, meta } } })
  h.assembler.append(child(4, 'code:table', 'render_intelligent_table', { intelligentTable: table }))
  h.assembler.append(child(5, 'code:ui', 'render_intelligent_ui', { intelligentUi: doc }))
  h.assembler.append(child(6, 'code:bad', 'render_intelligent_table', { intelligentTable: { ...table, rows: [[]] } }))
  h.assembler.append(child(7, 'code:failed', 'render_intelligent_table', { intelligentTable: table }, true))
  const rows = h.read(collectPresentationResults).results
  assert.deepEqual(Array.from(rows, r => r.kind), ['table', 'ui', 'table', 'table'])
  assert.deepEqual(Array.from(rows, r => r.phase), ['ready', 'ready', 'failed', 'failed'])
  assert.equal(rows[2].table, null); assert.equal(rows[3].table, null)
  assert.equal(h.snapshot().nodes.values().filter(n => n.kind === 'intelligent-ui').length, 1)
  const nodes = h.snapshot().nodes.values().filter(n => n.kind === 'tool-call').map(n => n.data)
  assert.equal(collectPresentationResults([...nodes, ...nodes], h.read().node.data).length, 4)
})

test('PTC children without turn fields share their root card and settle independently, including tool errors', () => {
  const h = setup()
  h.assembler.append(event('tool/call', 3, { step: 1, callId: 'code-root', name: 'run_code', arguments: '{}' }))
  assert.equal(h.read().node, undefined)
  const child = (type, seq, subCallId, extra = {}) => ({ type: 'event', event: { type, seq, time: seq, data: { rootCallId: 'code-root', parentCallId: 'code-root', subCallId, name: 'render_intelligent_ui', arguments: doc, ...extra } } })
  h.assembler.append(child('tool/ptc-dispatch-start', 4, 'code-root:ptc:0'))
  assert.equal(h.read().results[0].phase, 'generating')
  assert.equal(h.read().node.data.rootCallId, 'code-root')
  h.assembler.append(child('tool/ptc-dispatch', 5, 'code-root:ptc:0', { isError: false, content: [], meta: { intelligentUi: doc } }))
  h.assembler.append(child('tool/ptc-dispatch-start', 6, 'code-root:ptc:1'))
  h.assembler.append(child('tool/ptc-dispatch', 7, 'code-root:ptc:1', { isError: true, content: [], meta: { intelligentUi: doc } }))
  const results = h.read().results
  assert.equal(results.length, 2)
  assert.equal(results[0].phase, 'ready')
  assert.equal(results[1].phase, 'failed')
  assert.equal(results[1].document.javascript, '')
  assert.equal(h.snapshot().nodes.values().filter(row => row.kind === 'intelligent-ui').length, 1)
})

test('real DSH interruption closes a preparing call; failures and oversize arguments never expose javascript', () => {
  const h = setup()
  h.delta(2.1, '{"html":"<p>unfinished', 'render_intelligent_ui')
  assert.equal(h.read().results[0].phase, 'generating')
  h.assembler.append(event('step/end', 3, { step: 1 }))
  assert.equal(h.read().results[0].phase, 'failed')
  h.assembler.append(event('turn/end', 4, { reason: { kind: 'cancelled' } }))
  assert.equal(h.read().results[0].document.javascript, '')
  const args = new PartialArguments()
  args.append(JSON.stringify({ ...doc, html: 'x'.repeat(200001) }))
  const rows = collectStreamResults([{ root: { phase: 'preparing', callId: 'huge', name: 'render_intelligent_ui', args, step: 1, subCalls: [] } }], { turn: 1, closed: false, closedSteps: [] })
  assert.equal(rows[0].phase, 'failed')
  assert.equal(rows[0].document.html, '')
  assert.equal(rows[0].document.javascript, '')
})

test('v2 chart metadata survives real DSH history replay and PTC projection without storing vendor code', () => {
  const h = setup()
  const chart = getTemplate('chart_line')
  h.assembler.append(event('tool/call', 3, { step: 1, callId: 'chart-root', name: 'render_intelligent_ui', arguments: JSON.stringify(chart) }))
  const result = event('tool/result', 4, { step: 1, message: { role: 'tool', source: { callId: 'chart-root' }, content: [], isError: false }, meta: { intelligentUi: chart } }, { surfaceOp: 'append' })
  h.assembler.append(JSON.parse(JSON.stringify(result)))
  assert.equal(h.read().results[0].document.version, 2)
  assert.deepEqual(Array.from(h.read().results[0].document.libraries), ['chartjs-4.5.1'])
  h.assembler.replaceWindow([JSON.parse(JSON.stringify(result))], false)
  assert.equal(h.read().results[0].phase, 'ready')
  assert.equal(h.read().results[0].document.version, 2)
  const nested = setup()
  nested.assembler.append(event('tool/call', 3, { step: 1, callId: 'code', name: 'run_code', arguments: '{}' }))
  nested.assembler.append({ type: 'event', event: { type: 'tool/ptc-dispatch', seq: 4, time: 4, data: {
    rootCallId: 'code', parentCallId: 'code', subCallId: 'code:chart', name: 'render_intelligent_ui', arguments: chart,
    isError: false, content: [], meta: { intelligentUi: chart },
  } } })
  assert.equal(nested.read().results[0].phase, 'ready')
  assert.equal(nested.read().results[0].document.version, 2)
  assert.deepEqual(Array.from(nested.read().results[0].document.libraries), ['chartjs-4.5.1'])
})

test('v3 saved image bytes and credits survive real DSH result-only history and PTC child replay', () => {
  const h = setup()
  const result = event('tool/result', 4, { step: 1, message: { role: 'tool', source: { callId: 'photo-root' }, content: [], isError: false },
    meta: { intelligentUi: imageDocument } }, { surfaceOp: 'append' })
  h.assembler.replaceWindow([event('turn/start', 1, {}), event('step/start', 2, { step: 1 }), JSON.parse(JSON.stringify(result))], false)
  assert.equal(h.read().results[0].phase, 'ready')
  assert.equal(h.read().results[0].document.images[0].dataUrl, imageDocument.images[0].dataUrl)
  assert.equal(h.read().results[0].document.images[0].creditUrl, imageDocument.images[0].creditUrl)
  const nested = setup()
  nested.assembler.append(event('tool/call', 3, { step: 1, callId: 'code', name: 'run_code', arguments: '{}' }))
  nested.assembler.append({ type: 'event', event: { type: 'tool/ptc-dispatch', seq: 4, time: 4, data: {
    rootCallId: 'code', parentCallId: 'code', subCallId: 'code:photo', name: 'render_intelligent_ui', arguments: {},
    isError: false, content: [], meta: { intelligentUi: imageDocument },
  } } })
  assert.equal(nested.read().results[0].document.version, 3)
  assert.equal(nested.read().results[0].document.images[0].license, 'CC0')
})
