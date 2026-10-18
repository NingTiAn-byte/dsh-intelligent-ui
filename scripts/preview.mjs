import { spawnSync, spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { root } from './environment.mjs'
const build = spawnSync(process.execPath, [join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)
const url = pathToFileURL(join(root, 'preview/index.html')).href
console.log(`Preview: ${url}`)
if (!process.argv.includes('--no-open')) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.on('error', error => console.error(`Open the preview URL manually: ${error.message}`))
  child.unref()
}
