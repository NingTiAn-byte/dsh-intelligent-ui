import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync, readFileSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [resolve(root, '../deepseek-harness'), resolve(root, '../../deepseek-harness')]
export const harness = resolve(process.env.DSH_SOURCE ?? candidates.find(path => existsSync(join(path, 'packages/core/tools/package.json'))) ?? candidates[0])
const requireLocal = createRequire(join(root, 'package.json'))
export const requireHarness = createRequire(join(harness, 'package.json'))
export const requireClient = createRequire(join(harness, 'packages/client/ui-tool/package.json'))

export function resolveExisting(name) {
  try { return requireLocal.resolve(name) } catch {}
  try { return requireHarness.resolve(name) }
  catch {
    const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
    const suffix = name.slice(packageName.length)
    const store = join(harness, 'node_modules/.pnpm')
    const candidate = readdirSync(store).find(entry => entry.startsWith(packageName.replace('/', '+') + '@') && existsSync(join(store, entry, 'node_modules', packageName, 'package.json')))
    if (!candidate) throw new Error(`Existing DSH dependency not found: ${name}`)
    const fromPackage = createRequire(join(store, candidate, 'node_modules', packageName, 'package.json'))
    return suffix === '/package.json' ? join(store, candidate, 'node_modules', packageName, 'package.json') : fromPackage.resolve(name)
  }
}

/** Use the user's existing checkout; do not download or copy the host runtime. */
export function prepareDependencies() {
  if (!existsSync(join(harness, 'package.json'))) throw new Error('DSH source checkout not found. Set DSH_SOURCE to a built DeepSeek Harness 0.2.1-alpha.4 checkout.')
  const version = JSON.parse(readFileSync(join(harness, 'package.json'), 'utf8')).version
  if (version !== '0.2.1-alpha.4') throw new Error(`This plugin targets DSH 0.2.1-alpha.4; found ${version}. Review API compatibility first.`)
  const links = {
    '@deepseek-ai/cordis': 'vendor/cordis', '@deepseek-ai/schemastery': 'vendor/schemastery',
    '@deepseek-ai/dsh-tools': 'packages/core/tools',
    '@deepseek-ai/dsh-system-prompt': 'packages/core/system-prompt',
    '@deepseek-ai/dsh-agent': 'packages/core/agent',
    '@deepseek-ai/dsh-agent-loop': 'packages/core/agent-loop',
    '@deepseek-ai/dsh-llm': 'packages/llm/llm',
    '@deepseek-ai/dsh-ptc-runtime': 'packages/ptc-runtime/ptc-runtime',
    '@deepseek-ai/dsh-session': 'packages/core/session',
    '@deepseek-ai/dsh-scope': 'packages/core/scope',
    '@deepseek-ai/dsh-session-projection': 'packages/session/session-projection',
    '@deepseek-ai/dsh-session-controller': 'packages/api/session-controller',
    '@deepseek-ai/dsh-attachment': 'packages/attachment/attachment',
    '@deepseek-ai/dsh-user-questions': 'packages/interaction/user-questions',
    '@deepseek-ai/dsh-client-ui-tool': 'packages/client/ui-tool',
    '@deepseek-ai/dsh-client-ui-slots': 'packages/client/ui-slots',
    '@deepseek-ai/dsh-client-ui-renderer': 'packages/client/ui-renderer',
    '@deepseek-ai/dsh-client-ui-conversation': 'packages/client/ui-conversation',
    '@deepseek-ai/dsh-client-ui-chat': 'packages/client/ui-chat',
    '@deepseek-ai/dsh-client-locale': 'packages/client/locale',
    '@deepseek-ai/dsh-client-ui-theme': 'packages/client/ui-theme',
  }
  for (const [name, rel] of Object.entries(links)) link(name, join(harness, rel))
  link('@deepseek-ai/dsh-attachment-local', join(harness, 'packages/attachment/attachment-local'))

}
function link(name, target) {
  if (!existsSync(join(target, 'package.json'))) throw new Error(`Missing dependency: ${target}`)
  const dest = join(root, 'node_modules', name)
  if (existsSync(dest)) return
  mkdirSync(dirname(dest), { recursive: true })
  symlinkSync(target, dest, process.platform === 'win32' ? 'junction' : 'dir')
}
export function esbuild() {
  return requireLocal('esbuild')
}
