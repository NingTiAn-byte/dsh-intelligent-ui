import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { root } from './environment.mjs'

// Examine exactly the tracked + untracked, non-ignored publication candidates.
const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
if (result.status !== 0) throw new Error('Initialize a Git repository before auditing the publication file list.')
const files = [...new Set(result.stdout.split('\0').filter(Boolean))]
if (!files.length) throw new Error('No publication files found')
const errors = []
const forbidden = /(^|\/)(?:artifacts|node_modules|lib|dist|coverage|playwright-report|test-results|historical-docs|validation-reports)(\/|$)|(^|\/)\.env(?:\.|$)|(?:credentials.*\.json|\.pem|\.key|\.log|\.local\.[^/]*)$/i
const generated = /^preview\/(?:index\.html|checks\.html|local\.patch\.yml|mcp\.config\.json|images-network\.patch\.yml)$/
const personal = /[A-Z]:[\\/]Users[\\/][^\s"'\\/]+|[A-Z]:[\\/](?:devTools|GithubProject)[\\/]/i
const secret = /\bsk-[A-Za-z0-9]{20,}\b|\bghp_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/
for (const file of files) {
  if (forbidden.test(file) || generated.test(file)) errors.push(`${file}: local/generated file`)
  if (/\.(?:pbf|jpeg|png|jpg|woff2?)$/i.test(file)) continue
  const text = readFileSync(join(root, file), 'utf8')
  if (personal.test(text) || secret.test(text)) errors.push(`${file}: possible personal path or credential (value hidden)`)
  if (file.endsWith('.md') && /(?:验收|验证|TODO|复核|对照|路线)/i.test(file)) errors.push(`${file}: local validation/history document`)
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else console.log(`Release audit passed: ${files.length} files; no local reports, generated outputs, recognized credentials or personal paths in publication candidates. Review remains necessary for unrecognized secret formats.`)
