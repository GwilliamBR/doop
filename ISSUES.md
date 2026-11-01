# Issues

## Vocabulary

**Web app**: the frontend served by Vite on port `4300` (proxying `/api` and `/mcp` to port `4400`), or by the Express server in production on port `4400`.
**MCP server**: the Model Context Protocol endpoint served at `/mcp` (`http://localhost:4300/mcp` in dev, `http://localhost:4400/mcp` on the backend).

## ISSUE-001: Login on web app and MCP server failing after initial configuration and testing

**Status**: fixed
**Opened**: 2026-10-31

**Symptom** (user's words):
"Doop stoped working after inicial configuration and testing. Login on web app and the MCP server are failing."
"Yes, bun. MCP server: error: calling "initialize": sending "initialize": rejected by transport: Post "http://localhost:4400/mcp": Post "http://localhost:4300/api/auth/mcp/token": dial tcp [::1]:4300: connect: connection refused [Authed]"

**Expected vs actual**:
Expected web app login (`http://localhost:4300` / `4400`) and MCP server initialization (`POST http://localhost:4400/mcp` and OAuth token refresh at `http://localhost:4300/api/auth/mcp/token`) to succeed. Instead, both fail because `data/pg` is corrupted from an ungraceful shutdown, crashing the backend on boot, and when only the backend or nothing is running on port `4300`, OAuth token requests to `BETTER_AUTH_URL` (`http://localhost:4300`) get `connection refused`.

**Reproduction**:
Reproduced: yes. Copying `data/pg` to `/tmp` and running `new PGlite('/tmp/doop-data-probe/pg')` crashes immediately during Postgres recovery with `PANIC: could not locate a valid checkpoint record at 0/19B45B8` and `RuntimeError: Aborted()`.

**Evidence**:

- [fact] No Doop process (`server/index.ts` on `:4400` or Vite on `:4300`) is currently listening (`ss -tlnp`).
- [fact] `data/pg/postmaster.pid` was left on disk at `20:16`, and `data/pg/global/pg_control` was last updated at `19:46` while `pg_wal/000000010000000000000001` was written at `19:56`.
- [fact] Running `PGlite` with `debug: 5` on a copy of `data/pg` logs: `LOG: database system was interrupted; last known up at 2026-10-31 19:46:36 -03`, `LOG: invalid resource manager ID in checkpoint record`, `PANIC: could not locate a valid checkpoint record at 0/19B45B8`, followed by `RuntimeError: Aborted()`.
- [fact] `server/db/index.ts:36-41` creates `new PGlite(dir)` without exposing `client.close()`, and `server/index.ts:153-161` handles `SIGINT`/`SIGTERM` by calling `persist.flush(...)` and `process.exit(0)` without closing the `PGlite` instance, leaving the WASM Postgres filesystem unflushed on exit.
- [fact] `server/env.ts:77-80` sets `BETTER_AUTH_URL` to `http://localhost:4300` by default in development (`server/index.ts:2245` advertises `authorization_servers: [env.BETTER_AUTH_URL]`), so an MCP client configured with `http://localhost:4400/mcp` is directed to `http://localhost:4300/api/auth/mcp/token` for OAuth token refresh.

**Probes run**:

- Copied `data/pg` to `/tmp/doop-data-test/pg` and initialized `PGlite` with `debug: 5`: predicted WAL/checkpoint corruption crash; got `PANIC: could not locate a valid checkpoint record at 0/19B45B8`.
- Removed `postmaster.pid` in the `/tmp` copy and retried `PGlite`: predicted startup if it was only a stale lockfile; still got `PANIC: could not locate a valid checkpoint record at 0/19B45B8`.

**Ruled out**:

- Stale `postmaster.pid` lockfile alone: deleting `postmaster.pid` in the scratch copy still fails with the corrupted checkpoint record in `pg_wal`.
- Invalid auth logic or bad user credentials: the database engine itself aborts in WASM before `initAuth()` or any route is ever reached (`server/index.ts:98`).

**Cause**: Two linked issues:

1. Unclean shutdown of the embedded `PGlite` database corrupted the write-ahead log checkpoint in `data/pg`, because `server/index.ts` exits on `SIGINT`/`SIGTERM` without calling `client.close()` on `PGlite`. Every subsequent server start crashes at `await initDb()` (`server/index.ts:98`).
2. The MCP client is pointed at `http://localhost:4400/mcp` while `BETTER_AUTH_URL` defaults to `http://localhost:4300` (the Vite dev server port), so OAuth token calls go to `:4300`, which refuses connections whenever Vite is not running.
   **Confidence**: High. Reproduced the exact `PGlite` crash against a copy of `data/pg` and traced the `:4400` to `:4300` OAuth redirect in `server/env.ts` and `server/index.ts`.
   **Fix direction**:
3. Export a database close helper in `server/db/index.ts` that calls `await client.close()` on the `PGlite` instance, and call it in the `SIGINT`/`SIGTERM` shutdown handler in `server/index.ts` after `persist.flush(...)` before exiting.
4. Reset or recover the corrupted local `data/pg` directory so `PGlite` can initialize cleanly, and start `bun run dev` (so both `:4300` and `:4400` are running).

**Open questions**:

- None
