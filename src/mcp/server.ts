import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { JSDOM } from 'jsdom'
import { parseDocument, type UiDocument } from '../shared/document.ts'
import { UI_LIBRARIES } from '../shared/libraries.ts'
import { getTemplate, TEMPLATE_NAMES, GENERATION_GUIDANCE } from '../shared/templates.ts'
import { makeTheme, DEFAULT_THEME, TEMPLATE_STYLES } from '../shared/theme.ts'
import { chartDocument, mapDocument, planDocument, workflowDocument } from '../shared/features.ts'
import { buildSandboxDocument } from '../client/sandbox.ts'
import { loadStreetMap } from '../host/street-map.ts'

/** Same DOM tokenizer and CSP assembler as DSH; scripts never execute in this DOM. */
export function assembleDocument(value: unknown, scheme: 'light' | 'dark' = 'light'): { document: UiDocument; html: string } {
  const document = parseDocument(value)
  if (!document) throw new Error('Unsupported or invalid UI document')
  const dom = new JSDOM('')
  const previous = globalThis.document
  try {
    globalThis.document = dom.window.document
    return { document, html: buildSandboxDocument(document, crypto.randomUUID(), false, scheme === 'light' ? DEFAULT_THEME : makeTheme('dark')) }
  } finally {
    if (previous === undefined) Reflect.deleteProperty(globalThis, 'document'); else globalThis.document = previous
    dom.window.close()
  }
}
const hostContract = 'Returns HTML text, not a rendered chat UI. The host must render in an iframe with sandbox="allow-scripts" and without allow-same-origin. Never put generated scripts into the host DOM. sendPrompt/openLink require a compatible confirmed parent bridge; standalone files reject chat actions. Resources and templates do not need DSH. Street-map preparation downloads bounded vector data from fixed OpenFreeMap origins on the server and embeds the geography for offline iframe replay. Legacy NASA/USGS modes may request images from their fixed origins; the legacy world overview is embedded. v3 snapshots retain validated data-image syntax and canonical attribution structure; imported provenance is supplied by the caller, not reverified over the network.'
const stopSchema = z.object({ name: z.string(), latitude: z.number(), longitude: z.number(), description: z.string(), source: z.string() })
const chartSchema = { title: z.string(), kind: z.enum(['bar', 'pie']), labels: z.array(z.string()), values: z.array(z.number()), unit: z.string(), source: z.string() }
export function createMcpServer() {
  const server = new McpServer({ name: 'dsh-intelligent-ui', version: '1.2.1' })
  const resources: Record<string, { mimeType: string; text: string }> = {
    'skills://list': { mimeType: 'application/json', text: JSON.stringify(['master-agent-playbook', 'svg-diagram-skill', 'agent-skills-vol2']) },
    'skills://master-agent-playbook': { mimeType: 'text/plain', text: GENERATION_GUIDANCE + '\n' + hostContract },
    'skills://svg-diagram-skill': { mimeType: 'text/plain', text: 'Create self-contained inline SVG using a viewBox, accessible title/description and theme CSS variables. No remote href, image URL, script, foreign iframe or event attributes. Separate executable code into javascript.\n' + GENERATION_GUIDANCE },
    'skills://agent-skills-vol2': { mimeType: 'text/plain', text: GENERATION_GUIDANCE + '\nUse local Chart.js 4.5.1 or Leaflet 1.9.4. Prefer controlled chart/map tools. Keep units, sources and map attribution visible.\n' + hostContract },
    'intelligent-ui://capabilities': { mimeType: 'application/json', text: JSON.stringify({ protocol: 1, documentVersions: [1, 2, 3], libraries: UI_LIBRARIES, transport: 'stdio', hostContract, hostActions: ['confirmed-prompt', 'confirmed-https-link'], forms: 'No login/authentication service', limits: { maxSourceChars: 200000, maxPhotos: 4, maxPhotoBytes: 256000 } }) },
    'intelligent-ui://schema': { mimeType: 'application/json', text: JSON.stringify({ type: 'object', required: ['version', 'title', 'description', 'html', 'css', 'javascript', 'height'], properties: { version: { enum: [1, 2, 3] }, title: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: 'string', maxLength: 2000 }, html: { type: 'string' }, css: { type: 'string' }, javascript: { type: 'string' }, height: { type: 'number', minimum: 180, maximum: 900 }, libraries: { type: 'array', uniqueItems: true, items: { enum: UI_LIBRARIES } }, images: { type: 'array', minItems: 1, maxItems: 4, description: 'v3 only: bounded inline rasters with canonical Wikipedia/Commons URLs, reusable license and creator. parseDocument performs full runtime validation.' } }, description: 'v1: no libraries/images; v2: nonempty libraries and no images; v3: nonempty images and optional nonempty libraries. html+css+javascript <=200000 chars.' }) },
    'intelligent-ui://theme': { mimeType: 'text/css', text: TEMPLATE_STYLES },
  }
  for (const name of TEMPLATE_NAMES) resources[`intelligent-ui://templates/${name}`] = { mimeType: 'application/json', text: JSON.stringify(getTemplate(name)) }
  for (const [uri, resource] of Object.entries(resources)) server.registerResource(uri, uri, { mimeType: resource.mimeType }, async () => ({ contents: [{ uri, ...resource }] }))
  for (const [name, skill] of [['create_widget', 'master-agent-playbook'], ['create_svg_diagram', 'svg-diagram-skill'], ['create_visualization', 'agent-skills-vol2']]) server.registerPrompt(name, { description: `Instructions: ${name}` }, async () => ({ messages: [{ role: 'user', content: { type: 'text', text: resources[`skills://${skill}`].text } }] }))
  const result = (doc: UiDocument, scheme: 'light' | 'dark' = 'light') => {
    const built = assembleDocument(doc, scheme)
    return { content: [{ type: 'text' as const, text: built.html }], structuredContent: { document: built.document, hostContract } }
  }
  server.registerTool('assemble_document', { description: 'Validate and assemble the same saved UI document as DSH into iframe-ready HTML. Separate HTML/CSS/JavaScript; no inline script execution in HTML. Returns text; host rendering is a separate capability.', inputSchema: {
    title: z.string(), description: z.string(), html: z.string(), css: z.string().default(''), javascript: z.string().default(''), height: z.number().default(400), libraries: z.array(z.enum(UI_LIBRARIES)).default([]), theme: z.enum(['light', 'dark']).default('light'),
  } }, async ({ theme, libraries, ...fields }) => result({ ...fields, version: libraries.length ? 2 : 1, ...(libraries.length ? { libraries } : {}) }, theme))
  server.registerTool('assemble_saved_document', { description: 'Validate and replay a saved v1/v2/v3 snapshot including bounded attributed images. Structural validation only: the caller supplies imported attribution, not a new live source verification.', inputSchema: { document: z.unknown(), theme: z.enum(['light', 'dark']).default('light') } }, async ({ document, theme }) => {
    const d = parseDocument(document); if (!d) throw new Error('Invalid saved document'); return result(d, theme)
  })
  server.registerTool('get_intelligent_ui_template', { description: 'Return one of the same six reusable DSH templates.', inputSchema: { template: z.enum(TEMPLATE_NAMES) } }, async ({ template }) => ({ content: [{ type: 'text', text: JSON.stringify(getTemplate(template)) }] }))
  server.registerTool('render_intelligent_chart', { description: 'Assemble a controlled offline bar/pie chart with units and source.', inputSchema: chartSchema }, async args => result(chartDocument(args)))
  server.registerTool('render_intelligent_map', { description: 'Assemble a geographic itinerary with a saved real street region or legacy world/NASA/USGS view. No photo lookup or booking; DSH Host additionally resolves place names and photos.', inputSchema: { title: z.string(), basemap: z.enum(['street', 'world', 'nasa', 'usgs']).default('street'), durationMs: z.number().default(6000), stops: z.array(stopSchema) } }, async args => result(mapDocument(args, args.basemap === 'street' ? await loadStreetMap(args.stops, { timeoutMs: 30000 }, new AbortController().signal) : undefined)))
  server.registerTool('plan_intelligent_ui', { description: 'Optional visualization plan, 2–4 key elements.', inputSchema: { approach: z.string(), technology: z.string(), key_elements: z.array(z.string()) } }, async args => result(planDocument(args.approach, args.technology, args.key_elements)))
  server.registerTool('render_intelligent_workflow', { description: 'Read-only workflow snapshot; does not execute or update host todos.', inputSchema: { title: z.string(), items: z.array(z.object({ title: z.string(), description: z.string(), status: z.enum(['pending', 'in_progress', 'completed']) })) } }, async args => result(workflowDocument(args.title, args.items)))
  return server
}
