export type UiScheme = 'light' | 'dark'
const light = {
  bg: '#ffffff', surface: '#f7f7f8', raised: '#f0f1f2', text: '#0f1115', muted: '#66686c', border: '#e0e1e4',
  accent: '#2858c6', accentSoft: '#e8efff', error: '#b91c1c', success: '#087f5b', warning: '#a16207', focus: '#1d4ed8',
  chart1: '#2563eb', chart2: '#0f766e', chart3: '#a16207', chart4: '#7e22ce', chart5: '#be123c', chart6: '#475569', grid: '#d8dee9',
}
export type UiColors = Record<keyof typeof light, string>
const dark: UiColors = {
  bg: '#151517', surface: '#1e2025', raised: '#282c34', text: '#edf0f5', muted: '#b5bfce', border: '#3b3d42',
  accent: '#a9c5ff', accentSoft: '#26364f', error: '#fca5a5', success: '#6ee7b7', warning: '#fde68a', focus: '#93c5fd',
  chart1: '#93c5fd', chart2: '#5eead4', chart3: '#fcd34d', chart4: '#c4b5fd', chart5: '#fda4af', chart6: '#cbd5e1', grid: '#4a5262',
}
export interface UiTheme { version: 1; scheme: UiScheme; colors: UiColors; fontSize: number; fontFamily: string }
export const UI_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif'
export function makeTheme(scheme: UiScheme = 'light'): UiTheme {
  return { version: 1, scheme, colors: { ...(scheme === 'dark' ? dark : light) }, fontSize: 14, fontFamily: UI_FONT }
}
export const DEFAULT_THEME = makeTheme()
export const colorVariable = (key: string) => `--iui-${key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())}`
export function themeVariables(theme: UiTheme): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(theme.colors).map(([key, value]) => [colorVariable(key), value])),
    '--iui-font-family': theme.fontFamily, '--iui-font-size': `${theme.fontSize}px` }
}

export { CONTENT_STYLES as TEMPLATE_STYLES, SHELL_STYLES as WIDGET_STYLES } from './design-system.ts'
