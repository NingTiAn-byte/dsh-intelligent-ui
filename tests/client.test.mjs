import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
const sharedRequire = createRequire(import.meta.url)

test('DSH factory keeps the iframe outside process cards and binds results to the correct session and turn', async () => {
  let registration
  const requested = []
  const window = { __ModuleLoader__: { load: row => { registration = row } } }
  runInNewContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), { window, queueMicrotask })
  assert.equal(registration.id, 'dsh-intelligent-ui')
  const plugin = registration.factory(name => { requested.push(name); return sharedRequire(name) })
  assert.ok(requested.includes('react'))
  const sends = []; const locales = []; const entries = []; const reads = []; const definitions = []
  let theme = { active: { id: 'custom-light', colorScheme: 'light', tokens: {} }, fontSizes: { text: 14 }, fontFamilies: { text: '' }, revision: 0 }
  const themeListeners = new Set()
  const scopes = new Map()
  const roots = []
  for (const id of ['session-A', 'session-B']) {
    const root = new Context()
    roots.push(root)
    await root.plugin({ name: 'conversation-provider', apply: provider => {
      provider.provide('conversation', { send: async text => { sends.push({ id, text }) } })
    } })
    await root.plugin({ name: 'session-scope', apply: scoped => { scopes.set(id, scoped) } })
  }
  // Reproduce Cordis's guard rather than accepting a plain-object fake scope.
  assert.throws(() => scopes.get('session-A').conversation, /without inject/)
  const ctx = {
    theme: { getTheme: () => theme, setTheme: preference => { theme = { ...theme, preference }; themeListeners.forEach(listener => listener(theme)) } },
    on: (event, listener) => { assert.equal(event, 'theme/change'); themeListeners.add(listener); return () => themeListeners.delete(listener) },
    sessions: { scope: id => scopes.get(id), binding: id => scopes.has(id) ? { id, session: {
      prompt: async (content, mode, _signal, rpcId) => { sends.push({ id, text: content[0].text, mode, rpcId }); return { ok: true, value: { accepted: true } } },
      projections: { faceOf: key => ({ getSnapshot: () => { assert.equal(key, 'intelligentUiRuns'); return { version: 1, runs: [] } }, subscribe: () => () => {} }) },
    } } : undefined },
    uiConversation: { events: { register: definition => { definitions.push(definition); return () => {} } }, binding: binding => ({ target: target => {
      assert.equal(target, 'chat')
      return { getSnapshot: () => ({ nodes: { turnDataSource: (turn, kind) => {
        reads.push({ id: binding.id, turn, kind }); return { getSnapshot: () => [] }
      } } }) }
    } }) },
    locale: { register: (ns, dict) => { locales.push(ns); assert.ok(dict.zh.send); return () => {} } },
    effect: fn => fn(),
    slots: { inject: (_name, fn) => fn(), register: (definition, component) => { entries.push({ definition, component }); return () => {} } },
  }
  try {
    plugin.apply(ctx)
    assert.deepEqual(locales, ['intelligentUi'])
    const tool = entries.find(entry => entry.definition.name === 'tool.call.toolview')
    const entry = entries.find(entry => entry.definition.name === 'conversation.chat.node')
    assert.equal(tool.definition.key, 'render_intelligent_ui')
    assert.equal(tool.definition.inject, undefined)
    assert.equal(entry.definition.key, 'intelligent-ui')
    assert.equal(definitions[0].kind, 'intelligent-ui')
    assert.equal(entries.some(entry => entry.definition.name === 'conversation.chat.turnTail'), false)
    assert.ok(plugin.inject.includes('theme'))
    const themeSource = entry.definition.inject('session-A').hooks.theme
    entry.definition.inject('session-A').setTheme('dark')
    assert.equal(theme.preference, 'dark', 'widget control uses the actual DSH theme service')
    assert.equal(themeSource.getSnapshot(), theme)
    let themeChanges = 0
    const stopTheme = themeSource.subscribe(() => { themeChanges++ })
    theme = { ...theme, active: { ...theme.active, colorScheme: 'dark' }, revision: 1 }
    themeListeners.forEach(listener => listener(theme))
    await Promise.resolve()
    assert.equal(themeSource.getSnapshot().active.colorScheme, 'dark')
    assert.equal(themeChanges, 1)
    stopTheme(); assert.equal(themeListeners.size, 0)
    await entry.definition.inject('session-A').sendPrompt('explain this', 'request-A', 'call-A')
    await entry.definition.inject('session-B').sendPrompt('another session', 'request-B', 'call-B')
    assert.deepEqual(entry.definition.inject('session-A').hooks.runs.getSnapshot(), { version: 1, runs: [] })
    entry.definition.inject('session-A').keyedHooks.results('2')
    entry.definition.inject('session-B').keyedHooks.results('3')
    assert.deepEqual(reads, [{ id: 'session-A', turn: 2, kind: 'tool-call' }, { id: 'session-B', turn: 3, kind: 'tool-call' }])
    const { runRpcId } = await import('../lib/run-protocol.js')
    assert.deepEqual(sends, [{ id: 'session-A', text: 'explain this', mode: 'queue', rpcId: runRpcId('call-A', 'request-A') },
      { id: 'session-B', text: 'another session', mode: 'queue', rpcId: runRpcId('call-B', 'request-B') }])
    assert.throws(() => entry.definition.inject('missing'), /scope is unavailable/)
    assert.throws(() => plugin.apply({ ...ctx, sessions: undefined }), /sessions service/)
    const document = { version: 1, title: 'test', description: '', html: '<p>ok</p>', css: '', javascript: '', height: 300 }
    const result = (callId, extra = {}) => ({ kind: 'tool-result', callId, name: 'render_intelligent_ui', meta: { intelligentUi: document }, isError: false, subCalls: [], ...extra })
    const nodes = [
      { root: result('a') }, { root: result('a') },
      { root: result('parent', { name: 'ptc', subCalls: [result('b')] }) },
      { root: result('failed', { isError: true }) },
      { root: result('invalid', { meta: { intelligentUi: { ...document, version: 2 } } }) },
      { root: { phase: 'start', name: 'render_intelligent_ui', subCalls: [] } },
    ]
    assert.deepEqual(Array.from(plugin.collectResults(nodes), item => item.callId), ['a', 'b'])
    assert.deepEqual(Array.from(plugin.collectResults([])), [])
  } finally { await Promise.all(roots.map(root => root.fiber.dispose())) }
})
