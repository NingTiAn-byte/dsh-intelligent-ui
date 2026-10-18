#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './server.ts'
const server = createMcpServer()
await server.connect(new StdioServerTransport())
for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => { void server.close().finally(() => process.exit(0)) })
