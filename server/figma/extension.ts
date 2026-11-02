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
