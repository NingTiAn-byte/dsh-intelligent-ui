import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Only internal projection tests need the matching source tag; builds use npm SDKs.
export const harness = resolve(process.env.DSH_SOURCE ?? join(root, 'artifacts/rc2-source'))
export function requireProjectionSource() {
  let version
  try { version = JSON.parse(readFileSync(join(harness, 'package.json'), 'utf8')).version } catch {}
  if (version !== '0.2.1-rc.2') throw new Error('Projection tests require official dsh-v0.2.1-rc.2 source. See docs/development.md; builds do not require a source checkout.')
}
const requireLocal = createRequire(join(root, 'package.json'))
export const requireHarness = requireLocal
export const requireClient = requireLocal
export function resolveExisting(name) { return requireLocal.resolve(name) }

/** Compile against the declared release SDK, never silently reuse source-checkout links. */
export function prepareDependencies() {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  for (const name of Object.keys(manifest.devDependencies).filter(name => name.startsWith('@deepseek-ai/dsh-'))) {
    const file = requireLocal.resolve(`${name}/package.json`)
    const version = JSON.parse(readFileSync(file, 'utf8')).version
    if (version !== '0.2.1-rc.2') throw new Error(`Expected rc.2 SDK for ${name}, found ${version}. Run npm ci.`)
  }
}
export function esbuild() { return requireLocal('esbuild') }
