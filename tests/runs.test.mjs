import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as plugin from '../lib/index.js'
import { runsProjection } from '../lib/runs.js'
import { runRpcId, parseRunRpcId, parseRunStatus, MAX_RUN_RECORDS, RUN_KEY } from '../lib/run-protocol.js'

const response = [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: '解释完成' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '解释完成' } }, { type: 'finish', reason: { kind: 'stop' } }]
class ScriptedModel extends LlmAdapter {
  behavior = async function* () { yield* response }
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  stream(request) { return this.behavior(request) }
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
function message(id, callId = 'ui-A') {
  return createUserMessage({ content: [{ type: 'text', text: '相同的追问文本' }], source: { kind: 'user', rpcId: runRpcId(callId, id) } })
}
async function setup() {
  const ctx = new Context(); const model = new ScriptedModel()
  await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['runs-offline'], model)
  const fiber = ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900 }); await fiber
  const events = new Map()
  ctx.on('session/event', (session, event) => { const rows = events.get(session.id) ?? []; rows.push(event); events.set(session.id, rows) })
  return { ctx, model, fiber, events, create: id => ctx.agentLoop.create(SessionId(id), { provider: 'runs-offline', model: 'scripted' }),
    rows: agent => ctx.sessionProjections.snapshot(agent.session, [RUN_KEY]).values[RUN_KEY].runs }
}

test('real DSH loop associates two identical queued prompts with their own message and turn, ignoring unrelated work', async () => {
  const h = await setup()
  try {
    const entered = deferred(); const release = deferred(); let count = 0
    h.model.behavior = async function* () { if (++count === 1) { entered.resolve(); await release.promise } yield* response }
    const agent = await h.create('run-queue')
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'unrelated' }], source: { kind: 'user' } }))
    await entered.promise
    const first = message('request-1'); const second = message('request-2')
    agent.followup(first); agent.followup(second)
    assert.deepEqual(h.rows(agent).map(r => r.status), ['queued', 'queued'])
    release.resolve(); await agent.whenIdle()
    const rows = h.rows(agent)
    assert.deepEqual(rows.map(r => [r.requestId, r.messageId, r.turn, r.status]), [
      ['request-1', first.id, 2, 'completed'], ['request-2', second.id, 3, 'completed']])
    assert.ok(rows.every(r => r.modelCompleted)); assert.equal(count, 3)
  } finally { await h.ctx.fiber.dispose() }
})

test('real DSH failures and cancellation report only the matched running request; queue removal never completes', async () => {
  const h = await setup()
  try {
    const agent = await h.create('run-error')
    h.model.behavior = async function* () { throw new Error('controlled model failure') }
    agent.followup(message('error')); await agent.whenIdle()
    assert.equal(h.rows(agent)[0].status, 'failed')
    const entered = deferred(); const release = deferred()
    h.model.behavior = async function* (request) {
      entered.resolve()
      await Promise.race([release.promise, new Promise(resolve => request.signal.addEventListener('abort', resolve, { once: true }))])
      request.signal.throwIfAborted(); yield* response
    }
    agent.followup(message('stop')); await entered.promise
    const removed = message('remove'); agent.followup(removed); agent.inbox.remove(removed.id)
    await agent.cancel({ kind: 'user' }); release.resolve(); await agent.whenIdle()
    assert.deepEqual(h.rows(agent).map(r => [r.requestId, r.status, r.modelCompleted]), [
      ['error', 'failed', false], ['stop', 'cancelled', false], ['remove', 'cancelled', false]])
  } finally { await h.ctx.fiber.dispose() }
})

test('two live sessions and plugin reload reconstruct statuses from durable events with no cross-session receipt', async () => {
  const h = await setup()
  try {
    const a = await h.create('run-session-a'); const b = await h.create('run-session-b')
    a.followup(message('same-id')); b.followup(message('same-id'))
    await Promise.all([a.whenIdle(), b.whenIdle()])
    assert.notEqual(h.rows(a)[0].messageId, h.rows(b)[0].messageId)
    const expected = h.rows(a)
    await h.fiber.dispose()
    assert.equal(h.ctx.sessionProjections.snapshot(a.session, [RUN_KEY]).values[RUN_KEY], undefined)
    await h.ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900 })
    assert.deepEqual(h.rows(a), expected)
    const state = (h.events.get(a.id) ?? []).reduce((state, event) => runsProjection.apply(state, event), runsProjection.init())
    assert.deepEqual(runsProjection.wire.view(state).runs, expected)
  } finally { await h.ctx.fiber.dispose() }
})

function fold() {
  let state = runsProjection.init(); let seq = 0
  return { event(type, data) { state = runsProjection.apply(state, { type, data, seq: seq++, time: seq }); runsProjection.stateSchema.parse(state); return state },
    rows: () => runsProjection.wire.view(state).runs }
}
function insert(h, m) { h.event('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [m] }) }
function claim(h, turn = 1) {
  h.event('turn/start', { turn }); h.event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] })
}
test('claim rewritten by a pre-step hook cannot be credited as completed; crash and token limits stay non-success', () => {
  for (const [reason, expected] of [[{ kind: 'completed' }, 'unknown'], [{ kind: 'interrupted' }, 'unknown'],
    [{ kind: 'forked' }, 'unknown'], [{ kind: 'max-tokens' }, 'failed'], [{ kind: 'blocked' }, 'failed']]) {
    const h = fold(); insert(h, message('rewritten')); claim(h)
    // A step can run other context while the claimed prompt was removed from its input.
    h.event('step/start', { turn: 1, step: 1 }); h.event('turn/end', { turn: 1, reason })
    assert.equal(h.rows()[0].status, expected); assert.equal(h.rows()[0].modelCompleted, false)
  }
})
test('queue edits preserve correlation and steering reinsertion revives a removed occurrence under its exact identity', () => {
  const h = fold(); const m = message('edited'); insert(h, m)
  h.event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, outcome: 'canceled', inserted: [{ ...m, content: [{ type: 'text', text: 'edited' }] }] })
  assert.equal(h.rows()[0].status, 'queued')
  h.event('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, outcome: 'canceled', inserted: [] })
  assert.equal(h.rows()[0].status, 'cancelled')
  h.event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [m] })
  h.event('turn/start', { turn: 2 })
  h.event('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] })
  h.event('step/start', { turn: 2, step: 1 }); h.event('user/message', m)
  h.event('turn/end', { turn: 99, reason: { kind: 'completed' } })
  assert.equal(h.rows()[0].status, 'running')
  h.event('turn/end', { turn: 2, reason: { kind: 'completed' } })
  assert.equal(h.rows()[0].status, 'completed')
})
test('protocol versions, malformed identities, and non-user sources cannot establish false associations; retention is bounded', () => {
  const id = runRpcId('ui:with-colon', 'request:1'); assert.deepEqual(parseRunRpcId(id), { callId: 'ui:with-colon', requestId: 'request:1' })
  for (const value of ['', 'iui-run-v2:[]', 'iui-run-v1:%', 'iui-run-v1:[]', 'iui-run-v1:' + 'x'.repeat(4000)]) assert.equal(parseRunRpcId(value), null)
  const h = fold()
  for (let i = 0; i < MAX_RUN_RECORDS + 10; i++) {
    const m = message(`r-${i}`); insert(h, m); claim(h, i + 1)
    h.event('step/start', { turn: i + 1, step: 1 }); h.event('user/message', m); h.event('turn/end', { turn: i + 1, reason: { kind: 'completed' } })
  }
  assert.equal(h.rows().length, MAX_RUN_RECORDS); assert.equal(h.rows()[0].requestId, 'r-10')
  assert.ok(h.rows().every(row => parseRunStatus(row)))
  assert.equal(parseRunStatus({ ...h.rows()[0], status: 'failed', modelCompleted: true }), null)
  assert.equal(parseRunStatus({ ...h.rows()[0], version: 2 }), null)
  const baseline = h.rows().length
  insert(h, { ...message('background'), source: { kind: 'context' } }); assert.equal(h.rows().length, baseline)
})
