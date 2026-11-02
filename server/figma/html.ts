export interface FigmaColor {
  r: number
  g: number
  b: number
  a?: number
}

export interface FigmaPaint {
  type: 'SOLID' | 'IMAGE' | 'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | string
  visible?: boolean
  opacity?: number
  color?: FigmaColor
  imageRef?: string
  scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE' | string
  gradientStops?: { position: number; color: FigmaColor }[]
}

export interface FigmaEffect {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR' | string
  visible?: boolean
  color?: FigmaColor
  offset?: { x: number; y: number }
  radius?: number
  spread?: number
}

export interface FigmaTypeStyle {
  fontFamily?: string
  fontWeight?: number
  fontSize?: number
  textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED' | string
  textAlignVertical?: 'TOP' | 'CENTER' | 'BOTTOM' | string
  letterSpacing?: number
  lineHeightPx?: number
  italic?: boolean
}

export interface FigmaBoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface FigmaNode {
  id: string
  name: string
  type: string
  visible?: boolean
  opacity?: number
  absoluteBoundingBox?: FigmaBoundingBox
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | string
  primaryAxisAlignItems?: 'MIN' | 'MAX' | 'CENTER' | 'SPACE_BETWEEN' | string
  counterAxisAlignItems?: 'MIN' | 'MAX' | 'CENTER' | 'BASELINE' | string
  itemSpacing?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  cornerRadius?: number
  rectangleCornerRadii?: [number, number, number, number]
  clipsContent?: boolean
  fills?: FigmaPaint[]
  strokes?: FigmaPaint[]
  strokeWeight?: number
  effects?: FigmaEffect[]
  style?: FigmaTypeStyle
  characters?: string
  layoutGrow?: number
  layoutAlign?: 'STRETCH' | 'INHERIT' | string
  children?: FigmaNode[]
}

export interface NodeToHtmlOptions {
  imageMap?: Record<string, string>
  sourceUrl?: string
}

function colorToRgba(color?: FigmaColor, opacity = 1): string {
  if (!color) return 'transparent'
  const red = Math.round((color.r ?? 0) * 255)
  const green = Math.round((color.g ?? 0) * 255)
  const blue = Math.round((color.b ?? 0) * 255)
  const alpha = (color.a ?? 1) * opacity
  return `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(3))})`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function resolveFills(fills?: FigmaPaint[], imageMap: Record<string, string> = {}): string[] {
  if (!fills || !fills.length) return []
  const styles: string[] = []

  for (const fill of fills) {
    if (fill.visible === false) continue
    const opacity = fill.opacity ?? 1

    if (fill.type === 'SOLID' && fill.color) {
      styles.push(`background-color: ${colorToRgba(fill.color, opacity)};`)
    } else if (fill.type === 'IMAGE' && fill.imageRef) {
      const imageUrl = imageMap[fill.imageRef]
      if (imageUrl) {
        const size = fill.scaleMode === 'FIT' ? 'contain' : 'cover'
        styles.push(
          `background-image: url('${imageUrl}'); background-size: ${size}; background-position: center; background-repeat: no-repeat;`,
        )
      }
    } else if (fill.type === 'GRADIENT_LINEAR' && fill.gradientStops?.length) {
      const stops = fill.gradientStops
        .map((stop) => `${colorToRgba(stop.color)} ${Math.round(stop.position * 100)}%`)
        .join(', ')
      styles.push(`background: linear-gradient(180deg, ${stops});`)
    }
  }

  return styles
}

function resolveStrokes(strokes?: FigmaPaint[], strokeWeight?: number): string[] {
  if (!strokes || !strokes.length || !strokeWeight) return []
  const stroke = strokes.find((s) => s.visible !== false)
  if (!stroke || !stroke.color) return []
  return [`border: ${strokeWeight}px solid ${colorToRgba(stroke.color, stroke.opacity ?? 1)};`]
}

function resolveEffects(effects?: FigmaEffect[]): string[] {
  if (!effects || !effects.length) return []
  const shadows: string[] = []

  for (const effect of effects) {
    if (effect.visible === false) continue
    const radius = effect.radius ?? 0
    const spread = effect.spread ?? 0
    const x = effect.offset?.x ?? 0
    const y = effect.offset?.y ?? 0
    const color = colorToRgba(effect.color)

    if (effect.type === 'DROP_SHADOW') {
      shadows.push(`${x}px ${y}px ${radius}px ${spread}px ${color}`)
    } else if (effect.type === 'INNER_SHADOW') {
      shadows.push(`inset ${x}px ${y}px ${radius}px ${spread}px ${color}`)
    }
  }

  if (shadows.length) {
    return [`box-shadow: ${shadows.join(', ')};`]
  }
  return []
}

function resolveCornerRadius(node: FigmaNode): string[] {
  if (node.type === 'ELLIPSE') {
    return ['border-radius: 50%;']
  }
  if (node.rectangleCornerRadii) {
    const [tl, tr, br, bl] = node.rectangleCornerRadii
    return [`border-radius: ${tl}px ${tr}px ${br}px ${bl}px;`]
  }
  if (node.cornerRadius) {
    return [`border-radius: ${node.cornerRadius}px;`]
  }
  return []
}

function resolveTextStyle(style?: FigmaTypeStyle): string[] {
  if (!style) return []
  const styles: string[] = []

  if (style.fontFamily) {
    styles.push(`font-family: '${style.fontFamily}', -apple-system, BlinkMacSystemFont, sans-serif;`)
  }
  if (style.fontSize) {
    styles.push(`font-size: ${style.fontSize}px;`)
  }
  if (style.fontWeight) {
    styles.push(`font-weight: ${style.fontWeight};`)
  }
  if (style.italic) {
    styles.push('font-style: italic;')
  }
  if (style.lineHeightPx) {
    styles.push(`line-height: ${Math.round(style.lineHeightPx)}px;`)
  }
  if (style.letterSpacing) {
    styles.push(`letter-spacing: ${style.letterSpacing}px;`)
  }
  if (style.textAlignHorizontal) {
    const alignMap: Record<string, string> = {
      LEFT: 'left',
      CENTER: 'center',
      RIGHT: 'right',
      JUSTIFIED: 'justify',
    }
    const cssAlign = alignMap[style.textAlignHorizontal]
    if (cssAlign) styles.push(`text-align: ${cssAlign};`)
  }

  return styles
}

function renderNode(
  node: FigmaNode,
  parentBox?: FigmaBoundingBox,
  parentLayoutMode?: string,
  options: NodeToHtmlOptions = {},
): string {
  if (node.visible === false) return ''

  const box = node.absoluteBoundingBox
  const styleRules: string[] = ['box-sizing: border-box;']

  if (node.opacity !== undefined && node.opacity < 1) {
    styleRules.push(`opacity: ${node.opacity};`)
  }

  if (node.clipsContent) {
    styleRules.push('overflow: hidden;')
  }

  styleRules.push(...resolveCornerRadius(node))
  styleRules.push(...resolveStrokes(node.strokes, node.strokeWeight))
  styleRules.push(...resolveEffects(node.effects))

  const isAutoLayoutParent = parentLayoutMode === 'HORIZONTAL' || parentLayoutMode === 'VERTICAL'

  if (isAutoLayoutParent) {
    if (node.layoutGrow === 1) {
      styleRules.push('flex: 1 1 0%;')
    } else if (box) {
      styleRules.push(`width: ${Math.round(box.width)}px; height: ${Math.round(box.height)}px; flex-shrink: 0;`)
    }
    if (node.layoutAlign === 'STRETCH') {
      styleRules.push('align-self: stretch;')
    }
  } else if (box && parentBox) {
    const leftOffset = Math.round(box.x - parentBox.x)
    const topOffset = Math.round(box.y - parentBox.y)
    styleRules.push(
      `position: absolute; left: ${leftOffset}px; top: ${topOffset}px; width: ${Math.round(
        box.width,
      )}px; height: ${Math.round(box.height)}px;`,
    )
  } else if (box) {
    styleRules.push(`width: ${Math.round(box.width)}px; height: ${Math.round(box.height)}px;`)
  }

  if (node.type === 'TEXT') {
    styleRules.push(...resolveTextStyle(node.style))
    styleRules.push('white-space: pre-wrap; word-break: break-word;')

    const fillPaint = node.fills?.find((f) => f.visible !== false)
    if (fillPaint?.color) {
      styleRules.push(`color: ${colorToRgba(fillPaint.color, fillPaint.opacity ?? 1)};`)
    } else {
      styleRules.push('color: #000000;')
    }

    const content = escapeHtml(node.characters ?? '')
    return `<div style="${styleRules.join(' ')}">${content}</div>`
  }

  styleRules.push(...resolveFills(node.fills, options.imageMap))

  const hasAutoLayout = node.layoutMode === 'HORIZONTAL' || node.layoutMode === 'VERTICAL'
  if (hasAutoLayout) {
    styleRules.push('display: flex;')
    styleRules.push(`flex-direction: ${node.layoutMode === 'VERTICAL' ? 'column' : 'row'};`)

    const justifyMap: Record<string, string> = {
      MIN: 'flex-start',
      CENTER: 'center',
      MAX: 'flex-end',
      SPACE_BETWEEN: 'space-between',
    }
    const alignMap: Record<string, string> = {
      MIN: 'flex-start',
      CENTER: 'center',
      MAX: 'flex-end',
      BASELINE: 'baseline',
    }

    if (node.primaryAxisAlignItems && justifyMap[node.primaryAxisAlignItems]) {
      styleRules.push(`justify-content: ${justifyMap[node.primaryAxisAlignItems]};`)
    }
    if (node.counterAxisAlignItems && alignMap[node.counterAxisAlignItems]) {
      styleRules.push(`align-items: ${alignMap[node.counterAxisAlignItems]};`)
    }

    if (node.itemSpacing) {
      styleRules.push(`gap: ${node.itemSpacing}px;`)
    }

    const padTop = node.paddingTop ?? 0
    const padRight = node.paddingRight ?? 0
    const padBottom = node.paddingBottom ?? 0
    const padLeft = node.paddingLeft ?? 0
    if (padTop || padRight || padBottom || padLeft) {
      styleRules.push(`padding: ${padTop}px ${padRight}px ${padBottom}px ${padLeft}px;`)
    }
  } else if (!isAutoLayoutParent && node.children?.length) {
    styleRules.push('position: relative;')
  }

  const childHtmlList = (node.children ?? [])
    .map((child) => renderNode(child, box, node.layoutMode, options))
    .filter(Boolean)

  return `<div style="${styleRules.join(' ')}">${childHtmlList.join('')}</div>`
}

export function figmaNodeToHtml(rootNode: FigmaNode, options: NodeToHtmlOptions = {}): string {
  const box = rootNode.absoluteBoundingBox
  const width = box ? Math.round(box.width) : 800
  const height = box ? Math.round(box.height) : 600

  const bodyContent = renderNode(rootNode, undefined, undefined, options)
  const metaSource = options.sourceUrl
    ? `\n  <meta name="doop-import-source" content="${encodeURIComponent(options.sourceUrl)}">`
    : ''

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">${metaSource}
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
