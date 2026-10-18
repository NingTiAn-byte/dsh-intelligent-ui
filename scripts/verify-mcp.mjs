import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { root } from './environment.mjs'
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const client = new Client({ name: 'intelligent-ui-local-verification', version })
const transport = new StdioClientTransport({ command: process.execPath, args: [join(root, 'lib/mcp-stdio.js')], cwd: root, stderr: 'pipe' })
try {
  await client.connect(transport)
  const resources = await client.listResources(), prompts = await client.listPrompts(), tools = await client.listTools()
  await client.readResource({ uri: 'intelligent-ui://capabilities' })
  const template = await client.callTool({ name: 'get_intelligent_ui_template', arguments: { template: 'calculator' } })
  const { version: documentVersion, ...args } = JSON.parse(template.content[0].text)
  const result = await client.callTool({ name: 'assemble_document', arguments: args })
  if (result.isError || !result.content[0].text.includes('Content-Security-Policy')) throw new Error('MCP assembly failed')
  await mkdir(join(root, 'artifacts'), { recursive: true })
  await writeFile(join(root, 'artifacts/mcp-calculator.html'), result.content[0].text)
  const summary = { version, documentVersion, transport: 'stdio', resources: resources.resources.length, prompts: prompts.prompts.map(p => p.name), tools: tools.tools.map(t => t.name), initialized: true, assembled: true, modelCalled: false, renderedInChat: false }
  await writeFile(join(root, 'artifacts/mcp-verification.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2))
} finally { await client.close(); await transport.close() }
