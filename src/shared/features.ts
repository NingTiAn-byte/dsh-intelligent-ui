import type { UiDocument } from './document.ts'
import world from '../../vendor/leaflet/1.9.4/world-data.txt'
import { parseStreetMap, type StreetMap } from './street-map.ts'

export const COMPONENT_TOOLS = ['render_intelligent_map', 'render_intelligent_chart', 'plan_intelligent_ui', 'render_intelligent_workflow', 'choose_intelligent_meeting_time'] as const
export interface MapStop { name: string; latitude: number; longitude: number; description: string; source: string; imageId?: string }
export interface MapSpec { title: string; basemap: 'street' | 'world' | 'nasa' | 'usgs'; stops: MapStop[]; durationMs: number }
const short = (v: unknown, n: number) => typeof v === 'string' && !!v.trim() && v.length <= n
export function parseMap(value: unknown): MapSpec | null {
  if (!value || typeof value !== 'object') return null
  const d = value as MapSpec
  if (!short(d.title, 200) || !['street', 'world', 'nasa', 'usgs'].includes(d.basemap) || !Number.isInteger(d.durationMs) || d.durationMs < 1000 || d.durationMs > 120000
    || !Array.isArray(d.stops) || !d.stops.length || d.stops.length > 30) return null
  const stops: MapStop[] = []
  for (const s of d.stops) {
    if (!s || !short(s.name, 100) || typeof s.description !== 'string' || s.description.length > 1000 || !short(s.source, 1000)
      || !Number.isFinite(s.latitude) || Math.abs(s.latitude) > 85 || !Number.isFinite(s.longitude) || Math.abs(s.longitude) > 180
      || s.imageId !== undefined && !/^[A-Za-z0-9_-]{1,40}$/.test(s.imageId)) return null
    if (d.basemap === 'usgs' && (s.longitude < -180 || s.longitude > -60 || s.latitude < 15 || s.latitude > 75)) return null
    stops.push({ name: s.name, latitude: s.latitude, longitude: s.longitude, description: s.description, source: s.source, ...(s.imageId ? { imageId: s.imageId } : {}) })
  }
  return { title: d.title, basemap: d.basemap, stops, durationMs: d.durationMs }
}
const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
/** The same bounded, deterministic components are used by Host and standalone MCP. */
export function mapDocument(spec: MapSpec, streetData?: StreetMap): UiDocument {
  const valid = parseMap(spec); if (!valid) throw new Error('Invalid map: 1–30 stops, coordinates, sources, basemap and 1–120 second duration required.')
  const streets = streetData === undefined ? undefined : parseStreetMap(streetData)
  if (streetData !== undefined && !streets || valid.basemap === 'street' && !streets) throw new Error('A street map requires validated geographic data')
  return { version: 2, libraries: ['leaflet-1.9.4'], title: valid.title, description: '地点与行程', height: 700,
    html: '<section><header class="iui-page-header"><div><p class="iui-eyebrow">地点与行程</p><h2 id="map-title"></h2></div><span class="iui-badge">' + valid.stops.length + ' 个地点</span></header><div id="iui-map" role="region" aria-label="行程地图" style="height:360px"></div><p id="map-status" role="status"></p><div class="actions iui-map-actions"><button class="iui-primary" id="trip-play">播放行程</button><button id="trip-pause">暂停</button><button id="trip-reset">重播</button><button id="trip-fit">查看全部</button></div><progress id="trip-progress" max="1" value="0" aria-label="行程进度"></progress><p class="note">站点之间按顺序连线</p><div id="trip-stops">' + valid.stops.map((s, i) => `<article class="trip-card"><button class="trip-stop-button">${i + 1}. ${escape(s.name)}</button><p class="trip-description">${escape(s.description.trim() || `${s.name}介绍`)}</p>${s.imageId ? `<figure data-iui-image="${s.imageId}"></figure>` : ''}</article>`).join('') + '</div></section>',
    css: '#iui-map svg{display:initial;width:initial;height:initial;max-width:none;margin:0}.iui-pin-core{width:100%;height:100%;background:#376df4;color:white;border:2px solid white;border-radius:50%;display:grid;place-items:center;font-weight:600;box-shadow:0 2px 6px #0003}.iui-pin.active .iui-pin-core{background:#e05824}.leaflet-container{color:#18202a}',
    javascript: `(${mapRuntime.toString()})(${json(valid)},${json(streets ? '' : world.trim())},${json(streets ?? null)});` }
}

/** Serialized; depend only on browser globals and the bundled Leaflet. */
function mapRuntime(spec: MapSpec, worldData: string, streetData: StreetMap | null): void {
  const w = window as any; const L = w.L
  if (L?.version !== '1.9.4') throw new Error('Map runtime unavailable')
  const byId = (id: string) => document.getElementById(id)!
  byId('map-title').textContent = spec.title
  // Allow local stops to separate even on the low-resolution fallback. Native tile
  // resolution is independent of view zoom; overzoom never invents road detail.
  const map = L.map('iui-map', { minZoom: 1, maxZoom: streetData || spec.basemap === 'usgs' ? 18 : 16, worldCopyJump: true, attributionControl: true })
  map.setView([spec.stops[0].latitude, spec.stops[0].longitude], 3)
  map.attributionControl.setPrefix(false)
  if (!streetData) L.imageOverlay(worldData, [[-85.05112878, -180], [85.05112878, 180]], { interactive: false, attribution: 'NASA Blue Marble · NASA Earth Observatory / GEBCO' }).addTo(map)
  else {
    byId('iui-map').style.background = '#f4f2eb'
    const [south, west, north, east] = streetData.bounds
    map.setMaxBounds([[south, west], [north, east]])
    map.options.maxBoundsViscosity = 1
    map.createPane('street-base'); map.getPane('street-base').style.zIndex = '250'
    map.createPane('street-labels'); map.getPane('street-labels').style.zIndex = '350'
    for (const kind of ['park', 'water', 'building', 'road', 'label']) for (const feature of streetData.features.filter(f => f.kind === kind)) {
      if (kind === 'label') {
        const label = document.createElement('span'); label.textContent = feature.name; label.style.cssText = 'white-space:nowrap;font:11px system-ui;color:#4f4b43;text-shadow:0 0 3px white,0 0 3px white;pointer-events:none'
        L.marker(feature.paths[0][0], { interactive: false, pane: 'street-labels', icon: L.divIcon({ className: 'iui-map-label', html: label, iconSize: [0, 0] }) }).addTo(map)
      } else for (const path of feature.paths) {
        const options = { pane: 'street-base', interactive: false, color: kind === 'road' ? feature.major ? '#d9a76b' : '#d2cdc1' : kind === 'water' ? '#9ccce2' : kind === 'park' ? '#c8ddae' : '#d6d1c6', weight: kind === 'road' ? feature.major ? 3 : 1.5 : .6, fillColor: kind === 'water' ? '#b8dcea' : kind === 'park' ? '#d5e5c2' : '#e2ded5', fillOpacity: 1 }
        ;(kind === 'road' ? L.polyline(path, options) : L.polygon(path, options)).addTo(map)
      }
    }
    map.attributionControl.addAttribution('<a data-map-credit href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · <a data-map-credit href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">© OpenMapTiles</a> · <a data-map-credit href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors (ODbL)</a>')
    map.attributionControl.getContainer().addEventListener('click', (event: MouseEvent) => {
      const link = (event.target as Element)?.closest<HTMLAnchorElement>('a[data-map-credit]')
      if (link && parent !== window) { event.preventDefault(); void w.dshUI.openLink(link.href).catch(() => {}) }
    })
  }
  const status = byId('map-status')
  if (!streetData && spec.basemap !== 'world') {
    const url = spec.basemap === 'nasa'
      ? 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg'
      : 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'
    const tiles = L.tileLayer(url, { maxNativeZoom: spec.basemap === 'nasa' ? 8 : 16, maxZoom: spec.basemap === 'nasa' ? 16 : 18, attribution: spec.basemap === 'nasa' ? 'NASA GIBS' : 'USGS The National Map', noWrap: true, updateWhenIdle: true, keepBuffer: 0 }).addTo(map)
    tiles.on('tileerror', () => { status.textContent = '详细底图暂不可用，已保留全球底图和地点。' })
    tiles.on('load', () => { if (!tiles._tiles || Object.values(tiles._tiles).some((t: any) => t.el?.naturalWidth > 0)) status.textContent = '' })
  }
  const cards: HTMLElement[] = []; const pins: any[] = []
  function select(index: number) {
    cards.forEach((c, i) => c.setAttribute('aria-current', String(i === index)))
    pins.forEach((pin, i) => pin.getElement()?.classList.toggle('active', i === index))
  }
  function animatePins(progress: number) {
    pins.forEach((pin, i) => {
      const core = pin.getElement()?.firstElementChild as HTMLElement | undefined
      if (!core) return
      const t = Math.min(1, Math.max(0, (progress * pins.length - i) / .55)), q = t - 1
      const ease = 1 + 2.2 * q * q * q + 1.2 * q * q
      core.style.opacity = String(t > 0 ? 1 : 0); core.style.transform = `translateY(${-18 * (1 - ease)}px) scale(${.72 + .28 * ease})`
    })
  }
  spec.stops.forEach((s, i) => {
    const marker = L.marker([s.latitude, s.longitude], { icon: L.divIcon({ className: 'iui-pin', html: `<span class="iui-pin-core">${i + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }), title: s.name }).addTo(map)
    const tip = document.createElement('span'); tip.textContent = s.name; marker.bindTooltip(tip)
    marker.on('click', () => { select(i); cards[i].scrollIntoView({ behavior: 'smooth', block: 'nearest' }) }); pins.push(marker)
    const card = byId('trip-stops').children[i] as HTMLElement
    // Keep coordinates and source in the saved map data, not in card copy.
    // Only the trusted runtime attaches validated links after HTML sanitizing.
    try {
      const url = new URL(s.source)
      if (url.protocol === 'https:' && !url.username && !url.password) {
        const description = card.querySelector('.trip-description')!
        const link = document.createElement('a')
        link.textContent = description.textContent; link.href = url.href
        link.target = '_blank'; link.rel = 'noopener noreferrer'
        link.addEventListener('click', event => {
          if (parent !== window) { event.preventDefault(); void w.dshUI.openLink(url.href).catch(() => {}) }
        })
        description.replaceChildren(link)
      }
    } catch { /* Text-only source declarations keep a plain introduction. */ }
    card.querySelector('button')!.onclick = () => { pause(); animatePins(1); select(i); map.panTo([s.latitude, s.longitude]) }
    cards.push(card)
  })
  const points = spec.stops.map(s => [s.latitude, s.longitude])
  if (points.length > 1) L.polyline(points, { color: '#65a5f5', weight: 3, dashArray: '6 6' }).addTo(map)
  let fitted = false
  function fit() {
    // The parent iframe may still have zero width during its parser's first turn.
    // Fitting then chooses an invalid scale; let the first real resize fit once.
    map.invalidateSize({ pan: false })
    const size = map.getSize(); if (size.x < 80 || size.y < 80) return
    if (points.length === 1) map.setView(points[0], streetData ? 14 : 5, { animate: false })
    else map.fitBounds(L.latLngBounds(points), { padding: [35, 35], maxZoom: 16, animate: false })
    if (streetData) map.setMinZoom(Math.max(1, map.getBoundsZoom([[streetData.bounds[0], streetData.bounds[1]], [streetData.bounds[2], streetData.bounds[3]]], false)))
    fitted = true
  }
  fit(); select(0)
  let frame = 0, elapsed = 0, previous = 0, playing = false, disposed = false
  const progress = byId('trip-progress') as HTMLProgressElement
  function pause() { playing = false; previous = 0; cancelAnimationFrame(frame); byId('trip-play').textContent = elapsed >= spec.durationMs ? '重新播放' : '继续播放' }
  function tick(time: number) {
    if (!playing || disposed) return
    if (previous) elapsed = Math.min(spec.durationMs, elapsed + Math.min(100, time - previous))
    previous = time; progress.value = elapsed / spec.durationMs
    select(Math.min(cards.length - 1, Math.floor(progress.value * cards.length)))
    animatePins(progress.value)
    if (elapsed >= spec.durationMs) { pause(); return }
    frame = requestAnimationFrame(tick)
  }
  function play() {
    if (disposed || playing) return
    if (elapsed >= spec.durationMs) elapsed = 0
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { elapsed = spec.durationMs; progress.value = 1; select(cards.length - 1); animatePins(1); return }
    playing = true; previous = 0; byId('trip-play').textContent = '播放中'; frame = requestAnimationFrame(tick)
  }
  byId('trip-play').onclick = play; byId('trip-pause').onclick = pause
  byId('trip-reset').onclick = () => { pause(); elapsed = 0; progress.value = 0; select(0); fit(); play() }
  byId('trip-fit').onclick = fit
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause() })
  const dispose = () => { if (disposed) return; disposed = true; pause(); resize.disconnect(); map.remove() }
  const resize = new ResizeObserver(() => { map.invalidateSize({ pan: false }); if (!fitted) fit() }); resize.observe(byId('iui-map'))
  window.addEventListener('pagehide', dispose, { once: true }); window.addEventListener('unload', dispose, { once: true })
  window.addEventListener('dsh-ui-dispose', dispose, { once: true })
}

export interface ChartSpec { title: string; kind: 'bar' | 'pie'; labels: string[]; values: number[]; unit: string; source: string }
export function chartDocument(spec: ChartSpec): UiDocument {
  if (!short(spec.title, 200) || !['bar', 'pie'].includes(spec.kind) || !Array.isArray(spec.labels) || spec.labels.length < 1 || spec.labels.length > 50
    || !spec.labels.every(s => short(s, 100)) || !Array.isArray(spec.values) || spec.values.length !== spec.labels.length || !spec.values.every(v => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 1e15 && (spec.kind !== 'pie' || v >= 0))
    || spec.kind === 'pie' && !spec.values.some(v => v > 0) || !short(spec.source, 1000) || !short(spec.unit, 40)) throw new Error('Invalid chart data: 1–50 aligned labels/finite values, unit and source required; pie requires nonnegative values and a positive total.')
  return { version: 2, libraries: ['chartjs-4.5.1'], title: spec.title, description: spec.source, height: 520,
    html: `<header class="iui-page-header"><div><p class="iui-eyebrow">数据概览</p><h2>${escape(spec.title)}</h2></div><span class="iui-badge">${escape(spec.unit)}</span></header><div style="height:320px"><canvas id="native-chart" aria-label="${escape(spec.title)}" role="img"></canvas></div><p class="note">单位：${escape(spec.unit)} · ${escape(spec.source)}</p><details><summary>查看数据</summary><div class="table-scroll"><table><tbody>${spec.labels.map((label, i) => `<tr><th scope="row">${escape(label)}</th><td>${spec.values[i]} ${escape(spec.unit)}</td></tr>`).join('')}</tbody></table></div></details>`, css: '',
    javascript: `(${chartRuntime.toString()})(${json(spec)});` }
}
function chartRuntime(spec: ChartSpec) {
  const w = window as any
  const colors = ['#538be8', '#21a58e', '#e9a443', '#b27cdf', '#e4707e', '#6cadc6']
  const chart = new w.Chart(document.getElementById('native-chart'), { type: spec.kind, data: { labels: spec.labels, datasets: [{ label: spec.unit, data: spec.values, backgroundColor: spec.labels.map((_, i) => colors[i % colors.length]) }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: spec.kind === 'pie' } }, ...(spec.kind === 'bar' ? { scales: { y: { beginAtZero: true } } } : {}) } })
  const update = () => { const theme = w.dshUI.getTheme(), c = theme.colors; chart.options.color = c.text; chart.options.font = { size: theme.fontSize, family: theme.fontFamily }; chart.data.datasets[0].backgroundColor = spec.labels.map((_, i) => c['chart' + (i % 6 + 1)]); if (chart.options.scales) for (const scale of Object.values(chart.options.scales) as any[]) { scale.ticks = { color: c.text }; scale.grid = { color: c.grid } }; chart.update('none') }; update(); w.dshUI.onThemeChange(update)
}

export function planDocument(approach: string, technology: string, elements: string[]): UiDocument {
  if (!short(approach, 1000) || !short(technology, 200) || !Array.isArray(elements) || elements.length < 2 || elements.length > 4 || !elements.every(s => short(s, 300))) throw new Error('Plan requires approach, technology and 2–4 key elements.')
  return { version: 1, title: '可视化方案', description: approach, height: 260, html: `<section><header class="iui-section-heading"><div><p class="iui-eyebrow">展示方案</p><h2>可视化方案</h2></div><span class="iui-badge">${escape(technology)}</span></header><p>${escape(approach)}</p><ul class="iui-plan-elements">${elements.map(s => `<li>${escape(s)}</li>`).join('')}</ul></section>`, css: '', javascript: '' }
}
export function workflowDocument(title: string, items: { title: string; description: string; status: string }[]): UiDocument {
  if (!short(title, 200) || !Array.isArray(items) || items.length > 30 || !items.length || !items.every(s => short(s.title, 200) && typeof s.description === 'string' && s.description.length <= 1000 && ['pending', 'in_progress', 'completed'].includes(s.status))) throw new Error('Workflow requires 1–30 valid steps.')
  const completed = items.filter(s => s.status === 'completed').length
  return { version: 1, title, description: '工作流进度', height: 340, css: '', javascript: '', html: `<section class="iui-workflow"><header class="iui-section-heading"><div><p class="iui-eyebrow">工作流</p><h2>${escape(title)}</h2></div><span class="iui-badge">${completed} / ${items.length} 已完成</span></header><progress value="${completed}" max="${items.length}" aria-label="工作流完成进度"></progress><ol class="iui-steps">${items.map((s, i) => `<li data-status="${s.status}"${s.status === 'in_progress' ? ' aria-current="step"' : ''}><span class="iui-step-marker" aria-hidden="true">${s.status === 'completed' ? '✓' : i + 1}</span><div class="iui-step-content"><div class="iui-step-heading"><strong>${escape(s.title)}</strong><span class="iui-badge" data-status="${s.status}">${{ pending: '待开始', in_progress: '进行中', completed: '已完成' }[s.status]}</span></div><p>${escape(s.description)}</p></div></li>`).join('')}</ol></section>` }
}
export function meetingDocument(value: { title?: string; status: string; selected?: string; custom?: string; timezone?: string; durationMinutes?: number }): UiDocument {
  const status = { selected: '已选择会议时间', custom: '已提交其他时间', declined: '暂未选择时间', cancelled: '已取消选择', timeout: '选择时间已结束' }[value.status] ?? '会议时间'
  let displayTime = value.selected || value.custom || ''
  if (value.selected && Number.isFinite(Date.parse(value.selected))) {
    try { displayTime = new Intl.DateTimeFormat('zh-CN', { timeZone: value.timezone, dateStyle: 'full', timeStyle: 'short' }).format(new Date(value.selected)) } catch { /* Retain the original timestamp when replaying an unknown zone. */ }
  }
  return { version: 1, title: value.title || '会议时间', description: status, height: 240, css: '', javascript: '', html: `<section><header class="iui-section-heading"><div><p class="iui-eyebrow">会议时间</p><h2>${escape(value.title || '会议时间')}</h2></div><span class="iui-badge" data-status="${escape(value.status)}">${escape(status)}</span></header>${displayTime ? `<p class="iui-meeting-time">${escape(displayTime)}</p>` : ''}<p class="iui-meta"><span>${escape(value.timezone || '')}</span>${value.durationMinutes ? `<span>· ${value.durationMinutes} 分钟</span>` : ''}</p>${value.selected ? `<time class="iui-sr-only" datetime="${escape(value.selected)}">${escape(value.selected)}</time>` : ''}</section>` }
}
