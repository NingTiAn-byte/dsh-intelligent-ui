import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { parseDocument, TOOL_NAME } from './shared/document.ts'
import { getTemplate, GENERATION_GUIDANCE, TEMPLATE_NAMES, type TemplateName } from './shared/templates.ts'
import { CHART_LIBRARY, UI_LIBRARIES, parseLibraries } from './shared/libraries.ts'
import { installFeatures } from './host/features.ts'
import { parseTable, tableChars, TABLE_TOOL_NAME } from './shared/table.ts'
import { installRouting } from './host/routing.ts'
import { runsProjection } from './host/runs.ts'
import type {} from '@deepseek-ai/dsh-attachment'
import { resolveImage } from './host/images.ts'
import { IMAGE_REQUEST_PROPERTIES, IMAGE_ASSET_SCHEMA, parseImageRequests, MAX_IMAGE_BYTES } from './shared/images.ts'
import { ProxyAgent } from 'undici'

export const name = 'intelligent-ui'
export const inject = ['tools', 'systemPrompt', 'sessionProjections']
export interface Config { maxDocumentChars: number; minHeight: number; maxHeight: number; routing: 'model' | 'off'; imagesEnabled?: boolean; imageMaxBytes?: number; imageTimeoutMs?: number; imageProxyUrl?: string; mapCacheDir?: string; mapProvider?: 'amap' | 'openfreemap'; amapEnvFile?: string; amapKeyFile?: string; amapTimeoutMs?: number }
export const Config: z<Config> = z.object({
  maxDocumentChars: z.number().min(1000).max(200000).default(200000),
  minHeight: z.number().min(180).max(900).default(180),
  maxHeight: z.number().min(180).max(900).default(900),
  routing: z.union(['model', 'off']).default('model'),
  imagesEnabled: z.boolean().default(true),
  imageMaxBytes: z.number().min(1000).max(MAX_IMAGE_BYTES).default(MAX_IMAGE_BYTES),
  imageTimeoutMs: z.number().min(1000).max(60000).default(15000),
  imageProxyUrl: z.string().default(''),
  mapCacheDir: z.string().default(''),
  mapProvider: z.union(['amap', 'openfreemap']).default('openfreemap'),
  amapEnvFile: z.string().default(''),
  amapKeyFile: z.string().default(''),
  amapTimeoutMs: z.number().min(1000).max(60000).default(15000),
})

export function apply(ctx: Context, config: Config): void {
  if (config.minHeight > config.maxHeight) throw new Error('minHeight must not exceed maxHeight')
  const imageProxy = config.imageProxyUrl ? new ProxyAgent(config.imageProxyUrl) : undefined
  if (imageProxy) ctx.effect(() => async () => { await imageProxy.close() }, 'intelligent-ui image proxy')
  installFeatures(ctx, { enabled: config.imagesEnabled ?? true, maxBytes: config.imageMaxBytes ?? MAX_IMAGE_BYTES, timeoutMs: config.imageTimeoutMs ?? 15000, dispatcher: imageProxy }, config)
  ctx.sessionProjections.register(runsProjection)
  ctx.systemPrompt.section({ name: 'intelligent-ui-generation', order: 4000, text: GENERATION_GUIDANCE, interpolate: false })
  ctx.systemPrompt.section({ name: 'intelligent-ui-table', order: 4001, interpolate: false,
    text: 'For ordinary read-only row/column data use render_intelligent_table, with title, columns, rows and source. All cells must be strings (include units). Limits: 1–12 columns, 0–200 rows, title 300, column 200, cell 2000, source 1000 characters, total text 200000 or the configured lower limit. Every row must match column count. State real data provenance; label synthetic data explicitly. This is a basic table without sorting, filtering or pagination. For interactive controls use render_intelligent_ui. Never place executable HTML in table cells.' })
  ctx.tools.register(defineTool({
    name: TABLE_TOOL_NAME,
    description: 'Show a persistent controlled read-only table from structured text. Provide title, 1–12 columns, at most 200 rows of string cells matching column count, and visible data source. No HTML or JavaScript is executed. For calculations and interactive controls use render_intelligent_ui.',
    parameters: {
      title: { type: 'string', required: true, description: 'Table title, at most 300 characters.' },
      columns: { type: 'array', items: { type: 'string' }, required: true, description: '1–12 column labels, at most 200 characters each.' },
      rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, required: true, description: '0–200 rows, each with exactly the column count. Cells are plain text, at most 2000 characters each. Include units.' },
      source: { type: 'string', required: true, description: 'Visible provenance, at most 1000 characters. Mark synthetic examples explicitly.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        version: { type: 'integer', enum: [1], required: true }, title: { type: 'string', required: true },
        columns: { type: 'array', items: { type: 'string' }, required: true },
        rows: { type: 'array', items: { type: 'array', items: { type: 'string' } }, required: true },
        source: { type: 'string', required: true },
      } },
      render: (_args, table) => [{ type: 'text', text: `Table prepared: ${table.title}\n${table.rows.length} rows, ${table.columns.length} columns.\nSource: ${table.source}\nThe client renders the saved structured table; browser rendering has not been verified by this tool.` }],
      presentationMeta: (_args, value) => ({ intelligentTable: value }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const table = parseTable({ ...args, version: 1 })
      if (!table) throw new Error('Invalid table: check field lengths, 1–12 columns, 0–200 rows, matching row widths, string cells and the 200000-character total limit.')
      if (tableChars(table) > config.maxDocumentChars) throw new Error(`Table text exceeds maxDocumentChars=${config.maxDocumentChars}`)
      return table
    },
  }))
  ctx.tools.register(defineTool({
    name: 'get_intelligent_ui_template',
    description: 'Read an offline calculator, comparison, flowchart, chart_line, chart_bar or chart_pie template with working controls, validation, reset and confirmed follow-up receipts. Chart templates declare a pinned local Chart.js library. Pass all returned fields except version to render_intelligent_ui. This tool only returns a template.',
    parameters: { template: { type: 'string', enum: [...TEMPLATE_NAMES], required: true, description: TEMPLATE_NAMES.join(', ') } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) { exec.signal.throwIfAborted(); return JSON.stringify(getTemplate(args.template as TemplateName)) },
  }))
  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: 'Create an interactive explanation, diagram, calculator or chart inside the chat. For plain read-only tables use render_intelligent_table. '
      + 'Use when interaction or a visual helps the user. No business database is required. '
      + 'Provide a body HTML fragment, CSS, and JavaScript separately; no external scripts, fetch, forms or iframes. '
      + 'For photos declare up to 4 images with {id,wikipediaTitle,language:en|zh,alt}; insert <figure data-iui-image="ID"></figure>. '
      + 'The host retrieves matching Wikipedia/Commons photos and credits, validates raster bytes with DSH, and saves them offline. '
      + 'Keep the card focused on its subject, image captions and source credits. Do not add testing, storage or failure-policy explanations. '
      + 'Do not print returned image dataUrl fields in PTC logs. Use inline SVG, HTML and DOM APIs. Use textContent for untrusted data. '
      + 'Use window.dshUI.sendPrompt(text) to propose a follow-up, or window.dshUI.openLink(httpsUrl). '
      + 'The user confirms these requests outside the widget. Keep all numeric assumptions, units '
      + 'and data provenance visible. Do not invent real data. JavaScript runs only after successful execution. '
      + 'Use get_intelligent_ui_template for working examples. Height adjusts automatically. '
      + 'For Chart.js, declare libraries:["chartjs-4.5.1"]; the offline runtime provides window.Chart before your script. Never load a CDN or paste library source. '
      + 'sendPrompt returns a Promise for confirmation and queue acceptance, not model completion; handle cancellation and errors. '
      + 'Subscribe to dshUI.onRunStatus(listener) for separate version:1 queued/running/completed/failed/cancelled/unknown updates keyed by requestId; getRunStatuses() restores recent statuses. Only completed has modelCompleted:true. Check the conversation for the response itself.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short human-readable title, at most 200 characters.' },
      description: { type: 'string', required: true, description: 'What this explains and where the data comes from; at most 2000 characters.' },
      height: { type: 'number', required: true, description: 'Initial iframe height in pixels, 180 to 900.' },
      images: { type: 'array', items: { type: 'object', additionalProperties: false, properties: IMAGE_REQUEST_PROPERTIES }, description: 'Optional 1–4 Wikipedia article photo requests. These cause anonymous host requests to Wikipedia/Commons. Declare before html; no arbitrary image URL or image generation. The saved UI includes verified credits or a visible unavailable card.' },
      libraries: { type: 'array', items: { type: 'string', enum: [...UI_LIBRARIES] }, description: 'Optional pinned offline libraries: chartjs-4.5.1 for window.Chart, leaflet-1.9.4 for window.L. Prefer render_intelligent_map for maps. Emit before css/html/javascript.' },
      css: { type: 'string', required: true, description: 'Self-contained CSS. No remote resources.' },
      html: { type: 'string', required: true, description: 'Body HTML fragment, progressively previewed while generating. Put executable code in javascript, styles in css.' },
      javascript: { type: 'string', required: true, description: 'Plain DOM JavaScript; use empty string for a static view.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        version: { type: 'integer', enum: [1, 2, 3], required: true }, title: { type: 'string', required: true },
        images: { type: 'array', items: IMAGE_ASSET_SCHEMA },
        libraries: { type: 'array', items: { type: 'string', enum: [...UI_LIBRARIES] } },
        description: { type: 'string', required: true }, html: { type: 'string', required: true },
        css: { type: 'string', required: true }, javascript: { type: 'string', required: true },
        height: { type: 'number', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `Interactive UI prepared: ${value.title}\n${value.description}\nThe client will render the saved document. Browser execution has not been verified by this tool.`
        + (value.images?.length ? '\nImage results:\n' + value.images.map(image => `${image.id}: ${image.status}${image.code ? ' (' + image.code + ')' : ''}; ${image.wikipediaTitle}${image.status === 'available' ? `; ${image.creator}; ${image.license}; ${image.creditUrl}` : ''}`).join('\n') : '') }],
      presentationMeta: (_args, value) => ({ intelligentUi: value }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const libraries = args.libraries === undefined ? [] : parseLibraries(args.libraries)
      if (!libraries) throw new Error('Unsupported libraries: use [] or ["chartjs-4.5.1"] only.')
      const imageRequests = args.images === undefined ? undefined : parseImageRequests(args.images)
      if (imageRequests === null) throw new Error('Invalid images: provide 1–4 unique image IDs, precise en/zh Wikipedia article titles and alt text.')
      const { libraries: _libraries, images: _images, ...fields } = args
      // Validate all source fields and deployment limits before any outbound image request.
      const base = parseDocument({ ...fields, version: libraries.length ? 2 : 1, ...(libraries.length ? { libraries } : {}) })
      if (!base) throw new Error('Invalid UI document: check title, description, height and the 200000-character limit.')
      if (base.html.length + base.css.length + base.javascript.length > config.maxDocumentChars) throw new Error(`UI source exceeds maxDocumentChars=${config.maxDocumentChars}`)
      if (base.height < config.minHeight || base.height > config.maxHeight) throw new Error(`height must be between ${config.minHeight} and ${config.maxHeight}`)
      const images = []
      for (const request of imageRequests ?? []) images.push(await resolveImage(request, {
        enabled: config.imagesEnabled ?? true, maxBytes: config.imageMaxBytes ?? MAX_IMAGE_BYTES, timeoutMs: config.imageTimeoutMs ?? 15000, dispatcher: imageProxy,
      }, ctx.get('attachments'), exec.signal))
      exec.signal.throwIfAborted()
      const document = parseDocument({ ...base, ...(images.length ? { version: 3, images } : {}) })
      if (!document) throw new Error('Invalid UI document: check title, description, height and the 200000-character limit.')
      return document
    },
  }))
  if (config.routing === 'model') installRouting(ctx)
}
