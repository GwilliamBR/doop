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

    if (url.pathname === '/image-download/corrupted-img') {
      res.setHeader('Content-Type', 'text/plain')
      res.writeHead(200)
      return res.end('INVALID_NOT_AN_IMAGE')
    }

    if (url.pathname === '/svg-download/arrow') {
      res.setHeader('Content-Type', 'image/svg+xml')
      res.writeHead(200)
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><path d="M0 0L12 6L0 12Z"/></svg>')
    }

    res.setHeader('Content-Type', 'application/json')

    if (url.pathname === '/v1/files/vectorFileKey/nodes' || url.pathname === '/v1/files/vectorNoExportKey/nodes') {
      res.writeHead(200)
      return res.end(
        JSON.stringify({
          name: 'Vector File',
          nodes: {
            '5:1': {
              document: {
                id: '5:1',
                name: 'Keys',
                type: 'FRAME',
                absoluteBoundingBox: { x: 0, y: 0, width: 200, height: 100 },
                children: [
                  {
                    id: '5:2',
                    name: 'Arrow',
                    type: 'VECTOR',
                    absoluteBoundingBox: { x: 10, y: 10, width: 12, height: 12 },
                    fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 1 } }],
                  },
                ],
              },
            },
          },
        }),
      )
    }

    if (url.pathname === '/v1/images/vectorFileKey') {
      res.writeHead(200)
      return res.end(
        JSON.stringify({ err: null, images: { '5:2': `http://localhost:${figmaPort}/svg-download/arrow` } }),
      )
    }

    if (url.pathname === '/v1/me') {
      if (token === 'figd_rate_limited') {
        res.writeHead(429)
        return res.end(JSON.stringify({ status: 429, err: 'Rate limit exceeded' }))
      }
      if (token === 'figd_missing_scope') {
        res.writeHead(403)
        return res.end(
          JSON.stringify({
            status: 403,
            err: 'Invalid scope(s): file_content:read. This endpoint requires the current_user:read scope.',
          }),
        )
      }
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

    if (url.pathname === '/v1/files/rateLimitedFileKey') {
      res.writeHead(429)
      return res.end(JSON.stringify({ status: 429, err: 'Rate limit exceeded' }))
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

    if (url.pathname === '/v1/files/corruptedImageFileKey') {
      res.writeHead(200)
      return res.end(
        JSON.stringify({
          name: 'Corrupted File',
          document: {
            id: '0:0',
            name: 'Document',
            type: 'DOCUMENT',
            children: [
              {
                id: '0:1',
                name: 'Page 1',
                type: 'CANVAS',
                children: [
                  {
                    id: '3:1',
                    name: 'Corrupt Image Frame',
                    type: 'FRAME',
                    absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
                  },
                ],
              },
            ],
          },
        }),
      )
    }

    if (url.pathname === '/v1/files/corruptedImageFileKey/nodes') {
      res.writeHead(200)
      return res.end(
        JSON.stringify({
          name: 'Corrupted File',
          nodes: {
            '3:1': {
              document: {
                id: '3:1',
                name: 'Corrupt Image Frame',
                type: 'FRAME',
                absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 200 },
                children: [
                  {
                    id: '3:2',
                    name: 'Corrupt Rect',
                    type: 'RECTANGLE',
                    absoluteBoundingBox: { x: 0, y: 0, width: 100, height: 100 },
                    fills: [{ type: 'IMAGE', imageRef: 'corruptRef' }],
                  },
                ],
              },
            },
          },
        }),
      )
    }

    if (url.pathname === '/v1/files/corruptedImageFileKey/images') {
      res.writeHead(200)
      return res.end(
        JSON.stringify({
          meta: {
            images: {
              corruptRef: `http://localhost:${figmaPort}/image-download/corrupted-img`,
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

  it('returns a clear scope error when token lacks required permissions and preserves existing connection', async () => {
    const missingScopeResponse = await owner.post('/api/integrations/figma/token', {
      token: 'figd_missing_scope',
    })
    expect(missingScopeResponse.status).toBe(403)
    expect(await missingScopeResponse.json()).toEqual({
      error:
        'This token is missing required permissions. Enable Current user (current_user:read) and File content (file_content:read) scopes in Figma.',
    })

    const statusPreserved = await getFigmaStatus(owner)
    expect(statusPreserved).toMatchObject({
      connected: true,
      accountName: 'design_lead (designer@example.com)',
    })
  })

  it('rejects an invalid token format and preserves the existing valid connection', async () => {
    const failedFormatResponse = await owner.post('/api/integrations/figma/token', {
      token: 'bad',
    })
    expect(failedFormatResponse.status).toBe(400)
    expect(await failedFormatResponse.json()).toEqual({
      error: 'Enter a valid Figma personal access token.',
    })

    const statusPreserved = await getFigmaStatus(owner)
    expect(statusPreserved).toMatchObject({
      connected: true,
      accountName: 'design_lead (designer@example.com)',
    })
  })

  it('handles Figma rate limit when connecting and preserves existing valid connection', async () => {
    const rateLimitedResponse = await owner.post('/api/integrations/figma/token', {
      token: 'figd_rate_limited',
    })
    expect(rateLimitedResponse.status).toBe(429)
    expect(await rateLimitedResponse.json()).toEqual({
      error: 'Figma rate limit reached. Try again later.',
    })

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

  it('never returns the Figma personal access token in /api/integrations response', async () => {
    const rawRes = await owner.get('/api/integrations')
    expect(rawRes.status).toBe(200)
    const rawText = await rawRes.text()
    expect(rawText).not.toContain('figd_')
    const json = JSON.parse(rawText) as { figma?: { connected?: boolean; accessToken?: unknown } }
    expect(json.figma?.connected).toBe(true)
    expect(json.figma?.accessToken).toBeUndefined()
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

  it('returns helpful error when submitting malformed Figma links', async () => {
    const emptyRes = await owner.post(`/api/canvases/${canvasId}/figma/discover`, {
      url: '',
    })
    expect(emptyRes.status).toBe(400)
    expect(await emptyRes.json()).toEqual({
      error: 'Enter a Figma file or frame link.',
    })

    const nonFigmaRes = await owner.post(`/api/canvases/${canvasId}/figma/discover`, {
      url: 'https://example.com/not-a-figma-link',
    })
    expect(nonFigmaRes.status).toBe(400)
    expect(await nonFigmaRes.json()).toEqual({
      error: 'Enter a valid Figma link with a file key (e.g. https://www.figma.com/design/KEY/Title?node-id=1-2).',
    })
  })

  it('handles rate limit during discovery and keeps connection intact', async () => {
    const rateLimitRes = await owner.post(`/api/canvases/${canvasId}/figma/discover`, {
      url: 'https://www.figma.com/design/rateLimitedFileKey/Rate-Limited-UI',
    })
    expect(rateLimitRes.status).toBe(429)
    expect(await rateLimitRes.json()).toEqual({
      error: 'Figma rate limit reached. Try again later.',
    })

    const statusPreserved = await getFigmaStatus(owner)
    expect(statusPreserved).toMatchObject({
      connected: true,
      accountName: 'design_lead (designer@example.com)',
    })
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
    expect(html).toMatch(/url\('\/a\/[A-Za-z0-9_-]+\.png'\)/)
  })

  it('skips invalid remote image fills without creating corrupt assets', async () => {
    const importRes = await owner.post(`/api/canvases/${canvasId}/figma/import`, {
      url: 'https://www.figma.com/design/corruptedImageFileKey/Corrupt-Image-Test?node-id=3-1',
      nodeIds: ['3:1'],
    })
    expect(importRes.status).toBe(200)

    const importData = (await importRes.json()) as {
      frames: { id: string; name: string; width: number; height: number; html: string }[]
    }
    expect(importData.frames).toHaveLength(1)
    const importedFrame = importData.frames[0]!
    expect(importedFrame.name).toBe('Corrupt Image Frame')
    expect(importedFrame.html).not.toContain('/a/')
  })
})

/* its own user: imports are limited to five per minute per user */
describe('Figma vector export', () => {
  let vectorUser: Client
  let canvasId: string

  beforeAll(async () => {
    vectorUser = await new Client(server).signUp('figma-vector@test.dev', 'Vector')
    const createRes = await vectorUser.post('/api/canvases', { name: 'Vector Canvas' })
    canvasId = ((await createRes.json()) as { id: string }).id
    await vectorUser.post('/api/integrations/figma/token', { token: 'figd_valid_token_123' })
  })

  it('renders vector nodes through Figma SVG export and serves the stored file', async () => {
    const importRes = await vectorUser.post(`/api/canvases/${canvasId}/figma/import`, {
      url: 'https://www.figma.com/design/vectorFileKey/Vectors?node-id=5-1',
      nodeIds: ['5:1'],
    })
    expect(importRes.status).toBe(200)

    const importData = (await importRes.json()) as { frames: { html: string }[] }
    const svgUrl = importData.frames[0]?.html.match(/<img src="(\/a\/[A-Za-z0-9_-]+\.svg)"/)?.[1]
    expect(svgUrl).toBeDefined()

    const served = await vectorUser.get(svgUrl!)
    expect(served.status).toBe(200)
    expect(await served.text()).toContain('<path')
  })

  it('still imports the frame when Figma cannot export vectors', async () => {
    const importRes = await vectorUser.post(`/api/canvases/${canvasId}/figma/import`, {
      url: 'https://www.figma.com/design/vectorNoExportKey/Vectors?node-id=5-1',
      nodeIds: ['5:1'],
    })
    expect(importRes.status).toBe(200)

    const importData = (await importRes.json()) as { frames: { name: string; html: string }[] }
    expect(importData.frames[0]?.name).toBe('Keys')
    expect(importData.frames[0]?.html).not.toContain('<img')
  })
})

describe('Figma MCP agent tool', () => {
  let mcpCanvasId: string
  let agentSecret: string

  beforeAll(async () => {
    const createRes = await owner.post('/api/canvases', { name: 'Figma MCP Canvas' })
    mcpCanvasId = ((await createRes.json()) as { id: string }).id
    const keyRes = await owner.post('/api/agent-keys', { name: 'figma-agent' })
    agentSecret = ((await keyRes.json()) as { secret: string }).secret
  })

  it('allows an MCP agent to call import_figma and land frames on canvas', async () => {
    const res = await fetch(`${server.base}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${agentSecret}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'import_figma',
          arguments: {
            canvas_id: mcpCanvasId,
            url: 'https://www.figma.com/design/sampleFileKey/Mobile-App-UI?node-id=1-2',
            agent_name: 'DesignBot',
          },
        },
      }),
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as {
      result: { isError?: boolean; content: { type: string; text?: string }[] }
    }
    expect(json.result.isError).toBeFalsy()
    const text = json.result.content[0]?.text ?? ''
    expect(text).toContain('"success": true')
    expect(text).toContain('"count": 1')

    const canvasRes = await owner.get(`/api/canvases/${mcpCanvasId}`)
    const canvas = (await canvasRes.json()) as {
      frames: { id: string; name: string; width: number; height: number; html: string }[]
    }
    expect(canvas.frames).toHaveLength(1)
    const frame = canvas.frames[0]!
    expect(frame.name).toBe('Login Screen')
    expect(frame.width).toBe(375)
    expect(frame.height).toBe(812)
    expect(frame.html).toContain('Welcome to Doop')
  })
})
