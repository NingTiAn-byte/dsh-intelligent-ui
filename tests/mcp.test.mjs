import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { assembleDocument } from '../lib/mcp-server.js'
import { getTemplate } from '../lib/templates.js'
import { parseDocument } from '../lib/document.js'
import { document as photo } from './image-fixture.mjs'
import { root } from '../scripts/environment.mjs'
import { join } from 'node:path'

test('standalone assembler reuses tokenizer, theme, CSP, library and saved-image boundaries without running scripts', () => {
  const template = { ...getTemplate('calculator'), html: '<img src="https://evil.invalid/x" onerror="globalThis.bad=1"><script>globalThis.bad=1</script><p>safe</p>' }
  const r = assembleDocument(template, 'dark'); assert.match(r.html, /data-iui-theme="dark"/); assert.ok(!r.html.includes('onerror=')); assert.ok(!r.html.includes('https://evil.invalid')); assert.equal(globalThis.bad, undefined)
  assert.throws(() => assembleDocument({ ...template, version: 99 })); assert.throws(() => assembleDocument({ ...photo, images: [{ ...photo.images[0], dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' }] }))
  assert.ok(assembleDocument(photo).html.includes(photo.images[0].dataUrl))
})
test('real SDK stdio client initializes, discovers resources/prompts, assembles templates/maps/charts and rejects invalid input', { timeout: 30000 }, async () => {
  const client = new Client({ name: 'intelligent-ui-test', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'lib/mcp-stdio.js')], cwd: root, stderr: 'pipe' })
  const stderr = []; transport.stderr?.on('data', d => stderr.push(String(d)))
  try {
    await client.connect(transport)
    const resources = await client.listResources(); assert.ok(resources.resources.some(r => r.uri === 'intelligent-ui://theme')); assert.ok(resources.resources.some(r => r.uri === 'intelligent-ui://templates/calculator'))
    const skills = await client.readResource({ uri: 'skills://list' }); assert.ok(JSON.parse(skills.contents[0].text).includes('svg-diagram-skill'))
    const prompts = await client.listPrompts(); assert.deepEqual(prompts.prompts.map(p => p.name).sort(), ['create_svg_diagram', 'create_visualization', 'create_widget'])
    assert.match((await client.getPrompt({ name: 'create_widget' })).messages[0].content.text, /sandbox/)
    const tools = await client.listTools(); assert.ok(tools.tools.some(t => t.name === 'assemble_document'))
    const result = await client.callTool({ name: 'assemble_document', arguments: { title: 'MCP', description: '示例', html: '<p id="mcp">Hello</p>', javascript: 'window.value=42', theme: 'dark' } })
    assert.equal(result.isError, undefined); assert.match(result.content[0].text, /id="mcp"/); assert.match(result.content[0].text, /Content-Security-Policy/); assert.ok(parseDocument(result.structuredContent.document)); assert.match(result.structuredContent.hostContract, /Returns HTML text/)
    const chart = await client.callTool({ name: 'render_intelligent_chart', arguments: { title: '柱图', kind: 'bar', labels: ['A'], values: [2], unit: '件', source: '示例数据' } }); assert.ok(chart.content[0].text.includes('Chart.js v4.5.1')); assert.equal(chart.structuredContent.document.version, 2)
    const invalid = await client.callTool({ name: 'assemble_document', arguments: { title: '', description: '', html: 'x' } }); assert.equal(invalid.isError, true)
    const map = await client.callTool({ name: 'render_intelligent_map', arguments: { title: '地图', basemap: 'world', stops: [{ name: '香港', latitude: 22.3, longitude: 114.2, description: '', source: '用户坐标' }] } }); assert.equal(map.isError, undefined); assert.match(map.content[0].text, /Leaflet 1.9.4/)
  } finally { await client.close(); await transport.close() }
  assert.deepEqual(stderr, [], 'stdio remains protocol-clean')
})
