import { z } from 'zod'
import { createAsset } from '../assets.ts'
import { FigmaError, figmaFetch } from './client.ts'
import { figmaNodeToHtml } from './html.ts'
import type { FigmaNode } from './types.ts'
import { findSvgExportIds, requestSvgExportUrls } from './vectors.ts'

const DOWNLOAD_CONCURRENCY = 8

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

/** Downloads a Figma-hosted file into Doop's asset storage and returns the URL frames should use. */
async function storeRemoteAsset(
  remoteUrl: string,
  label: string,
  canvasId?: string,
  ownerId?: string,
): Promise<string | undefined> {
  try {
    const downloadRes = await fetch(remoteUrl, { signal: AbortSignal.timeout(15_000) })
    if (!downloadRes.ok) return undefined

    const buf = Buffer.from(await downloadRes.arrayBuffer())
    const asset = await createAsset(buf, { canvasId, ownerId, uploadedBy: 'Figma' })
    return `/a/${asset.id}.${asset.ext}`
  } catch (assetErr) {
    console.warn(`[figma] Failed to download or create asset for ${label}:`, assetErr)
    return undefined
  }
}

async function storeAll(
  remoteUrls: Record<string, string>,
  canvasId?: string,
  ownerId?: string,
): Promise<Record<string, string>> {
  const stored: Record<string, string> = {}
  const entries = Object.entries(remoteUrls)

  for (let start = 0; start < entries.length; start += DOWNLOAD_CONCURRENCY) {
    const batch = entries.slice(start, start + DOWNLOAD_CONCURRENCY)
    await Promise.all(
      batch.map(async ([key, remoteUrl]) => {
        const assetUrl = await storeRemoteAsset(remoteUrl, key, canvasId, ownerId)
        if (assetUrl) stored[key] = assetUrl
      }),
    )
  }
  return stored
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

  try {
    const response = await figmaFetch(`/files/${fileKey}/images`, token, imagesResponseSchema)
    const wantedUrls: Record<string, string> = {}
    for (const ref of imageRefs) {
      const remoteUrl = response.meta.images[ref]
      if (remoteUrl) wantedUrls[ref] = remoteUrl
    }
    return await storeAll(wantedUrls, canvasId, ownerId)
  } catch (err) {
    console.warn(`[figma] Could not fetch file images for ${fileKey}:`, err)
    return {}
  }
}

/** Icons and vector shapes have no HTML equivalent, so Figma renders them to SVG and we store those. */
async function resolveFigmaSvgExports(
  token: string,
  fileKey: string,
  nodes: FigmaNode[],
  canvasId?: string,
  ownerId?: string,
): Promise<Record<string, string>> {
  const exportIds = findSvgExportIds(nodes)
  if (!exportIds.length) return {}

  try {
    const remoteUrls = await requestSvgExportUrls(token, fileKey, exportIds)
    return await storeAll(remoteUrls, canvasId, ownerId)
  } catch (err) {
    console.warn(`[figma] Could not export vectors for ${fileKey}:`, err)
    return {}
  }
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

  const [imageMap, svgMap] = await Promise.all([
    resolveFigmaImages(token, fileKey, nodes, options.canvasId, options.ownerId),
    resolveFigmaSvgExports(token, fileKey, nodes, options.canvasId, options.ownerId),
  ])

  return nodes.map((node) => {
    const box = node.absoluteBoundingBox
    const width = box ? Math.round(box.width) : 800
    const height = box ? Math.round(box.height) : 600
    const html = figmaNodeToHtml(node, { imageMap, svgMap, sourceUrl: options.sourceUrl })

    return {
      id: node.id,
      name: node.name || 'Frame',
      width,
      height,
      html,
    }
  })
}
