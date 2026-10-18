/** Persist the exact runtime contract; upgrades add a new ID rather than changing old documents. */
export const CHART_LIBRARY = 'chartjs-4.5.1' as const
export const CHART_VERSION = '4.5.1'
export const MAP_LIBRARY = 'leaflet-1.9.4' as const
export const UI_LIBRARIES = [CHART_LIBRARY, MAP_LIBRARY] as const
export type UiLibrary = typeof UI_LIBRARIES[number]

export function parseLibraries(value: unknown): UiLibrary[] | null {
  if (!Array.isArray(value) || value.length > 2 || new Set(value).size !== value.length || value.some(item => !UI_LIBRARIES.includes(item))) return null
  return [...value] as UiLibrary[]
}
