import { collectFontUsage, fontLinkTags } from './fonts.ts'
import { resolveBlurs, resolveBoxShadow, resolveFills } from './paint.ts'
import { textBoxRules, textContentHtml } from './text.ts'
import {
  FigmaLayoutPositioning,
  FigmaNodeType,
  type FigmaBoundingBox,
  type FigmaNode,
  type NodeToHtmlOptions,
} from './types.ts'

export type { FigmaNode, NodeToHtmlOptions } from './types.ts'

const JUSTIFY_CONTENT: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
}

const ALIGN_ITEMS: Record<string, string> = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  BASELINE: 'baseline',
}

function isAutoLayout(layoutMode?: string): boolean {
  return layoutMode === 'HORIZONTAL' || layoutMode === 'VERTICAL'
}

function resolveCornerRadius(node: FigmaNode): string[] {
  if (node.type === FigmaNodeType.Ellipse) return ['border-radius: 50%;']
  if (node.rectangleCornerRadii) {
    const [topLeft, topRight, bottomRight, bottomLeft] = node.rectangleCornerRadii
    return [`border-radius: ${topLeft}px ${topRight}px ${bottomRight}px ${bottomLeft}px;`]
  }
  if (node.cornerRadius) return [`border-radius: ${node.cornerRadius}px;`]
  return []
}

function sizeRule(box: FigmaBoundingBox): string {
  return `width: ${Math.round(box.width)}px; height: ${Math.round(box.height)}px;`
}

interface Placement {
  rules: string[]
  /** Absolute placement already makes the node the reference point for its own absolute children. */
  isAbsolute: boolean
}

/**
 * Where the node sits inside its parent: in the flex flow of an auto-layout parent, at an offset
 * from the parent's corner, or (for the root) at its natural place with a fixed size.
 */
function resolvePlacement(node: FigmaNode, parentBox?: FigmaBoundingBox, parentLayoutMode?: string): Placement {
  const box = node.absoluteBoundingBox
  const isFloatingInAutoLayout = node.layoutPositioning === FigmaLayoutPositioning.Absolute
  const isInFlow = isAutoLayout(parentLayoutMode) && !isFloatingInAutoLayout

  if (isInFlow) {
    const rules: string[] = []
    if (node.layoutGrow === 1) rules.push('flex: 1 1 0%;')
    else if (box) rules.push(`${sizeRule(box)} flex-shrink: 0;`)
    if (node.layoutAlign === 'STRETCH') rules.push('align-self: stretch;')
    return { rules, isAbsolute: false }
  }

  if (box && parentBox) {
    const left = Math.round(box.x - parentBox.x)
    const top = Math.round(box.y - parentBox.y)
    return { rules: [`position: absolute; left: ${left}px; top: ${top}px; ${sizeRule(box)}`], isAbsolute: true }
  }

  return { rules: box ? [sizeRule(box)] : [], isAbsolute: false }
}

function autoLayoutRules(node: FigmaNode): string[] {
  const rules = ['display: flex;', `flex-direction: ${node.layoutMode === 'VERTICAL' ? 'column' : 'row'};`]

  const justify = node.primaryAxisAlignItems ? JUSTIFY_CONTENT[node.primaryAxisAlignItems] : undefined
  const align = node.counterAxisAlignItems ? ALIGN_ITEMS[node.counterAxisAlignItems] : undefined
  if (justify) rules.push(`justify-content: ${justify};`)
  if (align) rules.push(`align-items: ${align};`)
  if (node.itemSpacing) rules.push(`gap: ${node.itemSpacing}px;`)

  const top = node.paddingTop ?? 0
  const right = node.paddingRight ?? 0
  const bottom = node.paddingBottom ?? 0
  const left = node.paddingLeft ?? 0
  if (top || right || bottom || left) rules.push(`padding: ${top}px ${right}px ${bottom}px ${left}px;`)
  return rules
}

function renderSvgExport(node: FigmaNode, assetUrl: string, placement: Placement): string {
  /* Figma sizes the SVG to the node's box; the img fills exactly that box */
  const rules = ['box-sizing: border-box;', 'display: block;', ...placement.rules]
  if (node.opacity !== undefined && node.opacity < 1) rules.push(`opacity: ${node.opacity};`)
  return `<img src="${assetUrl}" alt="" style="${rules.join(' ')}">`
}

function renderText(node: FigmaNode, placement: Placement): string {
  const rules = ['box-sizing: border-box;', ...placement.rules]
  if (node.opacity !== undefined && node.opacity < 1) rules.push(`opacity: ${node.opacity};`)
  rules.push(...textBoxRules(node), ...resolveBlurs(node.effects))
  return `<div style="${rules.join(' ')}">${textContentHtml(node)}</div>`
}

function renderNode(
  node: FigmaNode,
  parentBox?: FigmaBoundingBox,
  parentLayoutMode?: string,
  options: NodeToHtmlOptions = {},
): string {
  if (node.visible === false) return ''

  const box = node.absoluteBoundingBox
  const placement = resolvePlacement(node, parentBox, parentLayoutMode)

  const svgUrl = options.svgMap?.[node.id]
  if (svgUrl) return renderSvgExport(node, svgUrl, placement)
  if (node.type === FigmaNodeType.Text) return renderText(node, placement)

  const rules = ['box-sizing: border-box;']
  if (node.opacity !== undefined && node.opacity < 1) rules.push(`opacity: ${node.opacity};`)
  if (node.clipsContent) rules.push('overflow: hidden;')
  rules.push(...resolveCornerRadius(node), ...resolveBoxShadow(node), ...resolveBlurs(node.effects))
  rules.push(...placement.rules)
  rules.push(...resolveFills(node.fills, box, options.imageMap))

  if (isAutoLayout(node.layoutMode)) rules.push(...autoLayoutRules(node))

  /* Absolutely placed children measure from this node, so it must be a reference point itself.
     (An absolute node already is one: adding relative on top would cancel its offsets.) */
  if (node.children?.length && !placement.isAbsolute) rules.push('position: relative;')

  const childrenHtml = (node.children ?? [])
    .map((child) => renderNode(child, box, node.layoutMode, options))
    .filter(Boolean)
    .join('')

  return `<div style="${rules.join(' ')}">${childrenHtml}</div>`
}

export function figmaNodeToHtml(rootNode: FigmaNode, options: NodeToHtmlOptions = {}): string {
  const box = rootNode.absoluteBoundingBox
  const width = box ? Math.round(box.width) : 800
  const height = box ? Math.round(box.height) : 600

  const bodyContent = renderNode(rootNode, undefined, undefined, options)
  const metaSource = options.sourceUrl
    ? `\n  <meta name="doop-import-source" content="${encodeURIComponent(options.sourceUrl)}">`
    : ''
  const fontLinks = fontLinkTags(collectFontUsage(rootNode))
  const fontLinksBlock = fontLinks ? `\n  ${fontLinks}` : ''

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">${metaSource}${fontLinksBlock}
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  </style>
</head>
<body style="width: ${width}px; height: ${height}px; overflow: hidden; background: transparent;">
  ${bodyContent}
</body>
</html>`
}
