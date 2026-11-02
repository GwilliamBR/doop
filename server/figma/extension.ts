import express from 'express'
import { z } from 'zod'
import type { ServerExtension } from '../extensions.ts'
import * as actions from '../actions.ts'
import type { Frame } from '../../shared/types.ts'
import { connect, connectionStatus, disconnect, getConnection } from './connection.ts'
import { FigmaError } from './client.ts'
import { discoverFigmaFrames, importFigmaNodes, parseFigmaUrl } from './importer.ts'

export const figmaExtension: ServerExtension = {
  id: 'figma',
  connectionStatus: async (userId: string) => {
    return connectionStatus(userId)
  },
  mcpGuideLines: [
    '- Figma: import_figma imports frames from a Figma file or frame URL onto a canvas as editable HTML snapshots. Requires your human’s Figma connection in Integrations.',
  ],
  registerMcpTools: (server, helpers) => {
    server.registerTool(
      'import_figma',
      {
        title: 'Import Figma frames',
        description:
          'Import one or more frames from a Figma file or frame URL onto a canvas as editable HTML snapshots. Uses your human’s connected Figma token.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        inputSchema: {
          canvas_id: z.string().describe('Target canvas ID'),
          url: z.string().describe('Figma file or frame URL'),
          node_ids: z.array(z.string()).optional().describe('Optional list of node IDs to import'),
          agent_name: helpers.agentName,
        },
      },
      async ({ canvas_id, url, node_ids, agent_name }) => {
        const canvas = helpers.canvasFor(canvas_id, 'edit')
        if (!canvas) return helpers.noCanvas(canvas_id)

        if (!helpers.ownerId) {
          return helpers.err('Connect Figma on the Integrations page first.')
        }

        const connection = await getConnection(helpers.ownerId)
        if (!connection) {
          return helpers.err('Connect Figma on the Integrations page first.')
        }

        if (!helpers.takeImportSlot(helpers.ownerId)) {
          return helpers.err('Too many imports — wait a minute before trying again.')
        }

        let fileKey: string
        let nodeId: string | undefined
        try {
          const parsed = parseFigmaUrl(url)
          fileKey = parsed.fileKey
          nodeId = parsed.nodeId
        } catch (error) {
          return helpers.err(error instanceof Error ? error.message : 'Invalid Figma URL.')
        }

        let targets = node_ids && node_ids.length ? node_ids : nodeId ? [nodeId] : []
        if (!targets.length) {
          try {
            const discovered = await discoverFigmaFrames(connection.accessToken, fileKey)
            targets = discovered.map((f) => f.id)
          } catch (error) {
            return helpers.err(error instanceof FigmaError ? error.message : 'Could not read Figma file.')
          }
        }

        if (!targets.length) {
          return helpers.err('No frames found to import in this Figma file.')
        }

        let importedList
        try {
          importedList = await importFigmaNodes(connection.accessToken, fileKey, targets, {
            canvasId: canvas.id,
            ownerId: helpers.ownerId,
            sourceUrl: url,
          })
        } catch (error) {
          return helpers.err(error instanceof FigmaError ? error.message : 'Could not import Figma frames.')
        }

        const actor = helpers.actorFrom(agent_name)
        const rightmost = canvas.frames.reduce((right, frame) => Math.max(right, frame.x + frame.width), 0)
        const startX = canvas.frames.length ? rightmost + 80 : 120
        const columns = 3
        let column = 0
        let y = 120
        let rowHeight = 0
        const createdFrames: Frame[] = []

        for (const item of importedList) {
          const frame = actions.createFrame(
            canvas.id,
            {
              name: item.name.slice(0, 80),
              x: startX + column * (item.width + 80),
              y,
              width: item.width,
              height: item.height,
              html: item.html,
            },
            actor,
          )
          if (frame) {
            createdFrames.push(frame)
            rowHeight = Math.max(rowHeight, item.height)
            column++
            if (column === columns) {
              column = 0
              y += rowHeight + 80
              rowHeight = 0
            }
          }
        }

        return helpers.text({
          success: true,
          count: createdFrames.length,
          frames: createdFrames.map((f) => helpers.frameSummary(f)),
        })
      },
    )
  },
  connectRouter: ({ respondWithStatus }) => {
    const router = express.Router()

    router.post('/token', async (req, res, next) => {
      const input = z.object({ token: z.string() }).safeParse(req.body)
      if (!input.success) {
        return res.status(400).json({ error: 'Enter a Figma personal access token.' })
      }
      try {
        await connect(req.user!.id, input.data.token)
        await respondWithStatus(req, res)
      } catch (error) {
        if (error instanceof FigmaError) {
          return res.status(error.status).json({ error: error.message })
        }
        next(error)
      }
    })

    router.delete('/', async (req, res, next) => {
      try {
        await disconnect(req.user!.id)
        await respondWithStatus(req, res)
      } catch (error) {
        next(error)
      }
    })

    return router
  },
  canvasRouter: ({ requireCanvas, takeImportSlot }) => {
    const router = express.Router({ mergeParams: true })

    router.post('/discover', async (req, res, next) => {
      const canvasId = (req.params as { id: string }).id
      const canvas = requireCanvas(req, res, canvasId, 'edit')
      if (!canvas) return

      try {
        const url = String(req.body?.url ?? '').trim()
        const { fileKey, nodeId } = parseFigmaUrl(url)

        const connection = await getConnection(req.user!.id)
        if (!connection) {
          return res.status(401).json({ error: 'Connect Figma on the Integrations page first.' })
        }

        if (!takeImportSlot(req.user!.id)) {
          return res.status(429).json({ error: 'too many imports — wait a minute' })
        }

        const frames = await discoverFigmaFrames(connection.accessToken, fileKey, nodeId)
        res.json({ fileKey, frames })
      } catch (error) {
        if (error instanceof FigmaError) {
          return res.status(error.status).json({ error: error.message })
        }
        next(error)
      }
    })

    router.post('/import', async (req, res, next) => {
      const canvasId = (req.params as { id: string }).id
      const canvas = requireCanvas(req, res, canvasId, 'edit')
      if (!canvas) return

      try {
        const url = String(req.body?.url ?? '').trim()
        const { fileKey, nodeId } = parseFigmaUrl(url)

        const connection = await getConnection(req.user!.id)
        if (!connection) {
          return res.status(401).json({ error: 'Connect Figma on the Integrations page first.' })
        }

        if (!takeImportSlot(req.user!.id)) {
          return res.status(429).json({ error: 'too many imports — wait a minute' })
        }

        let targetIds: string[] = []
        if (Array.isArray(req.body?.nodeIds) && req.body.nodeIds.length) {
          targetIds = req.body.nodeIds.map((id: unknown) => String(id))
        } else if (nodeId) {
          targetIds = [nodeId]
        } else {
          const discovered = await discoverFigmaFrames(connection.accessToken, fileKey)
          targetIds = discovered.map((f) => f.id)
        }

        if (!targetIds.length) {
          return res.status(400).json({ error: 'No frames found to import in this Figma file.' })
        }

        const importedFrames = await importFigmaNodes(connection.accessToken, fileKey, targetIds, {
          canvasId: canvas.id,
          ownerId: req.user!.id,
          sourceUrl: url,
        })

        const clientId = req.body?.actor?.clientId
        const actor = actions.resolveActor({
          name: req.user!.name,
          kind: 'user',
          clientId: typeof clientId === 'string' ? clientId.slice(0, 64) : undefined,
        })

        const rightmost = canvas.frames.reduce((right, frame) => Math.max(right, frame.x + frame.width), 0)
        const startX = canvas.frames.length ? rightmost + 80 : 120
        const columns = 3
        let column = 0
        let y = 120
        let rowHeight = 0
        const createdFrames: Frame[] = []

        for (const item of importedFrames) {
          const frame = actions.createFrame(
            canvas.id,
            {
              name: item.name.slice(0, 80),
              x: startX + column * (item.width + 80),
              y,
              width: item.width,
              height: item.height,
              html: item.html,
            },
            actor,
          )
          if (frame) {
            createdFrames.push(frame)
            rowHeight = Math.max(rowHeight, item.height)
            column++
            if (column === columns) {
              column = 0
              y += rowHeight + 80
              rowHeight = 0
            }
          }
        }

        res.json({ frames: createdFrames })
      } catch (error) {
        if (error instanceof FigmaError) {
          return res.status(error.status).json({ error: error.message })
        }
        next(error)
      }
    })

    return router
  },
}
