import { spawnSync } from 'node:child_process'
import { root, prepareDependencies, resolveExisting } from './environment.mjs'
prepareDependencies()
for (const face of ['host', 'client', 'mcp']) {
  const result = spawnSync(process.execPath, [resolveExisting('typescript/bin/tsc'), '-p', `tsconfig.${face}.json`], { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
console.log('Host, Client and MCP TypeScript checks passed against the local DSH declarations.')
