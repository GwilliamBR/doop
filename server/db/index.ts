import { env } from '../env.ts'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from './schema.ts'

/**
 * DATABASE_URL set   -> real Postgres (production: Railway/Fly managed PG)
 * DATABASE_URL unset -> PGlite, an embedded Postgres persisted to ./data/pg
 * Same dialect, same schema, same queries either way.
 *
 * Schema changes: edit schema.ts / auth-schema.ts, then `npx drizzle-kit
 * generate` — the SQL lands in ./migrations and is applied here at boot.
 * Migration 0000 doubles as a baseline: fully idempotent, so databases
 * created by the pre-migration boot DDL adopt the journal cleanly.
 */

export type Db = NodePgDatabase<typeof schema>

export let db: Db

let closeClient: (() => Promise<void>) | undefined

/* resolved from this file, not process.cwd() — the server may be launched
   from anywhere (tests spawn it from a temp working directory) */
const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

function isCorruptPgliteError(error: unknown): boolean {
  return error instanceof WebAssembly.RuntimeError && /Aborted\(\)/.test(error.message)
}

function archiveCorruptedPgliteDir(dir: string): string {
  const backupDir = `${dir}.corrupted-${Date.now()}`
  fs.renameSync(dir, backupDir)
  fs.mkdirSync(dir, { recursive: true })
  return backupDir
}

export async function initDb(): Promise<void> {
  const url = env.DATABASE_URL
  if (url) {
    const { drizzle } = await import('drizzle-orm/node-postgres')
    db = drizzle(url, { schema })
    closeClient = undefined
    const { migrate } = await import('drizzle-orm/node-postgres/migrator')
    await migrate(db, { migrationsFolder: MIGRATIONS })
    return
  }

  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  const dir = path.join(process.cwd(), 'data', 'pg')
  fs.mkdirSync(dir, { recursive: true }) // PGlite's own mkdir isn't recursive

  const openAndMigrate = async () => {
    const client = await PGlite.create(dir)
    const pgliteDb = drizzle(client, { schema })
    await migrate(pgliteDb, { migrationsFolder: MIGRATIONS })
    closeClient = () => client.close()
    db = pgliteDb as unknown as Db
  }

  try {
    await openAndMigrate()
  } catch (error) {
    if (!isCorruptPgliteError(error)) throw error
    const backupDir = archiveCorruptedPgliteDir(dir)
    console.warn(`[db] PGlite data in ${dir} was corrupted; archived to ${backupDir} and reinitializing`)
    await openAndMigrate()
  }
}

export async function closeDb(): Promise<void> {
  const close = closeClient
  closeClient = undefined
  if (close) await close()
}
