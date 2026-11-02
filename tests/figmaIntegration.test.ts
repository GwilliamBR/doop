import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let figmaStub: HttpServer
let figmaPort: number
let owner: Client
let stranger: Client

const samplePng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

beforeAll(async () => {
  figmaStub = createServer((req, res) => {
    const token = req.headers['x-figma-token']
    const url = new URL(req.url ?? '/', `http://localhost:${figmaPort}`)

    if (url.pathname === '/image-download/img1') {
      res.setHeader('Content-Type', 'image/png')
      res.writeHead(200)
      return res.end(samplePng)
    }

    res.setHeader('Content-Type', 'application/json')

    if (url.pathname === '/v1/me') {
      if (token === 'figd_valid_token_123') {
        res.writeHead(200)
        return res.end(
          JSON.stringify({
            id: '123456',
            email: 'designer@example.com',
            handle: 'design_lead',
            img_url: 'https://example.com/avatar.png',
          }),
        )
      }
      if (token === 'figd_replacement_token_456') {
        res.writeHead(200)
        return res.end(
          JSON.stringify({
            id: '789012',
            email: 'senior@example.com',
            handle: 'senior_lead',
            img_url: 'https://example.com/avatar2.png',
          }),
        )
      }
      res.writeHead(403)
      return res.end(JSON.stringify({ status: 403, err: 'Invalid token' }))
    }

    if (url.pathname === '/v1/files/sampleFileKey') {
      if (token !== 'figd_valid_token_123' && token !== 'figd_replacement_token_456') {
        res.writeHead(403)
        return res.end(JSON.stringify({ status: 403, err: 'Invalid token' }))
      }
      res.writeHead(200)
      return res.end(
        JSON.stringify({
          name: 'Mobile App UI',
          document: {
            id: '0:0',
            name: 'Document',
            type: 'DOCUMENT',
            children: [
              {
                id: '0:1',
                name: 'Flow 1',
                type: 'CANVAS',
                children: [
                  {
                    id: '1:2',
                    name: 'Login Screen',
                    type: 'FRAME',
                    absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
                  },
                  {
                    id: '1:3',
                    name: 'Profile Screen',
                    type: 'FRAME',
                    absoluteBoundingBox: { x: 400, y: 0, width: 375, height: 812 },
                  },
                ],
              },
            ],
          },
        }),
      )
    }

    if (url.pathname === '/v1/files/sampleFileKey/nodes') {
      res.writeHead(200)
      return res.end(
        JSON.stringify({
          name: 'Mobile App UI',
          nodes: {
            '1:2': {
              document: {
                id: '1:2',
                name: 'Login Screen',
                type: 'FRAME',
                layoutMode: 'VERTICAL',
                primaryAxisAlignItems: 'CENTER',
                counterAxisAlignItems: 'CENTER',
                itemSpacing: 16,
                paddingTop: 24,
                paddingBottom: 24,
                paddingLeft: 16,
                paddingRight: 16,
                cornerRadius: 12,
                absoluteBoundingBox: { x: 0, y: 0, width: 375, height: 812 },
                fills: [{ type: 'SOLID', color: { r: 0.1, g: 0.2, b: 0.3, a: 1 } }],
                children: [
                  {
                    id: '2:1',
                    name: 'Title',
                    type: 'TEXT',
                    characters: 'Welcome to Doop',
                    style: { fontSize: 24, fontWeight: 700, fontFamily: 'Inter' },
                    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }],
                    absoluteBoundingBox: { x: 16, y: 24, width: 343, height: 32 },
                  },
                  {
                    id: '2:2',
                    name: 'Avatar',
                    type: 'RECTANGLE',
                    cornerRadius: 8,
                    absoluteBoundingBox: { x: 16, y: 72, width: 80, height: 80 },
                    fills: [{ type: 'IMAGE', imageRef: 'imgRef1' }],
                  },
                ],
              },
            },
          },
        }),
      )
    }

    if (url.pathname === '/v1/files/sampleFileKey/images') {
      res.writeHead(200)
      return res.end(
        JSON.stringify({
          meta: {
            images: {
              imgRef1: `http://localhost:${figmaPort}/image-download/img1`,
            },
          },
        }),
      )
    }

    res.writeHead(404)
    res.end(JSON.stringify({ status: 404, err: 'Not found' }))
  })

  await new Promise<void>((resolve) => figmaStub.listen(0, resolve))
  figmaPort = (figmaStub.address() as AddressInfo).port

  server = await startServer({
    FIGMA_API_URL: `http://localhost:${figmaPort}/v1`,
  })

  owner = await new Client(server).signUp('figma-owner@test.dev', 'Owner')
  stranger = await new Client(server).signUp('figma-stranger@test.dev', 'Stranger')
}, 60_000)

afterAll(() => {
  server?.stop()
  figmaStub?.close()
})

async function getFigmaStatus(client: Client) {
  const response = await client.get('/api/integrations')
  const json = (await response.json()) as { figma: { connected: boolean; accountName?: string } }
  return json.figma
}

describe('Figma integration connection lifecycle', () => {
  it('requires authentication to access figma endpoints', async () => {
    const unauthenticated = new Client(server)
    expect(
      (await unauthenticated.post('/api/integrations/figma/token', { token: 'figd_valid_token_123' })).status,
    ).toBe(401)
    expect((await unauthenticated.delete('/api/integrations/figma')).status).toBe(401)
  })

  it('reports not connected initially', async () => {
    expect(await getFigmaStatus(owner)).toEqual({ connected: false })
  })

  it('connects a valid figma personal access token and returns display handle', async () => {
    const connectResponse = await owner.post('/api/integrations/figma/token', {
      token: 'figd_valid_token_123',
    })
    expect(connectResponse.status).toBe(200)

    const statusAfterConnect = await getFigmaStatus(owner)
    expect(statusAfterConnect).toMatchObject({
      connected: true,
      accountName: 'design_lead (designer@example.com)',
    })
    expect(JSON.stringify(statusAfterConnect)).not.toContain('figd_valid_token_123')
  })

  it('rejects an invalid token and preserves the existing valid connection', async () => {
    const failedConnectResponse = await owner.post('/api/integrations/figma/token', {
      token: 'figd_invalid_key_999',
    })
    expect(failedConnectResponse.status).toBe(401)

    const statusPreserved = await getFigmaStatus(owner)
    expect(statusPreserved).toMatchObject({
      connected: true,
      accountName: 'design_lead (designer@example.com)',
    })
  })

  it('replaces key with a new valid token', async () => {
    const replaceResponse = await owner.post('/api/integrations/figma/token', {
      token: 'figd_replacement_token_456',
    })
    expect(replaceResponse.status).toBe(200)

    const statusAfterReplace = await getFigmaStatus(owner)
    expect(statusAfterReplace).toMatchObject({
      connected: true,
      accountName: 'senior_lead (senior@example.com)',
    })
  })

  it('isolates connections between different users', async () => {
    expect(await getFigmaStatus(stranger)).toEqual({ connected: false })
  })

  it('disconnects figma connection cleanly and idempotently', async () => {
    const disconnectResponse = await owner.delete('/api/integrations/figma')
    expect(disconnectResponse.status).toBe(200)

    expect(await getFigmaStatus(owner)).toEqual({ connected: false })

    const idempotentDisconnect = await owner.delete('/api/integrations/figma')
    expect(idempotentDisconnect.status).toBe(200)
  })
})

describe('Figma canvas frame import', () => {
  let canvasId: string

  beforeAll(async () => {
    const createRes = await owner.post('/api/canvases', { name: 'Figma Canvas' })
    expect(createRes.status).toBe(200)
    const canvasData = (await createRes.json()) as { id: string }
    canvasId = canvasData.id

    await owner.post('/api/integrations/figma/token', {
      token: 'figd_valid_token_123',
    })
  })

  it('discovers frames in a multi-frame figma file link', async () => {
    const discoverRes = await owner.post(`/api/canvases/${canvasId}/figma/discover`, {
      url: 'https://www.figma.com/design/sampleFileKey/Mobile-App-UI',
    })
    expect(discoverRes.status).toBe(200)

    const data = (await discoverRes.json()) as {
      fileKey: string
      frames: { id: string; name: string; pageName: string; width: number; height: number }[]
    }

    expect(data.fileKey).toBe('sampleFileKey')
    expect(data.frames).toHaveLength(2)
    expect(data.frames[0]).toMatchObject({
      id: '1:2',
      name: 'Login Screen',
      pageName: 'Flow 1',
      width: 375,
      height: 812,
    })
    expect(data.frames[1]).toMatchObject({
      id: '1:3',
      name: 'Profile Screen',
      pageName: 'Flow 1',
      width: 375,
      height: 812,
    })
  })

  it('refuses discovery for unauthorized stranger', async () => {
    const strangerDiscover = await stranger.post(`/api/canvases/${canvasId}/figma/discover`, {
      url: 'https://www.figma.com/design/sampleFileKey/Mobile-App-UI',
    })
    expect(strangerDiscover.status).toBe(403)
  })

  it('imports selected figma frame onto canvas as editable HTML with images and layout', async () => {
    const importRes = await owner.post(`/api/canvases/${canvasId}/figma/import`, {
      url: 'https://www.figma.com/design/sampleFileKey/Mobile-App-UI?node-id=1-2',
      nodeIds: ['1:2'],
    })
    expect(importRes.status).toBe(200)

    const importData = (await importRes.json()) as {
      frames: { id: string; name: string; width: number; height: number; html: string }[]
    }
    expect(importData.frames).toHaveLength(1)
    const importedFrame = importData.frames[0]!
    expect(importedFrame.name).toBe('Login Screen')
    expect(importedFrame.width).toBe(375)
    expect(importedFrame.height).toBe(812)

    const canvasGet = await owner.get(`/api/canvases/${canvasId}`)
    expect(canvasGet.status).toBe(200)
    const canvas = (await canvasGet.json()) as {
      frames: { id: string; name: string; width: number; height: number; html: string }[]
    }

    const frameOnCanvas = canvas.frames.find((f) => f.id === importedFrame.id)
    expect(frameOnCanvas).toBeDefined()
    expect(frameOnCanvas?.width).toBe(375)
    expect(frameOnCanvas?.height).toBe(812)

    const html = frameOnCanvas?.html ?? ''
    expect(html).toContain('display: flex;')
    expect(html).toContain('flex-direction: column;')
    expect(html).toContain('gap: 16px;')
    expect(html).toContain('Welcome to Doop')
    expect(html).toContain('/api/assets/')
  })
})
