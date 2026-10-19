import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { UiDocument } from '../shared/document.ts'
import { chartDocument, mapDocument, parseMap, planDocument, workflowDocument, meetingDocument } from '../shared/features.ts'
import { IMAGE_REQUEST_PROPERTIES, IMAGE_ASSET_SCHEMA, parseImageRequests } from '../shared/images.ts'
import { reusableLicense, commonsFilename, creditUrl } from '../shared/images.ts'
import { resolveImage, query, plainMetadata, type ImagePolicy } from './images.ts'
import type {} from '@deepseek-ai/dsh-attachment'
import { resolvePlace, resolvePlacePhoto, type Place } from './places.ts'
import { loadStreetMap } from './street-map.ts'
import { amapKey, resolveAmapPlace, convertAmapPoint, loadAmapSnapshot, type AmapOptions } from './amap.ts'

const docOutput = {
  schema: { type: 'object', additionalProperties: false, properties: {
    version: { type: 'integer', enum: [1, 2, 3], required: true }, title: { type: 'string', required: true }, description: { type: 'string', required: true },
    html: { type: 'string', required: true }, css: { type: 'string', required: true }, javascript: { type: 'string', required: true }, height: { type: 'number', required: true },
    libraries: { type: 'array', items: { type: 'string', enum: ['chartjs-4.5.1', 'leaflet-1.9.4'] } }, images: { type: 'array', items: IMAGE_ASSET_SCHEMA },
  } },
  render: (_args: unknown, value: UiDocument) => [{ type: 'text' as const, text: `${value.title}\n${value.description}\nPrepared a saved document for the client. Rendering is verified separately.` }],
  presentationMeta: (_args: unknown, value: UiDocument) => JSON.parse(JSON.stringify({ intelligentUi: value })),
} as const
const textOutput = { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }] } as const
const str = (description: string) => ({ type: 'string' as const, required: true as const, description })

export function installFeatures(ctx: Context, policy: ImagePolicy, limits: { maxDocumentChars: number; minHeight: number; maxHeight: number; mapCacheDir?: string; mapProvider?: 'amap' | 'openfreemap' } & AmapOptions): void {
  function bounded(doc: UiDocument) {
    doc.height = Math.max(limits.minHeight, Math.min(limits.maxHeight, doc.height))
    if (doc.html.length + doc.css.length + doc.javascript.length > limits.maxDocumentChars) throw new Error('Document exceeds configured maxDocumentChars')
    return doc
  }
  ctx.systemPrompt.section({ name: 'intelligent-ui-specialized', order: 4002, interpolate: false, text:
    'For maps and itineraries prefer render_intelligent_map. Its default street basemap retrieves real OpenFreeMap/OpenStreetMap roads, parks and water on the Host and saves the bounded geometry for replay; no API key is needed. Provide precise stop names and optionally wikipediaTitle/language; omit coordinates and the Host resolves them. Never invent coordinates. By default each of the first four stops gets its own attributed photo, not only the first stop; use photos:none only when no photos are requested. Do not use the old world overview for city sightseeing: it cannot show city streets. Connections are ordered straight segments, not road navigation. Never log image dataUrl. For simple bar/pie data prefer render_intelligent_chart with unit/source. plan_intelligent_ui is optional. Meeting time selection waits for the actual human, without calendar booking. Use native todo_write for task state, render_intelligent_workflow for a requested read-only snapshot, and native plan mode for approvals. The widget theme control uses the real DSH theme service.' })
  if (limits.mapProvider === 'amap') ctx.systemPrompt.section({ name: 'intelligent-ui-amap', order: 4003, interpolate: false, text: 'Map provider is AMap, overriding the OpenFreeMap instructions above. Use render_intelligent_map with city (e.g. 上海), exact stop names and basemap:street. Omit coordinates for POI lookup. For explicit coordinates declare coordinateSystem:wgs84 or gcj02; WGS84 is converted by the Host. AMap static images provide a bounded snapshot, not live tiles or route navigation. Automatic encyclopedia photos are disabled for AMap to avoid unrelated overseas requests; explicitly requested images still use the separate Wikipedia/Commons pipeline. Never request or output the map key, signed URL or base64 snapshot.' })
  ctx.tools.register(defineTool({ name: 'render_intelligent_map', description: limits.mapProvider === 'amap'
    ? 'Render an AMap itinerary from 1–30 place names and an explicit city. The Host uses its configured Web-service key for POI lookup and an official static basemap snapshot. Supports numbered markers, cards, bounded pan/zoom and play/pause/replay. No automatic overseas photos; no live tile loading or road navigation. Never output the key or base64 data.'
    : 'Render a real street map and itinerary from place names: automatically resolve coordinates and one photo per stop (up to 4). Pan/zoom, numbered markers, cards, connections and play/pause/replay. Host downloads a bounded OpenFreeMap vector region and saves it offline; no API key or manually supplied coordinates required. 1–30 stops. Not road navigation.',
    parameters: { title: str('Map title'), city: { type: 'string', description: 'City or city code for AMap place search; strongly prefer an explicit city for precise matching.' }, coordinateSystem: { type: 'string', enum: ['wgs84', 'gcj02'], description: 'Explicit coordinate input only: defaults to wgs84; AMap coordinates are gcj02.' }, basemap: { type: 'string', enum: ['street', 'world', 'nasa', 'usgs'], description: 'Defaults to street. The configured AMap provider always uses its own street snapshot.' }, durationMs: { type: 'number', description: '1000–120000 milliseconds, default 6000' },
      photos: { type: 'string', enum: ['auto', 'none'], description: 'Default auto: one distinct photo declaration for every stop, up to 4. none disables automatic photos.' },
      stops: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { name: str('Specific landmark/place name, e.g. 故宫'), latitude: { type: 'number' }, longitude: { type: 'number' }, wikipediaTitle: { type: 'string', description: 'Optional precise article title; defaults to name' }, language: { type: 'string', enum: ['zh', 'en'], description: 'Article language, default zh' }, description: { type: 'string', description: 'Place introduction only; omit coordinate values and raw URLs. The component links this introduction to the source.' }, source: { type: 'string', description: 'Required only when supplying coordinates. Prefer the canonical HTTPS reference; shown as a link on the introduction, not as a raw URL.' }, imageId: { type: 'string' } } } },
      images: { type: 'array', items: { type: 'object', additionalProperties: false, properties: IMAGE_REQUEST_PROPERTIES } },
    }, output: docOutput, isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const useAmap = limits.mapProvider === 'amap'
      const key = useAmap ? await amapKey(limits) : ''
      if (args.city !== undefined && (!args.city.trim() || args.city.length > 100)) throw new Error('Invalid map city')
      if (!args.title.trim() || args.title.length > 200 || args.stops.length < 1 || args.stops.length > 30) throw new Error('Invalid map title or stops')
      // Validate all local declarations before any location/image/map request.
      for (const s of args.stops) if (!s.name.trim() || s.name.length > 100 || (s.description?.length ?? 0) > 1000 || (s.latitude === undefined) !== (s.longitude === undefined) || s.latitude !== undefined && (!Number.isFinite(s.latitude) || Math.abs(s.latitude) > 85 || !Number.isFinite(s.longitude) || Math.abs(s.longitude!) > 180 || !s.source?.trim())) throw new Error('Invalid stop: provide a precise name, or a valid coordinate pair with source')
      const initial = { title: args.title, basemap: useAmap ? 'street' : args.basemap ?? 'street', durationMs: args.durationMs ?? 6000 }
      if (!Number.isInteger(initial.durationMs) || initial.durationMs < 1000 || initial.durationMs > 120000) throw new Error('Invalid animation duration')
      const requests = args.images === undefined ? [] : parseImageRequests(args.images)
      if (!requests || args.stops.some(s => s.imageId && !requests.some(r => r.id === s.imageId))) throw new Error('Invalid map photo references')
      const places: (Place | undefined)[] = []
      const resolvedInputs: typeof args.stops = []
      const unresolved: string[] = []
      const stops = []
      for (const s of args.stops) {
        let place: Place | undefined
        try {
          place = s.latitude === undefined ? useAmap ? await resolveAmapPlace(s.name, args.city ?? '', key, limits, exec.signal) : await resolvePlace(s.wikipediaTitle ?? s.name, s.language ?? 'zh', policy, exec.signal) : undefined
          if (useAmap && s.latitude !== undefined && args.coordinateSystem !== 'gcj02') {
            const point = await convertAmapPoint({ latitude: s.latitude, longitude: s.longitude! }, key, limits, exec.signal)
            place = { title: s.name, language: 'zh', ...point, source: s.source! }
          }
        }
        catch (error) {
          exec.signal.throwIfAborted()
          unresolved.push(`${s.name}：${error instanceof Error ? error.message : '地点服务暂不可用'}`)
          continue
        }
        resolvedInputs.push(s)
        const description = useAmap && place && s.latitude === undefined ? `${s.description ?? ''}${s.description ? '\n' : ''}高德匹配：${place.title}` : s.description ?? ''
        places.push(place); stops.push({ name: s.name, latitude: place?.latitude ?? s.latitude!, longitude: place?.longitude ?? s.longitude!, description: description.slice(0, 1000), source: place?.source ?? s.source!, ...(s.imageId ? { imageId: s.imageId } : {}) })
      }
      if (!stops.length) throw new Error(`没有可定位的地点。${unresolved.join('；')}`)
      if (!useAmap && args.photos !== 'none') for (const [i, stop] of stops.entries()) {
        if (stop.imageId || requests.length >= 4) continue
        let id = `stop_${i + 1}`; while (requests.some(r => r.id === id)) id += '_'
        stop.imageId = id
        const p = places[i], s = resolvedInputs[i]
        requests.push({ id, wikipediaTitle: p?.englishTitle ?? p?.title ?? s.wikipediaTitle ?? s.name, language: p?.englishTitle ? 'en' : p?.language ?? s.language ?? 'zh', alt: s.name })
      }
      const spec = parseMap({ ...initial, stops }); if (!spec) throw new Error('Invalid map coordinates, stops or provider')
      let streetData
      if (!useAmap && spec.basemap === 'street') {
        try { streetData = await loadStreetMap(stops, policy, exec.signal, limits.mapCacheDir || undefined) }
        catch (error) {
          exec.signal.throwIfAborted()
          throw new Error(`街道底图获取失败，请检查地图来源网络后重试：${error instanceof Error ? error.message : '地图服务暂不可用'}`)
        }
      }
      const amapData = useAmap ? await loadAmapSnapshot(stops, key, limits, exec.signal) : undefined
      const doc = bounded(mapDocument(spec, streetData, amapData))
      if (useAmap) doc.description = '高德地图 · GCJ-02 · 固定区域底图快照；站点为顺序直线连接，不是道路导航。'
      if (unresolved.length) {
        // Keep unresolved names visible without inventing markers or coordinates.
        const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
        doc.description = `${useAmap ? '高德地图 · GCJ-02 · 底图快照' : '地点与行程'}；${stops.length} 个地点已定位，${unresolved.length} 个地点未定位。`
        doc.html += `<aside data-map-unresolved role="status"><h3>以下地点尚未定位，未在地图上标记</h3><ul>${unresolved.map(message => `<li>${escape(message)}</li>`).join('')}</ul><p>可提供更准确的百科条目或带来源的坐标后重新生成。</p></aside>`
      }
      if (requests.length) {
        doc.version = 3; doc.images = []
        for (const r of requests) {
          const i = stops.findIndex(s => s.imageId === r.id)
          doc.images.push(args.images?.some(explicit => explicit.id === r.id) ? await resolveImage(r, policy, ctx.get('attachments'), exec.signal)
            : await resolvePlacePhoto(r.id, r.alt, places[i], r.wikipediaTitle, r.language, policy, ctx.get('attachments'), exec.signal))
        }
      }
      return bounded(doc)
    },
  }))
  ctx.tools.register(defineTool({ name: 'render_intelligent_chart', description: 'Controlled bar or pie chart from 1–50 labels and values, with required units, source and accessible data table. Uses offline Chart.js; no model-generated JavaScript.',
    parameters: { title: str('Chart title'), kind: { type: 'string', required: true, enum: ['bar', 'pie'] }, labels: { type: 'array', items: { type: 'string' }, required: true }, values: { type: 'array', items: { type: 'number' }, required: true }, unit: str('Unit'), source: str('Actual data source; mark synthetic data explicitly') },
    output: docOutput, isConcurrencySafe: () => true, async execute(args, exec) { exec.signal.throwIfAborted(); return bounded(chartDocument(args as Parameters<typeof chartDocument>[0])) },
  }))
  ctx.tools.register(defineTool({ name: 'plan_intelligent_ui', description: 'Optionally show a concise visualization plan with approach, technology and 2–4 key elements. Does not enter DSH plan mode or require approval.',
    parameters: { approach: str('Approach, at most 1000 characters'), technology: str('Technology, at most 200 characters'), key_elements: { type: 'array', items: { type: 'string' }, required: true } }, output: docOutput, isConcurrencySafe: () => true,
    async execute(args, exec) { exec.signal.throwIfAborted(); return bounded(planDocument(args.approach, args.technology, args.key_elements)) },
  }))
  ctx.tools.register(defineTool({ name: 'render_intelligent_workflow', description: 'Show a read-only workflow snapshot with 1–30 pending/in_progress/completed steps. DSH native todo_write owns task state; this display never marks work done or runs steps.',
    parameters: { title: str('Workflow title'), items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { title: str('Step title'), description: str('Step description'), status: { type: 'string', required: true, enum: ['pending', 'in_progress', 'completed'] } } } } },
    output: docOutput, isConcurrencySafe: () => true, async execute(args, exec) { exec.signal.throwIfAborted(); return bounded(workflowDocument(args.title, args.items)) },
  }))
  ctx.tools.register(defineTool({ name: 'lookup_intelligent_ui_places', description: limits.mapProvider === 'amap' ? 'Search an AMap POI by place title and city; returns GCJ-02 coordinates and the matched source. No invented coordinates.' : 'Resolve one precise en/zh Wikipedia article to its geographic coordinates and canonical source. Returns no fabricated location if the article has no coordinate.',
    parameters: { title: str('Place name (AMap) or exact article title (legacy provider), at most 160 characters'), city: { type: 'string', description: 'City or city code for AMap search.' }, language: { type: 'string', enum: ['en', 'zh'], required: true } }, output: textOutput, isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted(); if (!args.title.trim() || args.title.length > 160 || /[|#\x00-\x1f]/.test(args.title)) throw new Error('Invalid article title')
      if (limits.mapProvider === 'amap') {
        const place = await resolveAmapPlace(args.title, args.city ?? '', await amapKey(limits), limits, exec.signal)
        return JSON.stringify({ name: place.title, latitude: place.latitude, longitude: place.longitude, coordinateSystem: 'gcj02', source: place.source })
      }
      const data = await query(`${args.language}.wikipedia.org`, { titles: args.title, redirects: '1', prop: 'coordinates', coprimary: 'primary', colimit: '1' }, AbortSignal.any([exec.signal, AbortSignal.timeout(policy.timeoutMs)]), undefined, policy.dispatcher) as any
      const p = data?.query?.pages?.[0], c = p?.coordinates?.[0]
      return JSON.stringify(c && p.ns === 0 && Number.isFinite(c.lat) && Number.isFinite(c.lon) ? { name: p.title, latitude: c.lat, longitude: c.lon, source: `https://${args.language}.wikipedia.org/wiki/${encodeURIComponent(p.title)}` } : { status: 'not_found', title: args.title })
    },
  }))
  ctx.tools.register(defineTool({ name: 'search_intelligent_ui_images', description: 'Search reusable Wikimedia Commons raster photos for a subject. Returns at most 4 filenames and source credits, not pixels. Use returned commonsFile with render_intelligent_ui/images or render_intelligent_map. No arbitrary web image search.',
    parameters: { query: str('Subject to search, 1–160 characters') }, output: textOutput, isConcurrencySafe: () => true,
    async execute(args, exec) {
      exec.signal.throwIfAborted(); if (!policy.enabled) return JSON.stringify({ status: 'disabled', images: [] })
      if (!args.query.trim() || args.query.length > 160 || /[\x00-\x1f]/.test(args.query)) throw new Error('Invalid image search')
      const data = await query('commons.wikimedia.org', { generator: 'search', gsrsearch: args.query, gsrnamespace: '6', gsrlimit: '8', prop: 'imageinfo', iiprop: 'url|extmetadata' }, AbortSignal.any([exec.signal, AbortSignal.timeout(policy.timeoutMs)]), undefined, policy.dispatcher) as any
      const images = (data?.query?.pages ?? []).flatMap((p: any) => {
        const i = p?.imageinfo?.[0], file = commonsFilename(i?.url), creator = plainMetadata(i?.extmetadata?.Artist), license = plainMetadata(i?.extmetadata?.LicenseShortName)
        return file && /\.(jpe?g|png|webp|gif)$/i.test(file) && creator && reusableLicense(license) ? [{ commonsFile: file, creator, license, creditUrl: creditUrl(file) }] : []
      }).slice(0, 4)
      return JSON.stringify({ query: args.query, images })
    },
  }))
  ctx.tools.register(defineTool({ name: 'choose_intelligent_meeting_time', description: 'Wait for the human to select or decline one of 2–6 concrete meeting times. Requires explicit timezone and duration. Returns actual selection/custom/declined; cancels or times out without making a selection. No calendar booking or messages.',
    parameters: { title: str('Meeting title, at most 200 characters'), timezone: str('IANA timezone such as Asia/Hong_Kong'), durationMinutes: { type: 'number', required: true }, timeoutSeconds: { type: 'number', description: '30–600 seconds; default 300' }, slots: { type: 'array', items: { type: 'string' }, required: true, description: '2–6 ISO-8601 timestamps with explicit UTC offset, e.g. 2026-10-20T10:00:00+08:00' } },
    output: { ...textOutput, presentationMeta: (_args, value) => { const result = JSON.parse(value); return JSON.parse(JSON.stringify({ intelligentMeeting: result, intelligentUi: bounded(meetingDocument(result)) })) } }, isConcurrencySafe: () => false,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const duration = args.durationMinutes, timeout = args.timeoutSeconds ?? 300
      if (!args.title.trim() || args.title.length > 200 || !Number.isInteger(duration) || duration < 5 || duration > 480 || !Number.isInteger(timeout) || timeout < 30 || timeout > 600 || args.slots.length < 2 || args.slots.length > 6 || new Set(args.slots).size !== args.slots.length) throw new Error('Invalid meeting request')
      let formatter: Intl.DateTimeFormat
      try { formatter = new Intl.DateTimeFormat('zh-CN', { timeZone: args.timezone, dateStyle: 'full', timeStyle: 'short' }) } catch { throw new Error('Invalid IANA timezone') }
      const labels = args.slots.map(s => {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:Z|[+-]\d{2}:\d{2})$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s.slice(0, 19) + 'Z').toISOString().slice(0, 19) !== s.slice(0, 19)) throw new Error('Use concrete valid ISO timestamps with UTC offset')
        return `${formatter.format(new Date(s))} · ${duration}分钟`
      })
      if (new Set(labels).size !== labels.length) throw new Error('Duplicate meeting times')
      const questions = ctx.get('userQuestions'); if (!questions || !exec.agent) throw new Error('Meeting selection needs the live DSH userQuestions service and owning agent')
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(timeout * 1000)])
      try {
        const answer = await questions.ask({ agent: exec.agent, signal, questions: [{ id: 'meeting', header: '会议时间', question: `${args.title}（${args.timezone}）`, options: [...labels.map(label => ({ label })), { label: '这些时间都不合适' }], multiSelect: false }] })
        exec.signal.throwIfAborted(); signal.throwIfAborted()
        const item = answer.answers.find(a => a.id === 'meeting'), label = item?.selected[0], index = labels.indexOf(label ?? '')
        if (!item || item.selected.length > 1 || item.custom !== undefined && (!item.custom.trim() || item.custom.length > 1000) || !item.custom && index < 0 && label !== '这些时间都不合适') throw new Error('Invalid meeting answer; no selection recorded')
        return JSON.stringify({ version: 1, title: args.title, timezone: args.timezone, durationMinutes: duration, status: item?.custom ? 'custom' : index >= 0 ? 'selected' : 'declined', ...(index >= 0 && !item?.custom ? { selected: args.slots[index] } : {}), ...(item?.custom ? { custom: item.custom } : {}), calendarBooked: false })
      } catch (error) {
        exec.signal.throwIfAborted()
        const status = signal.aborted ? 'timeout' : error && typeof error === 'object' && 'code' in error && error.code === 'ASK_CANCELLED' ? 'cancelled' : undefined
        if (status) return JSON.stringify({ version: 1, title: args.title, timezone: args.timezone, durationMinutes: duration, status, calendarBooked: false })
        throw error
      }
    },
  }))
}
