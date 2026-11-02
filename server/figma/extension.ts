import express from 'express'
import { z } from 'zod'
import type { ServerExtension } from '../extensions.ts'
import { connect, connectionStatus, disconnect } from './connection.ts'
import { FigmaError } from './client.ts'

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
}
