import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import { makeTheme, type UiColors, type UiTheme } from '../shared/theme.ts'

const aliases: Partial<Record<keyof UiColors, string>> = {
  bg: '--dsw-alias-bg-base', surface: '--dsw-alias-bg-layer-1', raised: '--dsw-alias-bg-layer-2',
  text: '--dsw-alias-label-primary', muted: '--dsw-alias-label-secondary', border: '--dsw-alias-border-l2',
  accent: '--dsw-alias-brand-primary', error: '--dsw-alias-state-error-primary', success: '--dsw-alias-state-success-primary',
  warning: '--dsw-alias-state-warn-primary',
}
/** Read only public theme facts and selected resolved alias colors; never copy the host stylesheet. */
export function hostTheme(snapshot: ThemeSnapshot): UiTheme {
  const theme = makeTheme(snapshot.active.colorScheme)
  const style = typeof document !== 'undefined' ? getComputedStyle(document.body) : undefined
  for (const [key, alias] of Object.entries(aliases)) {
    const value = style?.getPropertyValue(alias).trim() || snapshot.active.tokens[alias]
    if (value && value.length <= 200 && typeof CSS !== 'undefined' && CSS.supports('color', value)
      && !value.includes('var(')) theme.colors[key as keyof UiColors] = value
  }
  const soft = `color-mix(in srgb, ${theme.colors.accent} 8%, ${theme.colors.bg})`
  if (soft.length <= 200 && typeof CSS !== 'undefined' && CSS.supports('color', soft)) theme.colors.accentSoft = soft
  const size = snapshot.fontSizes.text
  if (Number.isFinite(size) && size >= 8 && size <= 48) theme.fontSize = size
  const family = snapshot.fontFamilies.text
  if (family && family.length <= 300 && typeof CSS !== 'undefined' && CSS.supports('font-family', family)) theme.fontFamily = family
  return theme
}
