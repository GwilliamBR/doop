import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client, startServer, type Server } from './harness.ts'

let server: Server
let figmaStub: HttpServer
let owner: Client
let stranger: Client

beforeAll(async () => {
  figmaStub = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const token = req.headers['x-figma-token']

    if (req.url === '/v1/me') {
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

    res.writeHead(404)
    res.end(JSON.stringify({ status: 404, err: 'Not found' }))
  })

  await new Promise<void>((resolve) => figmaStub.listen(0, resolve))
  const figmaPort = (figmaStub.address() as AddressInfo).port

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
