import { z } from 'zod'
import { createAsset } from '../assets.ts'
import { FigmaError, figmaFetch } from './client.ts'
import { figmaNodeToHtml, type FigmaNode } from './html.ts'

export interface DiscoveredFrame {
  id: string
  name: string
  pageName: string
  width: number
  height: number
}

export interface ImportedFigmaFrame {
  id: string
  name: string
  width: number
  height: number
  html: string
}

export function parseFigmaUrl(rawUrl: string): { fileKey: string; nodeId?: string } {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    throw new FigmaError('Enter a Figma file or frame link.', 400)
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`)
  } catch {
    throw new FigmaError('Enter a valid Figma link (e.g. https://www.figma.com/design/KEY/Title?node-id=1-2).', 400)
  }

  const match = parsed.pathname.match(/\/(?:file|design)\/([A-Za-z0-9_-]{10,128})/i)
  if (!match || !match[1]) {
    throw new FigmaError(
      'Enter a valid Figma link with a file key (e.g. https://www.figma.com/design/KEY/Title?node-id=1-2).',
      400,
    )
  }

  const fileKey = match[1]
  const rawNodeId = parsed.searchParams.get('node-id')
  const nodeId = rawNodeId ? rawNodeId.replace(/-/g, ':') : undefined

  return { fileKey, nodeId }
}

const fileResponseSchema = z.object({
  name: z.string(),
  document: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    children: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          type: z.string(),
          children: z.array(z.any()).optional(),
        }),
      )
      .optional(),
  }),
})

const nodesResponseSchema = z.object({
  name: z.string(),
  nodes: z.record(
    z.object({
      document: z.any(),
    }),
  ),
})

const imagesResponseSchema = z.object({
  meta: z.object({
    images: z.record(z.string().nullable()),
  }),
})

export async function discoverFigmaFrames(
  token: string,
  fileKey: string,
  specificNodeId?: string,
): Promise<DiscoveredFrame[]> {
  if (specificNodeId) {
    const nodesData = await figmaFetch(
      `/files/${fileKey}/nodes?ids=${encodeURIComponent(specificNodeId)}`,
      token,
      nodesResponseSchema,
    )
    const nodeWrapper = nodesData.nodes[specificNodeId]
    if (!nodeWrapper?.document) {
      throw new FigmaError(`Frame ${specificNodeId} not found in this Figma file.`, 404)
    }
    const doc = nodeWrapper.document as FigmaNode
    const box = doc.absoluteBoundingBox
    return [
      {
        id: doc.id,
        name: doc.name || 'Frame',
        pageName: 'Targeted Selection',
        width: box ? Math.round(box.width) : 800,
        height: box ? Math.round(box.height) : 600,
      },
    ]
  }

  const fileData = await figmaFetch(`/files/${fileKey}?depth=2`, token, fileResponseSchema)
  const discovered: DiscoveredFrame[] = []
  const pages = fileData.document.children ?? []

  for (const page of pages) {
    const pageName = page.name || 'Page'
    const topLevelChildren = page.children ?? []

    for (const child of topLevelChildren) {
      const type = child.type
      const isFrameLike = type === 'FRAME' || type === 'COMPONENT' || type === 'SECTION' || type === 'GROUP'
      if (!isFrameLike) continue

      const box = (child as FigmaNode).absoluteBoundingBox
      discovered.push({
        id: child.id,
        name: child.name || 'Frame',
        pageName,
        width: box ? Math.round(box.width) : 800,
        height: box ? Math.round(box.height) : 600,
      })
    }
  }

  return discovered
}

function collectImageRefs(node: FigmaNode, refs: Set<string>): void {
  for (const fill of node.fills ?? []) {
    if (fill.type === 'IMAGE' && fill.imageRef) {
      refs.add(fill.imageRef)
    }
  }
  for (const child of node.children ?? []) {
    collectImageRefs(child, refs)
  }
}

async function resolveFigmaImages(
  token: string,
  fileKey: string,
  nodes: FigmaNode[],
  canvasId?: string,
  ownerId?: string,
): Promise<Record<string, string>> {
  const imageRefs = new Set<string>()
  for (const node of nodes) {
    collectImageRefs(node, imageRefs)
  }

  if (!imageRefs.size) return {}

  const imageMap: Record<string, string> = {}
  try {
    const response = await figmaFetch(`/files/${fileKey}/images`, token, imagesResponseSchema)
    const remoteUrls = response.meta.images

    for (const ref of imageRefs) {
      const remoteUrl = remoteUrls[ref]
      if (!remoteUrl) continue

      try {
        const downloadRes = await fetch(remoteUrl, { signal: AbortSignal.timeout(15_000) })
        if (!downloadRes.ok) continue

        const arrayBuf = await downloadRes.arrayBuffer()
        const buf = Buffer.from(arrayBuf)
        const asset = await createAsset(buf, {
          canvasId,
          ownerId,
          uploadedBy: 'Figma',
        })
        imageMap[ref] = `/api/assets/${asset.id}`
      } catch (assetErr) {
        console.warn(`[figma] Failed to download or create asset for image ${ref}:`, assetErr)
      }
    }
  } catch (err) {
    console.warn(`[figma] Could not fetch file images for ${fileKey}:`, err)
  }

  return imageMap
}

export async function importFigmaNodes(
  token: string,
  fileKey: string,
  nodeIds: string[],
  options: {
    canvasId?: string
    ownerId?: string
    sourceUrl?: string
  } = {},
): Promise<ImportedFigmaFrame[]> {
  if (!nodeIds.length) {
    throw new FigmaError('Select at least one frame to import.', 400)
  }

  const idsParam = nodeIds.map(encodeURIComponent).join(',')
  const nodesData = await figmaFetch(`/files/${fileKey}/nodes?ids=${idsParam}`, token, nodesResponseSchema)

  const nodes: FigmaNode[] = []
  for (const id of nodeIds) {
    const entry = nodesData.nodes[id]
    if (entry?.document) {
      nodes.push(entry.document as FigmaNode)
    }
  }

  if (!nodes.length) {
    throw new FigmaError('None of the selected frames could be found in the Figma file.', 404)
  }

  const imageMap = await resolveFigmaImages(token, fileKey, nodes, options.canvasId, options.ownerId)

  return nodes.map((node) => {
    const box = node.absoluteBoundingBox
    const width = box ? Math.round(box.width) : 800
    const height = box ? Math.round(box.height) : 600
    const html = figmaNodeToHtml(node, { imageMap, sourceUrl: options.sourceUrl })

    return {
      id: node.id,
      name: node.name || 'Frame',
      width,
      height,
      html,
    }
  })
}
