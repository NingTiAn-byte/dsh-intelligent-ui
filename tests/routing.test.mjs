import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as plugin from '../lib/index.js'
import { ROUTE_TOOL, routeFromMeta, routingProjection } from '../lib/routing.js'

const document = { title: '演示计算器', description: '演示数据', html: '<p>合计84元</p>', css: '', javascript: '', height: 300 }
const table = { title: '演示预算', columns: ['项目', '金额（元）'], rows: [['甲', '84']], source: '用户的演示数据' }
const names = request => request.tools.map(tool => tool.name)
const renderNames = request => names(request).filter(name => ['render_intelligent_ui', 'render_intelligent_table', 'get_intelligent_ui_template'].includes(name)).sort()
const prompt = request => request.messages.filter(m => m.role === 'system').flatMap(m => m.content).filter(b => b.type === 'text').map(b => b.text).join('\n')
function text(text = '完成') { return [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text }, { type: 'block-end', index: 0, block: { type: 'text', text } }, { type: 'finish', reason: { kind: 'stop' } }] }
let callSerial = 0
function tool(name, args) {
  const id = ToolCallId(`routing-call-${++callSerial}`); const raw = JSON.stringify(args)
  return [{ type: 'block-start', index: 0, blockType: 'tool-call' }, { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: raw }, { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: raw } }, { type: 'finish', reason: { kind: 'tool-calls' } }]
}
class ScriptedModel extends LlmAdapter {
  requests = []; script = []
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(request) {
    this.requests.push(request)
    assert.ok(this.script.length, 'No hidden/unplanned classifier model call may occur')
    const item = this.script.shift()
    for (const chunk of typeof item === 'function' ? item(request) : item) yield chunk
  }
}
class ScriptedPtc extends PtcRuntime {
  language = 'typescript'; isolation = 'test'; behavior = async () => ({ logs: [] })
  resolve(request) { return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: 1000 } }
  run(spec) { return this.behavior(spec) }
}
async function setup(config = {}, mode = 'native') {
  const ctx = new Context(); const model = new ScriptedModel()
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode })
  if (mode === 'ptc') await ctx.plugin(ScriptedPtc)
  if (mode === 'ptc') ctx.provide('workingDirectory', { async ensure() { return process.cwd() } })
  await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['routing-offline'], model)
  const fiber = ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900, ...config }); await fiber
  const events = new Map()
  ctx.on('session/event', (session, event) => { const rows = events.get(session.id) ?? []; rows.push(event); events.set(session.id, rows) })
  async function create(id) { return ctx.agentLoop.create(SessionId(id), { provider: 'routing-offline', model: 'scripted' }) }
  async function send(agent, value, source = { kind: 'user' }) {
    const message = createUserMessage({ content: [{ type: 'text', text: value }], source })
    agent.followup(message); await agent.whenIdle(); return message
  }
  return { ctx, model, fiber, create, send, events }
}
const select = presentation => tool(ROUTE_TOOL, { presentation, reason: `用户明确请求 ${presentation}` })
const outcomes = (h, agent) => (h.events.get(agent.id) ?? []).filter(e => e.type === 'tool/result')

test('real DSH loop answers a simple question directly in text with no visual or classifier call', { timeout: 15000 }, async () => {
  const h = await setup()
  try {
    const agent = await h.create('routing-text')
    h.model.script.push(request => { assert.deepEqual(renderNames(request), []); assert.ok(names(request).includes(ROUTE_TOOL)); assert.match(prompt(request), /explicit output format/); return text('2') })
    await h.send(agent, '1+1是多少？只用文字回答。')
    assert.equal(h.model.requests.length, 1); assert.equal(outcomes(h, agent).length, 0)
  } finally { await h.ctx.fiber.dispose() }
})

test('real DSH loop selects table, limits schemas, executes and logs persistent table metadata', { timeout: 15000 }, async () => {
  const h = await setup()
  try {
    const agent = await h.create('routing-table')
    h.model.script.push(request => { assert.deepEqual(renderNames(request), []); return select('table') }, request => {
      assert.deepEqual(renderNames(request), ['render_intelligent_table']); assert.match(prompt(request), /presentation: table/)
      return tool('render_intelligent_table', table)
    }, text())
    const message = await h.send(agent, '请把甲84元列成只读表格，不要交互图表。')
    const results = outcomes(h, agent)
    assert.equal(results.length, 2); assert.equal(results.every(e => !e.data.message.isError), true)
    assert.equal(results[0].data.meta.intelligentUiRoute.messageId, message.id)
    assert.equal(results[1].data.meta.intelligentTable.rows[0][1], '84')
    assert.equal(h.model.requests.length, 3)
  } finally { await h.ctx.fiber.dispose() }
})

test('UI route permits template and rendering while denying a model attempt to use the wrong table tool', { timeout: 15000 }, async () => {
  const h = await setup()
  try {
    const agent = await h.create('routing-ui')
    h.model.script.push(select('ui'), request => {
      assert.deepEqual(renderNames(request), ['get_intelligent_ui_template', 'render_intelligent_ui'])
      return tool('render_intelligent_table', table)
    }, request => {
      assert.ok(request.messages.some(m => m.role === 'tool' && m.isError)); return tool('get_intelligent_ui_template', { template: 'calculator' })
    }, tool('render_intelligent_ui', document), text())
    await h.send(agent, '请生成一个带输入控件的计算器。')
    const results = outcomes(h, agent)
    assert.equal(results[1].data.message.isError, true)
    assert.equal(results[1].data.meta?.intelligentTable, undefined)
    assert.equal(results.at(-1).data.meta.intelligentUi.title, document.title)
  } finally { await h.ctx.fiber.dispose() }
})

test('mixed route supports explicit table plus chart requests without switching the same-message route', { timeout: 15000 }, async () => {
  const h = await setup()
  try {
    const agent = await h.create('routing-mixed')
    h.model.script.push(select('mixed'), request => {
      assert.equal(renderNames(request).length, 3); return tool('render_intelligent_table', table)
    }, tool('render_intelligent_ui', document), text())
    await h.send(agent, '请同时给我一份结构化表格和一个交互图表。')
    assert.equal(outcomes(h, agent).filter(e => e.data.meta?.intelligentUiRoute).length, 1)
    assert.equal(outcomes(h, agent).filter(e => e.data.meta?.intelligentTable || e.data.meta?.intelligentUi).length, 2)
  } finally { await h.ctx.fiber.dispose() }
})

test('route locks across continuations, ignores background context and resets for new and repeated user messages', { timeout: 15000 }, async () => {
  const h = await setup()
  try {
    const agent = await h.create('routing-lock')
    h.model.script.push(select('table'), select('ui'), text())
    const first = await h.send(agent, '给我表格')
    assert.equal(outcomes(h, agent)[1].data.message.isError, true)
    h.model.script.push(request => { assert.deepEqual(renderNames(request), ['render_intelligent_table']); return text() })
    await h.send(agent, '后台上下文，不改变展示形式', { kind: 'routing-test-context' })
    h.model.script.push(request => { assert.deepEqual(renderNames(request), []); return select('ui') }, text())
    const second = await h.send(agent, '改为计算器')
    assert.notEqual(first.id, second.id)
    h.model.script.push(request => { assert.deepEqual(renderNames(request), []); return select('text') }, text())
    const third = await h.send(agent, '改为计算器')
    const state = h.ctx.sessionProjections.stateOf(agent.session, 'intelligentUiRouting')
    assert.equal(state.messageId, third.id); assert.notEqual(second.id, third.id); assert.equal(state.decision.presentation, 'text')
  } finally { await h.ctx.fiber.dispose() }
})

test('invalid/cancelled selection has visible errors and permits text recovery; other DSH tools are preserved', { timeout: 15000 }, async () => {
  const h = await setup()
  try {
    h.ctx.tools.register(defineTool({ name: 'business_lookup', description: 'Fixture data lookup', parameters: {}, output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] }, async execute() { return '84' } }))
    const agent = await h.create('routing-invalid')
    h.model.script.push(request => { assert.ok(names(request).includes('business_lookup')); return tool(ROUTE_TOOL, { presentation: 'missing', reason: '' }) }, request => {
      assert.deepEqual(renderNames(request), []); assert.ok(request.messages.some(m => m.role === 'tool' && m.isError)); return tool('business_lookup', {})
    }, text('展示形式未确定，先用文字说明：84元。'))
    await h.send(agent, '输出数据')
    assert.equal(outcomes(h, agent)[0].data.message.isError, true)
    assert.equal(h.ctx.sessionProjections.stateOf(agent.session, 'intelligentUiRouting').decision, null)
    const stop = h.ctx.on('tools/pre-execute', async (exec, next) => exec.name === ROUTE_TOOL ? { kind: 'cancel' } : next())
    h.model.script.push(select('table'), text('展示选择被取消，本次使用文字。'))
    await h.send(agent, '重新列出')
    stop()
    assert.equal(outcomes(h, agent).at(-1).data.message.isError, true)
    assert.equal(h.ctx.sessionProjections.stateOf(agent.session, 'intelligentUiRouting').decision, null)
  } finally { await h.ctx.fiber.dispose() }
})

test('sessions are isolated, durable native/PTC metadata restores selection, plugin unload removes masks and routing tool', { timeout: 15000 }, async () => {
  const h = await setup()
  try {
    const a = await h.create('routing-A'); const b = await h.create('routing-B')
    h.model.script.push(select('table'), text()); await h.send(a, '表格')
    h.model.script.push(select('ui'), text()); await h.send(b, '图表')
    assert.deepEqual(h.ctx.tools.schemas(a).filter(t => t.name.startsWith('render_intelligent')).map(t => t.name), ['render_intelligent_table'])
    assert.deepEqual(h.ctx.tools.schemas(b).filter(t => t.name.startsWith('render_intelligent')).map(t => t.name).sort(), ['render_intelligent_ui', 'render_intelligent_map', 'render_intelligent_chart', 'render_intelligent_workflow'].sort())
    const events = JSON.parse(JSON.stringify(h.events.get(a.id)))
    const restored = Session.create(SessionId('restored'), events)
    assert.equal(h.ctx.sessionProjections.stateOf(restored, 'intelligentUiRouting').decision.presentation, 'table')
    let state = routingProjection.init()
    const user = events.find(e => e.type === 'user/message' && e.data.source.kind === 'user')
    state = routingProjection.apply(state, user)
    const decision = { version: 1, messageId: state.messageId, presentation: 'ui', reason: 'PTC route' }
    state = routingProjection.apply(state, { type: 'tool/ptc-dispatch', data: { name: ROUTE_TOOL, isError: false, meta: { intelligentUiRoute: decision } } })
    assert.equal(state.decision.presentation, 'ui')
    const same = routingProjection.apply(state, { type: 'tool/ptc-dispatch', data: { name: ROUTE_TOOL, isError: false, meta: { intelligentUiRoute: { ...decision, presentation: 'table' } } } })
    assert.equal(same, state)
    await h.fiber.dispose()
    assert.equal(h.ctx.tools.schemas(a).some(t => t.name === ROUTE_TOOL), false)
    assert.equal(h.ctx.sessionProjections.stateOf(a.session, 'intelligentUiRouting'), undefined)
    // Reload after the original agent exists: recover its table selection from persisted metadata.
    const reload = h.ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900 }); await reload
    assert.deepEqual(h.ctx.tools.schemas(a).filter(t => t.name.startsWith('render_intelligent')).map(t => t.name), ['render_intelligent_table'])
  } finally { await h.ctx.fiber.dispose() }
})

test('route metadata rejects unknown versions, missing or invalid fields; lower-level agentless rendering and off mode stay usable', { timeout: 15000 }, async () => {
  assert.equal(routeFromMeta({ intelligentUiRoute: { version: 2, messageId: 'x', presentation: 'ui', reason: 'x' } }), null)
  assert.equal(routeFromMeta({ intelligentUiRoute: { version: 1, messageId: 'x', presentation: 'bad', reason: 'x' } }), null)
  const h = await setup({ routing: 'off' })
  try {
    const agent = await h.create('routing-off')
    h.model.script.push(request => { assert.equal(renderNames(request).length, 3); assert.equal(names(request).includes(ROUTE_TOOL), false); return tool('render_intelligent_table', table) }, text())
    await h.send(agent, '表格')
    assert.equal(outcomes(h, agent)[0].data.message.isError, false)
  } finally { await h.ctx.fiber.dispose() }
})

test('real PTC dispatch updates the SDK between model steps, persists its route and never exposes disallowed functions', { timeout: 15000 }, async () => {
  const h = await setup({}, 'ptc')
  try {
    const agent = await h.create('routing-ptc')
    let programs = 0
    h.ctx.ptcRuntime.behavior = async spec => {
      const functions = spec.bindings[0].functions
      const assembly = await h.ctx.systemPrompt.assemble({ agent, scope: agent })
      const sdk = assembly.sections.find(s => s.name === 'tools:sdk').text
      if (programs++ === 0) {
        assert.ok(functions[ROUTE_TOOL]); assert.equal(functions.render_intelligent_table, undefined)
        assert.equal(functions.render_intelligent_map, undefined); assert.equal(functions.render_intelligent_chart, undefined)
        assert.equal(functions.render_intelligent_ui, undefined); assert.doesNotMatch(sdk, /^\s+render_intelligent_table:/m)
        const value = await functions[ROUTE_TOOL]({ presentation: 'table', reason: '用户要求普通表格' })
        assert.equal(value.presentation, 'table')
        assert.equal(functions.render_intelligent_table, undefined, 'An existing program keeps its original SDK snapshot')
        return { logs: [], value }
      }
      assert.ok(functions.render_intelligent_table); assert.equal(functions.render_intelligent_ui, undefined)
      assert.match(sdk, /^\s+render_intelligent_table:/m); assert.doesNotMatch(sdk, /^\s+render_intelligent_ui:/m)
      return { logs: [], value: await functions.render_intelligent_table(table) }
    }
    h.model.script.push(request => { assert.deepEqual(names(request), ['run_code']); return tool('run_code', { code: 'return await tools.select_intelligent_ui_presentation({presentation:"table",reason:"用户要求普通表格"})', description: '选择展示方式' }) },
      tool('run_code', { code: 'return await tools.render_intelligent_table(data)', description: '展示结构化表格' }), text())
    await h.send(agent, '将数据列为表格')
    assert.equal(programs, 2)
    assert.equal(outcomes(h, agent).every(e => !e.data.message.isError), true, JSON.stringify(outcomes(h, agent).map(e => e.data.message.content)))
    const nested = h.events.get(agent.id).filter(e => e.type === 'tool/ptc-dispatch')
    assert.equal(nested[0].data.meta.intelligentUiRoute.presentation, 'table')
    assert.equal(nested[1].data.meta.intelligentTable.title, table.title)
    const restored = Session.create(SessionId('ptc-restored'), JSON.parse(JSON.stringify(h.events.get(agent.id))))
    assert.equal(h.ctx.sessionProjections.stateOf(restored, 'intelligentUiRouting').decision.presentation, 'table')
  } finally { await h.ctx.fiber.dispose() }
})

test('monotonic routing guard rejects even scoped tool shadows and an allow policy, while cancelled final selections can retry', { timeout: 15000 }, async () => {
  const h = await setup()
  try {
    const agent = await h.create('routing-guard')
    h.model.script.push(select('text'), text()); await h.send(agent, '不要生成界面，只解释')
    let scope
    let ran = false
    await h.ctx.plugin({ inject: ['tools'], apply: context => {
      scope = createScope(context, agent)
      scope.ctx.tools.register(defineTool({ name: 'render_intelligent_ui', description: 'Scoped shadow fixture', parameters: {}, output: { schema: { type: 'string' }, render: (_a, value) => [{ type: 'text', text: value }] }, async execute() { ran = true; return 'should not run' } }))
    } })
    const stop = h.ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    const denied = await h.ctx.tools.execute({ agent, callId: ToolCallId('guard-probe'), name: 'render_intelligent_ui', arguments: {}, signal: new AbortController().signal })
    assert.equal(denied.isError, true); assert.equal(ran, false)
    assert.match(denied.content[0].text, /route text/)
    stop(); await scope.dispose()
    let blockOnce = true
    const post = h.ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.name !== ROUTE_TOOL || !blockOnce) return next()
      blockOnce = false; return { kind: 'block', feedback: [{ type: 'text', text: 'Fixture final rejection; continue in text or retry.' }] }
    })
    h.model.script.push(select('ui'), tool(ROUTE_TOOL, { presentation: 'table', reason: 'retry after failed selection', messageId: 'forged', version: 1 }), text())
    const user = await h.send(agent, '重新选择展示')
    post()
    const state = h.ctx.sessionProjections.stateOf(agent.session, 'intelligentUiRouting')
    assert.equal(state.decision.presentation, 'table'); assert.equal(state.decision.messageId, user.id)
    assert.equal(outcomes(h, agent).at(-2).data.message.isError, true)
  } finally { await h.ctx.fiber.dispose() }
})
