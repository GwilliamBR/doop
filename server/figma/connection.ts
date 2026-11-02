import { and, eq } from 'drizzle-orm'
import { nanoid } from 'nanoid'
import { db } from '../db/index.ts'
import { integrations } from '../db/schema.ts'
import { FigmaError, getMe } from './client.ts'

const owned = (userId: string) => and(eq(integrations.userId, userId), eq(integrations.provider, 'figma'))

export async function getConnection(userId: string) {
  const [row] = await db.select().from(integrations).where(owned(userId))
  return row
}

export async function connectionStatus(userId: string) {
  const row = await getConnection(userId)
  if (!row) {
    return { connected: false }
  }
  return {
    connected: true,
    accountName: row.accountName,
    connectedAt: row.connectedAt,
  }
}

export async function connect(userId: string, token: string) {
  const accessToken = token.trim()
  if (!accessToken || !/^[A-Za-z0-9_.-]{10,500}$/.test(accessToken)) {
    throw new FigmaError('Enter a valid Figma personal access token.', 400)
  }

  const profile = await getMe(accessToken)
  const currentTimestamp = Date.now()
  const displayIdentifier = profile.handle
    ? profile.email
      ? `${profile.handle} (${profile.email})`
      : profile.handle
    : (profile.email ?? 'Figma account')

  const values = {
    accessToken,
    accountName: displayIdentifier,
    accounts: [],
    refreshToken: null,
    expiresAt: null,
    connectedAt: currentTimestamp,
    updatedAt: currentTimestamp,
  }

  await db
    .insert(integrations)
    .values({ id: nanoid(8), userId, provider: 'figma', ...values })
    .onConflictDoUpdate({ target: [integrations.userId, integrations.provider], set: values })
}

export async function disconnect(userId: string) {
  await db.delete(integrations).where(owned(userId))
}
