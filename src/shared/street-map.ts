export type MapPoint = [number, number] // latitude, longitude, WGS84
export interface StreetFeature { kind: 'road' | 'water' | 'park' | 'building' | 'label'; name: string; paths: MapPoint[][]; major: boolean }
export interface StreetMap { version: 1; bounds: [number, number, number, number]; features: StreetFeature[]; fetchedAt: number }
export const MAX_MAP_CHARS = 125000
export function parseStreetMap(input: unknown): StreetMap | null {
  if (!input || typeof input !== 'object') return null
  const d = input as StreetMap
  if (d.version !== 1 || !Array.isArray(d.bounds) || d.bounds.length !== 4 || !d.bounds.every(Number.isFinite)
    || d.bounds[0] >= d.bounds[2] || d.bounds[1] >= d.bounds[3] || Math.abs(d.bounds[0]) > 85.1 || Math.abs(d.bounds[2]) > 85.1 || Math.abs(d.bounds[1]) > 180 || Math.abs(d.bounds[3]) > 180
    || !Array.isArray(d.features) || d.features.length < 1 || d.features.length > 700 || !Number.isFinite(d.fetchedAt) || JSON.stringify(d).length > MAX_MAP_CHARS) return null
  const features: StreetFeature[] = []
  for (const f of d.features) {
    if (!f || !['road', 'water', 'park', 'building', 'label'].includes(f.kind) || typeof f.name !== 'string' || f.name.length > 100 || typeof f.major !== 'boolean'
      || !Array.isArray(f.paths) || f.paths.length < 1 || f.paths.length > 8) return null
    for (const path of f.paths) {
      if (!Array.isArray(path) || !path.length || path.length > 128 || path.some(p => !Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 85.1 || Math.abs(p[1]) > 180)) return null
    }
    features.push({ kind: f.kind, name: f.name, paths: f.paths.map(path => path.map(p => [p[0], p[1]])), major: f.major })
  }
  return { version: 1, bounds: [...d.bounds], fetchedAt: d.fetchedAt, features }
}
