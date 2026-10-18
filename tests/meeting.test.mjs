import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId, Session } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import * as plugin from '../lib/index.js'
import { parseDocument } from '../lib/document.js'
const args = { title: '项目评审', timezone: 'Asia/Hong_Kong', durationMinutes: 30, slots: ['2026-10-20T10:00:00+08:00', '2026-10-20T15:00:00+08:00'] }
class Model extends LlmAdapter {
  count = 0
  resolveModel(provider, id) { return Promise.resolve({ provider, id, name: id }) }
  async *stream() {
    if (this.count++ === 0) {
      const id = ToolCallId('meeting-call'), raw = JSON.stringify(args)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }; yield { type: 'tool-call-delta', index: 0, id, name: 'choose_intelligent_meeting_time', argumentsDelta: raw }; yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'choose_intelligent_meeting_time', arguments: raw } }; yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text: '收到选择' }; yield { type: 'block-end', index: 0, block: { type: 'text', text: '收到选择' } }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}
let serial = 0
async function setup() {
  const ctx = new Context(); const model = new Model(); const events = []
  for (const p of [LlmRuntime, Sessions, SessionProjectionRegistry, Tools, SystemPrompt, AgentRegistry]) await ctx.plugin(p)
  await ctx.plugin(AgentLoop, { agents: [] }); await ctx.plugin(UserQuestions)
  ctx.llm.registerAdapter(['meeting-offline'], model)
  await ctx.plugin(plugin, { maxDocumentChars: 200000, minHeight: 180, maxHeight: 900, routing: 'off' })
  ctx.on('session/event', (_session, e) => events.push(e))
  const agent = await ctx.agentLoop.create(SessionId(`meeting-${++serial}`), { provider: 'meeting-offline', model: 'scripted' })
  const call = (arguments_, signal = new AbortController().signal) => ctx.tools.execute({ callId: 'meeting-direct', name: 'choose_intelligent_meeting_time', arguments: arguments_, agent, signal })
  return { ctx, agent, model, events, call }
}
test('real DSH AgentLoop waits for actual human-question answer, persists selected slot and resumes its own model turn', { timeout: 10000 }, async () => {
  const h = await setup(); let asked = false, answer
  h.ctx.on('user-questions/request', request => { asked = true; assert.equal(request.agent, h.agent); assert.equal(request.questions[0].options.length, 3); return new Promise(resolve => { answer = () => resolve({ answers: [{ id: 'meeting', selected: [request.questions[0].options[1].label] }] }) }) })
  try {
    h.agent.followup(createUserMessage({ content: [{ type: 'text', text: '选会议时间' }], source: { kind: 'user' } }))
    while (!asked) await new Promise(r => setTimeout(r, 5))
    assert.equal(h.model.count, 1); assert.equal(h.events.filter(e => e.type === 'tool/result').length, 0)
    answer(); await h.agent.whenIdle(); assert.equal(h.model.count, 2)
    const result = h.events.find(e => e.type === 'tool/result'); assert.equal(result.data.message.isError, false)
    assert.equal(result.data.meta.intelligentMeeting.status, 'selected'); assert.equal(result.data.meta.intelligentMeeting.selected, args.slots[1]); assert.equal(result.data.meta.intelligentMeeting.calendarBooked, false); assert.ok(parseDocument(result.data.meta.intelligentUi))
    const saved = Session.create(SessionId('meeting-replay'), JSON.parse(JSON.stringify(h.events))); assert.ok(saved)
  } finally { await h.ctx.fiber.dispose() }
})
test('meeting rejection, custom response, explicit cancellation and caller abort never produce a booked slot', { timeout: 10000 }, async () => {
  for (const kind of ['declined', 'custom', 'cancelled', 'aborted']) {
    const h = await setup(); const abort = new AbortController()
    h.ctx.on('user-questions/request', () => {
      if (kind === 'cancelled') throw Object.assign(new Error('cancelled'), { name: 'UserQuestionError', code: 'ASK_CANCELLED' })
      if (kind === 'aborted') { abort.abort(); throw new Error('abort') }
      return Promise.resolve({ answers: [{ id: 'meeting', selected: kind === 'declined' ? ['这些时间都不合适'] : [], ...(kind === 'custom' ? { custom: '请改为下周' } : {}) }] })
    })
    try {
      const result = await h.call(args, abort.signal)
      if (kind === 'aborted') { assert.equal(result.isError, true); assert.equal(result.meta?.intelligentMeeting, undefined) }
      else { assert.equal(result.isError, false, JSON.stringify(result)); const value = JSON.parse(result.value); assert.equal(value.status, kind); assert.equal(value.calendarBooked, false); assert.equal(value.selected, undefined) }
    } finally { await h.ctx.fiber.dispose() }
  }
})
test('meeting validates dates, timezone, duplicate times and durations before asking', async () => {
  const h = await setup(); let asks = 0; h.ctx.on('user-questions/request', () => { asks++; throw new Error('must not ask') })
  try {
    for (const change of [{ timezone: 'Invalid/Zone' }, { durationMinutes: 0 }, { slots: [args.slots[0], args.slots[0]] }, { slots: ['tomorrow', 'friday'] }, { slots: ['2026-02-30T10:00:00+08:00', args.slots[1]] }, { timeoutSeconds: 0 }]) assert.equal((await h.call({ ...args, ...change })).isError, true)
    assert.equal(asks, 0)
  } finally { await h.ctx.fiber.dispose() }
})
test('meeting timeout closes the native wait without fabricating a choice', { timeout: 35000 }, async () => {
  const h = await setup()
  h.ctx.on('user-questions/request', request => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('native wait ended')), { once: true })))
  try {
    const result = await h.call({ ...args, timeoutSeconds: 30 }); assert.equal(result.isError, false); assert.equal(JSON.parse(result.value).status, 'timeout'); assert.equal(result.meta.intelligentMeeting.selected, undefined)
  } finally { await h.ctx.fiber.dispose() }
})
