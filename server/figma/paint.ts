import {
  FigmaEffectType,
  FigmaPaintType,
  FigmaStrokeAlign,
  type FigmaBoundingBox,
  type FigmaColor,
  type FigmaEffect,
  type FigmaNode,
  type FigmaPaint,
  type FigmaVector2,
} from './types.ts'

/* Figma reports a blur "radius"; CSS wants the Gaussian standard deviation, which is half of it. */
const BLUR_RADIUS_TO_CSS_SIGMA = 0.5

function roundTo(value: number, decimals = 2): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export function colorToRgba(color?: FigmaColor, opacity = 1): string {
  if (!color) return 'transparent'
  const red = Math.round((color.r ?? 0) * 255)
  const green = Math.round((color.g ?? 0) * 255)
  const blue = Math.round((color.b ?? 0) * 255)
  const alpha = (color.a ?? 1) * opacity
  return `rgba(${red}, ${green}, ${blue}, ${Number(alpha.toFixed(3))})`
}

function colorStops(fill: FigmaPaint, opacity: number, toPercent: (position: number) => number): string {
  return (fill.gradientStops ?? [])
    .map((stop) => `${colorToRgba(stop.color, opacity)} ${roundTo(toPercent(stop.position))}%`)
    .join(', ')
}

function scaleToBox(point: FigmaVector2, box: FigmaBoundingBox): FigmaVector2 {
  return { x: point.x * box.width, y: point.y * box.height }
}

/**
 * Figma places a gradient on a handle line anywhere inside the box; CSS always spans the box
 * corner to corner along the angle. Convert the angle, then re-express each stop as a CSS percentage.
 */
function linearGradientCss(fill: FigmaPaint, opacity: number, box?: FigmaBoundingBox): string {
  const handles = fill.gradientHandlePositions
  const fallback = () => `linear-gradient(180deg, ${colorStops(fill, opacity, (position) => position * 100)})`
  if (!box || !handles || handles.length < 2) return fallback()

  const start = scaleToBox(handles[0]!, box)
  const end = scaleToBox(handles[1]!, box)
  const handleLength = Math.hypot(end.x - start.x, end.y - start.y)
  if (handleLength === 0) return fallback()

  const directionX = (end.x - start.x) / handleLength
  const directionY = (end.y - start.y) / handleLength
  const cssLength = Math.abs(box.width * directionX) + Math.abs(box.height * directionY)
  const cssStartX = box.width / 2 - (directionX * cssLength) / 2
  const cssStartY = box.height / 2 - (directionY * cssLength) / 2
  const startOffset = (start.x - cssStartX) * directionX + (start.y - cssStartY) * directionY

  const angleDegrees = (Math.atan2(directionX, -directionY) * 180) / Math.PI
  const cssAngle = roundTo((angleDegrees + 360) % 360)
  const stops = colorStops(fill, opacity, (position) => ((startOffset + position * handleLength) / cssLength) * 100)
  return `linear-gradient(${cssAngle}deg, ${stops})`
}

function radialGradientCss(fill: FigmaPaint, opacity: number, box?: FigmaBoundingBox): string {
  const handles = fill.gradientHandlePositions
  const stops = colorStops(fill, opacity, (position) => position * 100)
  if (!box || !handles || handles.length < 3) return `radial-gradient(ellipse at center, ${stops})`

  const center = scaleToBox(handles[0]!, box)
  const horizontalHandle = scaleToBox(handles[1]!, box)
  const verticalHandle = scaleToBox(handles[2]!, box)
  const radiusX = Math.hypot(horizontalHandle.x - center.x, horizontalHandle.y - center.y)
  const radiusY = Math.hypot(verticalHandle.x - center.x, verticalHandle.y - center.y)
  return `radial-gradient(${roundTo(radiusX)}px ${roundTo(radiusY)}px at ${roundTo(center.x)}px ${roundTo(center.y)}px, ${stops})`
}

interface BackgroundLayer {
  image: string
  size: string
  repeat: string
}

function paintToLayer(
  fill: FigmaPaint,
  box: FigmaBoundingBox | undefined,
  imageMap: Record<string, string>,
): BackgroundLayer | undefined {
  const opacity = fill.opacity ?? 1
  const gradientStopsPresent = Boolean(fill.gradientStops?.length)

  if (fill.type === FigmaPaintType.Solid && fill.color) {
    const color = colorToRgba(fill.color, opacity)
    return { image: `linear-gradient(${color}, ${color})`, size: 'auto', repeat: 'no-repeat' }
  }
  if (fill.type === FigmaPaintType.GradientLinear && gradientStopsPresent) {
    return { image: linearGradientCss(fill, opacity, box), size: 'auto', repeat: 'no-repeat' }
  }
  if (fill.type === FigmaPaintType.GradientRadial && gradientStopsPresent) {
    return { image: radialGradientCss(fill, opacity, box), size: 'auto', repeat: 'no-repeat' }
  }
  if (fill.type === FigmaPaintType.Image && fill.imageRef) {
    const imageUrl = imageMap[fill.imageRef]
    if (!imageUrl) return undefined
    const isTiled = fill.scaleMode === 'TILE'
    return {
      image: `url('${imageUrl}')`,
      size: isTiled ? 'auto' : fill.scaleMode === 'FIT' ? 'contain' : 'cover',
      repeat: isTiled ? 'repeat' : 'no-repeat',
    }
  }
  return undefined
}

/**
 * Figma lists fills bottom to top, CSS lists background layers top to bottom, so the order flips.
 * A lone solid fill stays a plain background-color so the output remains easy to edit by hand.
 */
export function resolveFills(
  fills: FigmaPaint[] | undefined,
  box: FigmaBoundingBox | undefined,
  imageMap: Record<string, string> = {},
): string[] {
  const visibleFills = (fills ?? []).filter((fill) => fill.visible !== false)
  if (!visibleFills.length) return []

  const [onlyFill] = visibleFills
  if (visibleFills.length === 1 && onlyFill?.type === FigmaPaintType.Solid && onlyFill.color) {
    return [`background-color: ${colorToRgba(onlyFill.color, onlyFill.opacity ?? 1)};`]
  }

  const layers = visibleFills
    .map((fill) => paintToLayer(fill, box, imageMap))
    .filter((layer): layer is BackgroundLayer => layer !== undefined)
    .reverse()
  if (!layers.length) return []

  return [
    `background-image: ${layers.map((layer) => layer.image).join(', ')};`,
    `background-size: ${layers.map((layer) => layer.size).join(', ')};`,
    `background-repeat: ${layers.map((layer) => layer.repeat).join(', ')};`,
    'background-position: center;',
  ]
}

/**
 * Strokes become inset or outset box-shadows rather than CSS borders: a border would push
 * absolutely placed children inward, while Figma measures every child from the node's outer edge.
 */
function strokeShadows(node: FigmaNode): string[] {
  const stroke = node.strokes?.find((paint) => paint.visible !== false && paint.color)
  if (!stroke?.color) return []
  const color = colorToRgba(stroke.color, stroke.opacity ?? 1)

  const sides = node.individualStrokeWeights
  if (sides) {
    return [
      sides.top ? `inset 0 ${sides.top}px 0 0 ${color}` : '',
      sides.right ? `inset ${-sides.right}px 0 0 0 ${color}` : '',
      sides.bottom ? `inset 0 ${-sides.bottom}px 0 0 ${color}` : '',
      sides.left ? `inset ${sides.left}px 0 0 0 ${color}` : '',
    ].filter(Boolean)
  }

  const weight = node.strokeWeight
  if (!weight) return []
  if (node.strokeAlign === FigmaStrokeAlign.Outside) return [`0 0 0 ${weight}px ${color}`]
  if (node.strokeAlign === FigmaStrokeAlign.Center) {
    return [`inset 0 0 0 ${weight / 2}px ${color}`, `0 0 0 ${weight / 2}px ${color}`]
  }
  return [`inset 0 0 0 ${weight}px ${color}`]
}

function shadowOf(effect: FigmaEffect, isInset: boolean): string {
  const offsetX = effect.offset?.x ?? 0
  const offsetY = effect.offset?.y ?? 0
  const blur = effect.radius ?? 0
  const spread = effect.spread ?? 0
  return `${isInset ? 'inset ' : ''}${offsetX}px ${offsetY}px ${blur}px ${spread}px ${colorToRgba(effect.color)}`
}

function visibleEffects(effects: FigmaEffect[] | undefined, type: FigmaEffectType): FigmaEffect[] {
  return (effects ?? []).filter((effect) => effect.visible !== false && effect.type === type)
}

/** Stroke first (it paints above), then inner shadows, then drop shadows. */
export function resolveBoxShadow(node: FigmaNode): string[] {
  const shadows = [
    ...strokeShadows(node),
    ...visibleEffects(node.effects, FigmaEffectType.InnerShadow).map((effect) => shadowOf(effect, true)),
    ...visibleEffects(node.effects, FigmaEffectType.DropShadow).map((effect) => shadowOf(effect, false)),
  ]
  return shadows.length ? [`box-shadow: ${shadows.join(', ')};`] : []
}

export function resolveTextShadow(effects?: FigmaEffect[]): string[] {
  const shadows = visibleEffects(effects, FigmaEffectType.DropShadow).map((effect) => shadowOf(effect, false))
  return shadows.length ? [`text-shadow: ${shadows.join(', ')};`] : []
}

export function resolveBlurs(effects?: FigmaEffect[]): string[] {
  const rules: string[] = []
  const [layerBlur] = visibleEffects(effects, FigmaEffectType.LayerBlur)
  const [backgroundBlur] = visibleEffects(effects, FigmaEffectType.BackgroundBlur)
  if (layerBlur?.radius) rules.push(`filter: blur(${roundTo(layerBlur.radius * BLUR_RADIUS_TO_CSS_SIGMA)}px);`)
  if (backgroundBlur?.radius) {
    rules.push(`backdrop-filter: blur(${roundTo(backgroundBlur.radius * BLUR_RADIUS_TO_CSS_SIGMA)}px);`)
  }
  return rules
}
