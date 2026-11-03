import { z } from 'zod'
import { figmaFetch } from './client.ts'
import { FigmaNodeType, FigmaPaintType, type FigmaNode } from './types.ts'

/** Containers larger than this are layouts, not icons, so they stay editable HTML. */
const MAX_ICON_CONTAINER_SIZE = 256
const MAX_VECTOR_EXPORTS = 300
const EXPORT_BATCH_SIZE = 50

const VECTOR_TYPES = new Set<string>([
  FigmaNodeType.Vector,
  FigmaNodeType.BooleanOperation,
  FigmaNodeType.Star,
  FigmaNodeType.Line,
  FigmaNodeType.RegularPolygon,
])

const ICON_CONTAINER_TYPES = new Set<string>([
  FigmaNodeType.Frame,
  FigmaNodeType.Group,
  FigmaNodeType.Component,
  FigmaNodeType.Instance,
])

const SIMPLE_SHAPE_TYPES = new Set<string>([FigmaNodeType.Rectangle, FigmaNodeType.Ellipse])

const svgExportSchema = z.object({
  images: z.record(z.string().nullable()),
})

function hasImageFill(node: FigmaNode): boolean {
  return (node.fills ?? []).some((fill) => fill.type === FigmaPaintType.Image)
}

function isGraphicOnly(node: FigmaNode): boolean {
  if (node.visible === false) return true
  if (hasImageFill(node)) return false
  const isGraphicType =
    VECTOR_TYPES.has(node.type) || SIMPLE_SHAPE_TYPES.has(node.type) || ICON_CONTAINER_TYPES.has(node.type)
  if (!isGraphicType) return false
  return (node.children ?? []).every(isGraphicOnly)
}

function containsVector(node: FigmaNode): boolean {
  if (VECTOR_TYPES.has(node.type)) return true
  return (node.children ?? []).some(containsVector)
}

function isSmallEnoughForIcon(node: FigmaNode): boolean {
  const box = node.absoluteBoundingBox
  if (!box) return false
  return box.width <= MAX_ICON_CONTAINER_SIZE && box.height <= MAX_ICON_CONTAINER_SIZE
}

/** HTML has no equivalent for these shapes, so Figma renders them to SVG for us. */
export function isSvgExportCandidate(node: FigmaNode): boolean {
  if (node.visible === false) return false
  if (VECTOR_TYPES.has(node.type)) return true
  const isIconContainer = ICON_CONTAINER_TYPES.has(node.type)
  return isIconContainer && isSmallEnoughForIcon(node) && containsVector(node) && isGraphicOnly(node)
}

function collectCandidates(node: FigmaNode, found: string[]): void {
  if (node.visible === false) return
  if (isSvgExportCandidate(node)) {
    found.push(node.id)
    return
  }
  for (const child of node.children ?? []) collectCandidates(child, found)
}

/** The root frame itself is never exported: only what is inside it. */
export function findSvgExportIds(roots: FigmaNode[]): string[] {
  const found: string[] = []
  for (const root of roots) {
    for (const child of root.children ?? []) collectCandidates(child, found)
  }
  return found.slice(0, MAX_VECTOR_EXPORTS)
}

/** Asks Figma to render each node as SVG. Nodes Figma cannot render are simply absent from the result. */
export async function requestSvgExportUrls(
  token: string,
  fileKey: string,
  nodeIds: string[],
): Promise<Record<string, string>> {
  const urls: Record<string, string> = {}
  for (let start = 0; start < nodeIds.length; start += EXPORT_BATCH_SIZE) {
    const batch = nodeIds.slice(start, start + EXPORT_BATCH_SIZE)
    const idsParam = batch.map(encodeURIComponent).join(',')
    const response = await figmaFetch(
      `/images/${fileKey}?ids=${idsParam}&format=svg&svg_include_id=false`,
      token,
      svgExportSchema,
    )
    for (const [nodeId, url] of Object.entries(response.images)) {
      if (url) urls[nodeId] = url
    }
  }
  return urls
}
