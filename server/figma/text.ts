import { colorToRgba, resolveTextShadow } from './paint.ts'
import {
  FigmaTextAlignVertical,
  FigmaTextAutoResize,
  FigmaTextCase,
  FigmaTextDecoration,
  type FigmaNode,
  type FigmaPaint,
  type FigmaTypeStyle,
} from './types.ts'

const DEFAULT_TEXT_COLOR = '#000000'
const FALLBACK_FONT_STACK = '-apple-system, BlinkMacSystemFont, sans-serif'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Font names come from the design file, so they never reach a style attribute unfiltered. */
export function safeFontFamily(family: string): string {
  return family.replace(/[^\w\s.-]/g, '').trim()
}

function firstVisibleSolidColor(fills?: FigmaPaint[]): string | undefined {
  const paint = fills?.find((fill) => fill.visible !== false && fill.color)
  return paint?.color ? colorToRgba(paint.color, paint.opacity ?? 1) : undefined
}

function textTypeRules(style: FigmaTypeStyle): string[] {
  const rules: string[] = []
  const family = style.fontFamily ? safeFontFamily(style.fontFamily) : ''
  if (family) rules.push(`font-family: '${family}', ${FALLBACK_FONT_STACK};`)
  if (style.fontSize) rules.push(`font-size: ${style.fontSize}px;`)
  if (style.fontWeight) rules.push(`font-weight: ${style.fontWeight};`)
  if (style.italic) rules.push('font-style: italic;')
  if (style.lineHeightPx) rules.push(`line-height: ${Number(style.lineHeightPx.toFixed(2))}px;`)
  if (style.letterSpacing) rules.push(`letter-spacing: ${Number(style.letterSpacing.toFixed(2))}px;`)
  if (style.textCase === FigmaTextCase.Upper) rules.push('text-transform: uppercase;')
  if (style.textCase === FigmaTextCase.Lower) rules.push('text-transform: lowercase;')
  if (style.textCase === FigmaTextCase.Title) rules.push('text-transform: capitalize;')
  if (style.textDecoration === FigmaTextDecoration.Underline) rules.push('text-decoration: underline;')
  if (style.textDecoration === FigmaTextDecoration.Strikethrough) rules.push('text-decoration: line-through;')
  return rules
}

const TEXT_ALIGN: Record<string, string> = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' }

const VERTICAL_ALIGN_TO_FLEX: Record<string, string> = {
  [FigmaTextAlignVertical.Center]: 'center',
  [FigmaTextAlignVertical.Bottom]: 'flex-end',
}

function verticalFlexAlignment(node: FigmaNode): string | undefined {
  return node.style?.textAlignVertical ? VERTICAL_ALIGN_TO_FLEX[node.style.textAlignVertical] : undefined
}

/**
 * A text box that Figma sizes to its content must never wrap here: the fallback font is often a
 * little wider than the real one, and wrapping would push lines out of their slot.
 */
export function textBoxRules(node: FigmaNode): string[] {
  const style = node.style ?? {}
  const rules = textTypeRules(style)

  const align = style.textAlignHorizontal ? TEXT_ALIGN[style.textAlignHorizontal] : undefined
  if (align) rules.push(`text-align: ${align};`)

  const isSizedToContent = style.textAutoResize === FigmaTextAutoResize.WidthAndHeight
  rules.push(isSizedToContent ? 'white-space: pre;' : 'white-space: pre-wrap; overflow-wrap: break-word;')

  const flexAlignment = verticalFlexAlignment(node)
  if (flexAlignment) {
    rules.push('display: flex;', 'flex-direction: column;', `justify-content: ${flexAlignment};`)
  }

  rules.push(`color: ${firstVisibleSolidColor(node.fills) ?? DEFAULT_TEXT_COLOR};`)
  rules.push(...resolveTextShadow(node.effects))
  return rules
}

function runStyleRules(override: FigmaTypeStyle): string[] {
  const rules = textTypeRules(override)
  const color = firstVisibleSolidColor(override.fills)
  if (color) rules.push(`color: ${color};`)
  return rules
}

/**
 * Figma stores mixed formatting as one override id per character, so a line such as
 * "~/term $ ls" arrives as a black base string plus colour overrides. Group equal ids into spans.
 */
function textRunsHtml(node: FigmaNode): string {
  const characters = node.characters ?? ''
  const overrides = node.characterStyleOverrides ?? []
  const table = node.styleOverrideTable ?? {}
  if (!overrides.some((id) => id !== 0)) return escapeHtml(characters)

  let html = ''
  let runStart = 0
  while (runStart < characters.length) {
    const runId = overrides[runStart] ?? 0
    let runEnd = runStart + 1
    while (runEnd < characters.length && (overrides[runEnd] ?? 0) === runId) runEnd++

    const runText = escapeHtml(characters.slice(runStart, runEnd))
    const override = runId === 0 ? undefined : table[String(runId)]
    const rules = override ? runStyleRules(override) : []
    html += rules.length ? `<span style="${rules.join(' ')}">${runText}</span>` : runText
    runStart = runEnd
  }
  return html
}

/** Content of a text box. Vertically centred text needs one wrapper, because flex turns each loose span into its own item. */
export function textContentHtml(node: FigmaNode): string {
  const runs = textRunsHtml(node)
  return verticalFlexAlignment(node) ? `<span>${runs}</span>` : runs
}
