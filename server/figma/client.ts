import { z } from 'zod'
import { env } from '../env.ts'

export class FigmaError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message)
  }
}

export const figmaUserSchema = z.object({
  id: z.string(),
  email: z.string().optional(),
  handle: z.string(),
  img_url: z.string().optional(),
})

export type FigmaUser = z.infer<typeof figmaUserSchema>

export async function figmaFetch<T>(endpoint: string, token: string, schema: z.ZodType<T>): Promise<T> {
  const url = `${env.FIGMA_API_URL}${endpoint}`
  let response: Response

  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Figma-Token': token,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new FigmaError('Could not reach Figma. Try again.')
  }

  if (response.status === 401 || response.status === 403) {
    throw new FigmaError('Figma rejected this token. Verify the token and try again.', 401)
  }

  if (response.status === 429) {
    throw new FigmaError('Figma rate limit reached. Try again later.', 429)
  }

  if (response.status === 404) {
    throw new FigmaError('Figma file or node not found.', 404)
  }

  if (!response.ok) {
    throw new FigmaError('Figma could not complete this request.', response.status)
  }

  const jsonBody = await response.json().catch(() => null)
  const parsed = schema.safeParse(jsonBody)
  if (!parsed.success) {
    throw new FigmaError('Figma returned an unexpected response.')
  }

  return parsed.data
}

export async function getMe(token: string): Promise<FigmaUser> {
  return figmaFetch('/me', token, figmaUserSchema)
}
