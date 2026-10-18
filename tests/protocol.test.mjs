import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFrameMessage } from '../lib/protocol.js'

test('frame protocol rejects foreign/stale sources and bounds untrusted reports', () => {
  const source = {}; const channel = 'current'
  const parse = data => parseFrameMessage({ source, data: { ...data, channel } }, source, channel)
  assert.equal(parseFrameMessage({ source: {}, data: { channel, kind: 'ready' } }, source, channel), null)
  assert.equal(parseFrameMessage({ source, data: { channel: 'old', kind: 'resize', height: 300 } }, source, channel), null)
  for (const height of [NaN, Infinity, -1, 0, '400']) assert.equal(parse({ kind: 'resize', height }), null)
  assert.deepEqual(parse({ kind: 'resize', height: 12 }), { kind: 'resize', height: 180 })
  assert.deepEqual(parse({ kind: 'resize', height: 90000 }), { kind: 'resize', height: 4000 })
  assert.equal(parse({ kind: 'runtime-error', phase: 'script', message: 'x'.repeat(2001) }), null)
  assert.equal(parse({ kind: 'runtime-error', phase: 'invented', message: 'error' }), null)
  assert.equal(parse({ kind: 'prompt', requestId: 'request-1', value: '  ' }), null)
  assert.equal(parse({ kind: 'prompt', requestId: {}, value: 'text' }), null)
  assert.equal(parse({ kind: 'link', requestId: 'request-1', value: 'https://user:password@example.com' }), null)
  assert.equal(parse({ kind: 'link', requestId: 'request-1', value: 'http://example.com' }), null)
  assert.equal(parse({ kind: 'prompt', requestId: 'request-1', value: '  explain  ' }).value, 'explain')
})
