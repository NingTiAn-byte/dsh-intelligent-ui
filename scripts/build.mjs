import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { root, prepareDependencies, esbuild } from './environment.mjs'
prepareDependencies()
const packageVersion = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const vendor = join(root, 'vendor/chartjs/4.5.1')
const manifest = JSON.parse(await readFile(join(vendor, 'manifest.json'), 'utf8'))
for (const entry of manifest.files) {
  const bytes = await readFile(join(vendor, entry.name))
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
    throw new Error(`Vendored Chart.js integrity check failed: ${entry.name}`)
}
const mapVendor = join(root, 'vendor/leaflet/1.9.4')
const mapManifest = JSON.parse(await readFile(join(mapVendor, 'manifest.json'), 'utf8'))
for (const entry of mapManifest.files) {
  const bytes = await readFile(join(mapVendor, entry.name))
  if (bytes.length !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`Map vendor integrity check failed: ${entry.name}`)
}
const { build } = esbuild()
await mkdir(join(root, 'lib'), { recursive: true })
const common = { absWorkingDir: root, bundle: true, target: 'es2022', logLevel: 'warning', jsx: 'automatic', loader: { '.txt': 'text' } }
await writeFile(join(root, 'lib/THIRD_PARTY_NOTICES.txt'), 'Chart.js 4.5.1\n' + await readFile(join(vendor, 'LICENSE.Chart.js.txt'), 'utf8') + '\nBundled @kurkle/color 0.3.2\n' + await readFile(join(vendor, 'LICENSE.kurkle-color.txt'), 'utf8'))
await build({ ...common, entryPoints: ['src/index.ts'], outfile: 'lib/index.js', platform: 'node', format: 'esm', packages: 'external' })
await build({ ...common, entryPoints: ['src/shared/document.ts'], outfile: 'lib/document.js', platform: 'node', format: 'esm' })
await build({ ...common, entryPoints: ['src/shared/features.ts'], outfile: 'lib/features.js', platform: 'node', format: 'esm' })
await build({ ...common, entryPoints: ['src/mcp/server.ts'], outfile: 'lib/mcp-server.js', platform: 'node', format: 'esm', packages: 'external' })
await build({ ...common, entryPoints: ['src/mcp/stdio.ts'], outfile: 'lib/mcp-stdio.js', platform: 'node', format: 'esm', packages: 'external' })
await build({ ...common, entryPoints: ['src/shared/images.ts'], outfile: 'lib/image-protocol.js', platform: 'node', format: 'esm' })
await build({ ...common, entryPoints: ['src/host/images.ts'], outfile: 'lib/images.js', platform: 'node', format: 'esm', packages: 'external' })
await build({ ...common, entryPoints: ['src/host/street-map.ts'], outfile: 'lib/street-map.js', platform: 'node', format: 'esm', packages: 'external' })
await build({ ...common, entryPoints: ['src/client/sandbox.ts'], outfile: 'lib/sandbox.js', platform: 'browser', format: 'esm' })
await build({ ...common, entryPoints: ['src/client/protocol.ts'], outfile: 'lib/protocol.js', platform: 'browser', format: 'esm' })
await build({ ...common, entryPoints: ['src/shared/templates.ts'], outfile: 'lib/templates.js', platform: 'node', format: 'esm' })
await build({ ...common, entryPoints: ['src/shared/theme.ts'], outfile: 'lib/theme.js', platform: 'node', format: 'esm' })
await build({ ...common, entryPoints: ['src/shared/table.ts'], outfile: 'lib/table.js', platform: 'node', format: 'esm' })
await build({ ...common, entryPoints: ['src/host/routing.ts'], outfile: 'lib/routing.js', platform: 'node', format: 'esm', packages: 'external' })
await build({ ...common, entryPoints: ['src/host/runs.ts'], outfile: 'lib/runs.js', platform: 'node', format: 'esm', packages: 'external' })
await build({ ...common, entryPoints: ['src/shared/runs.ts'], outfile: 'lib/run-protocol.js', platform: 'browser', format: 'esm' })
const client = await build({ ...common, entryPoints: ['src/client/index.tsx'], platform: 'browser', format: 'cjs', external: ['react', 'react/jsx-runtime'], write: false })
// Match DSH's factory artifact protocol, including the shared React module identity.
await writeFile(join(root, 'lib/client.js'), `window.__ModuleLoader__.load({id:"dsh-intelligent-ui",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});`)
const preview = await build({ ...common, entryPoints: ['preview/main.tsx'], platform: 'browser', format: 'iife', write: false })
await writeFile(join(root, 'preview/index.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Intelligent UI Preview</title><div id="root"></div><script>${preview.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></html>`)
const checks = await build({ ...common, entryPoints: ['preview/checks.tsx'], platform: 'browser', format: 'iife', write: false })
await writeFile(join(root, 'preview/checks.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline runtime checks</title><div id="root"></div><script>${checks.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')}</script></html>`)
await writeFile(join(root, 'preview/local.patch.yml'), `- insert:\n    - id: intelligent-ui\n      name: ${JSON.stringify(join(root, 'lib/index.js').replaceAll('\\', '/'))}\n      config:\n        maxDocumentChars: 200000\n        minHeight: 180\n        maxHeight: 900\n`)
await writeFile(join(root, 'lib/LEAFLET_NOTICES.txt'), 'Leaflet 1.9.4\n' + await readFile(join(mapVendor, 'LICENSE.txt'), 'utf8') + '\nWorld overview: NASA Blue Marble August 2004, NASA Earth Observatory / GEBCO.\n' + mapManifest.sources.join('\n'))
await writeFile(join(root, 'preview/mcp.config.json'), JSON.stringify({ mcpServers: { 'intelligent-ui': { command: process.execPath, args: [join(root, 'lib/mcp-stdio.js')] } } }, null, 2))
// Portable Node/MCP package: no Cordis, DSH checkout, React or browser service needed.
const standalone = join(root, 'dist/mcp')
await mkdir(standalone, { recursive: true })
for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(join(root, file), join(standalone, file))
for (const file of ['mcp-server.js', 'mcp-stdio.js', 'THIRD_PARTY_NOTICES.txt', 'LEAFLET_NOTICES.txt']) await copyFile(join(root, 'lib', file), join(standalone, file))
await writeFile(join(standalone, 'package.json'), JSON.stringify({ name: 'dsh-intelligent-ui-mcp', version: packageVersion, private: true, license: 'MIT', type: 'module', bin: { 'intelligent-ui-mcp': './mcp-stdio.js' }, engines: { node: '>=22.19' }, dependencies: { '@modelcontextprotocol/sdk': '1.31.0', zod: '4.4.3', jsdom: '29.1.1', undici: '8.11.2', '@mapbox/vector-tile': '2.0.4', pbf: '4.0.1' } }, null, 2))
console.log('Built lib/index.js, lib/client.js and preview/index.html (no model calls).')
