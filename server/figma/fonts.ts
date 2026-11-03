import { safeFontFamily } from './text.ts'
import type { FigmaNode, FigmaTypeStyle } from './types.ts'

const MAX_FONT_FAMILIES = 8
const GOOGLE_FONTS_ORIGIN = 'https://fonts.googleapis.com'
const GOOGLE_FONTS_FILE_ORIGIN = 'https://fonts.gstatic.com'
const GOOGLE_FAMILY_PATTERN = /^[A-Za-z0-9 ]{1,60}$/
const DEFAULT_FONT_WEIGHT = 400

interface FontVariant {
  italic: boolean
  weight: number
}

/** Font family to the weights and slants the design actually uses. */
export type FontUsage = Map<string, Map<string, FontVariant>>

function recordStyle(style: FigmaTypeStyle | undefined, usage: FontUsage): void {
  if (!style?.fontFamily) return
  const family = safeFontFamily(style.fontFamily)
  if (!GOOGLE_FAMILY_PATTERN.test(family)) return

  const weight = Math.round(style.fontWeight ?? DEFAULT_FONT_WEIGHT)
  const variant: FontVariant = { italic: Boolean(style.italic), weight }
  const variants = usage.get(family) ?? new Map<string, FontVariant>()
  variants.set(`${variant.italic ? 1 : 0}-${weight}`, variant)
  usage.set(family, variants)
}

export function collectFontUsage(node: FigmaNode, usage: FontUsage = new Map()): FontUsage {
  if (node.visible === false) return usage
  recordStyle(node.style, usage)
  for (const override of Object.values(node.styleOverrideTable ?? {})) {
    /* an override often changes only the colour, so it inherits the base family */
    recordStyle({ ...node.style, ...override }, usage)
  }
  for (const child of node.children ?? []) collectFontUsage(child, usage)
  return usage
}

function googleFontsUrl(family: string, variants: FontVariant[]): string {
  const sorted = [...variants].sort((a, b) => Number(a.italic) - Number(b.italic) || a.weight - b.weight)
  const hasItalic = sorted.some((variant) => variant.italic)
  const axes = hasItalic
    ? `ital,wght@${sorted.map((variant) => `${variant.italic ? 1 : 0},${variant.weight}`).join(';')}`
    : `wght@${sorted.map((variant) => variant.weight).join(';')}`
  return `${GOOGLE_FONTS_ORIGIN}/css2?family=${family.replace(/ /g, '+')}:${axes}&display=swap`
}

/**
 * One stylesheet per family: Google answers the whole request with an error when any single
 * family is unknown to it (a private or system font), which would drop the fonts that do exist.
 */
export function fontLinkTags(usage: FontUsage): string {
  if (!usage.size) return ''
  const stylesheets = [...usage.entries()]
    .slice(0, MAX_FONT_FAMILIES)
    .map(([family, variants]) => `<link rel="stylesheet" href="${googleFontsUrl(family, [...variants.values()])}">`)
  return [
    `<link rel="preconnect" href="${GOOGLE_FONTS_ORIGIN}">`,
    `<link rel="preconnect" href="${GOOGLE_FONTS_FILE_ORIGIN}" crossorigin>`,
    ...stylesheets,
  ].join('\n  ')
}
