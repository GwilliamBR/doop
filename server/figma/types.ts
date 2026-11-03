export interface FigmaColor {
  r: number
  g: number
  b: number
  a?: number
}

export enum FigmaPaintType {
  Solid = 'SOLID',
  Image = 'IMAGE',
  GradientLinear = 'GRADIENT_LINEAR',
  GradientRadial = 'GRADIENT_RADIAL',
}

export enum FigmaEffectType {
  DropShadow = 'DROP_SHADOW',
  InnerShadow = 'INNER_SHADOW',
  LayerBlur = 'LAYER_BLUR',
  BackgroundBlur = 'BACKGROUND_BLUR',
}

export enum FigmaNodeType {
  Frame = 'FRAME',
  Group = 'GROUP',
  Section = 'SECTION',
  Component = 'COMPONENT',
  ComponentSet = 'COMPONENT_SET',
  Instance = 'INSTANCE',
  Text = 'TEXT',
  Rectangle = 'RECTANGLE',
  Ellipse = 'ELLIPSE',
  Vector = 'VECTOR',
  BooleanOperation = 'BOOLEAN_OPERATION',
  Star = 'STAR',
  Line = 'LINE',
  RegularPolygon = 'REGULAR_POLYGON',
}

export enum FigmaStrokeAlign {
  Inside = 'INSIDE',
  Outside = 'OUTSIDE',
  Center = 'CENTER',
}

export enum FigmaTextAutoResize {
  None = 'NONE',
  WidthAndHeight = 'WIDTH_AND_HEIGHT',
  Height = 'HEIGHT',
  Truncate = 'TRUNCATE',
}

export enum FigmaTextAlignVertical {
  Top = 'TOP',
  Center = 'CENTER',
  Bottom = 'BOTTOM',
}

export enum FigmaTextCase {
  Upper = 'UPPER',
  Lower = 'LOWER',
  Title = 'TITLE',
}

export enum FigmaTextDecoration {
  Underline = 'UNDERLINE',
  Strikethrough = 'STRIKETHROUGH',
}

export enum FigmaLayoutPositioning {
  Auto = 'AUTO',
  Absolute = 'ABSOLUTE',
}

export interface FigmaVector2 {
  x: number
  y: number
}

export interface FigmaPaint {
  type: string
  visible?: boolean
  opacity?: number
  color?: FigmaColor
  imageRef?: string
  scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE' | string
  gradientStops?: { position: number; color: FigmaColor }[]
  /** Linear: [start, end, width handle]. Radial: [center, x-radius handle, y-radius handle]. Values are 0..1 of the node box. */
  gradientHandlePositions?: FigmaVector2[]
}

export interface FigmaEffect {
  type: string
  visible?: boolean
  color?: FigmaColor
  offset?: FigmaVector2
  radius?: number
  spread?: number
}

export interface FigmaTypeStyle {
  fontFamily?: string
  fontWeight?: number
  fontSize?: number
  textAlignHorizontal?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED' | string
  textAlignVertical?: string
  textAutoResize?: string
  textCase?: string
  textDecoration?: string
  letterSpacing?: number
  lineHeightPx?: number
  italic?: boolean
  fills?: FigmaPaint[]
}

export interface FigmaBoundingBox {
  x: number
  y: number
  width: number
  height: number
}

export interface FigmaIndividualStrokeWeights {
  top: number
  right: number
  bottom: number
  left: number
}

export interface FigmaNode {
  id: string
  name: string
  type: string
  visible?: boolean
  opacity?: number
  absoluteBoundingBox?: FigmaBoundingBox
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL' | string
  layoutPositioning?: string
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
  strokeAlign?: string
  individualStrokeWeights?: FigmaIndividualStrokeWeights
  effects?: FigmaEffect[]
  style?: FigmaTypeStyle
  characters?: string
  /** One entry per character: 0 is the node's base style, any other key indexes styleOverrideTable. */
  characterStyleOverrides?: number[]
  styleOverrideTable?: Record<string, FigmaTypeStyle>
  layoutGrow?: number
  layoutAlign?: 'STRETCH' | 'INHERIT' | string
  children?: FigmaNode[]
}

export interface NodeToHtmlOptions {
  /** Figma image ref to served asset URL, for IMAGE fills. */
  imageMap?: Record<string, string>
  /** Figma node id to served asset URL of its SVG export. */
  svgMap?: Record<string, string>
  sourceUrl?: string
}
