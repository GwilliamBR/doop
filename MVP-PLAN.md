# Plan: Native Figma Extension for Doop

Branch: SLC (Simple, Lovable, Complete)
Mode: Full
Why this branch: The need is proven and Doop already ships the exact `ServerExtension` and `ClientIntegration` extension hooks (`server/extensions.ts`, `src/integrations/index.tsx`, `BrandMark` with `brand="figma"`, and the `integrations` database table). Building one focused workflow end to end (connect a Figma Personal Access Token, review/select frames from a Figma URL, and import them onto a canvas as editable HTML/CSS via UI or MCP) delivers a complete, self-contained feature without cloud-only dependencies.

## The job

A designer or developer using self-hosted Doop can connect their Figma Personal Access Token (`figd_...`) in the Integrations tab and import any Figma frame or file URL onto a Doop canvas as editable HTML/CSS in 3 steps, either from the Canvas Import modal or via the `import_figma` MCP tool.

## Learning goal

Verify that self-hosted Doop users and connected MCP agents can import real multi-frame Figma files into Doop canvases with accurate layout, typography, colors, and raster/vector fills, and iterate on the resulting HTML frames without manual copy-pasting.

## In scope

1. **Figma Connection (`server/figma/connection.ts`, `server/figma/client.ts`, `src/integrations/figma/index.tsx`)**:
   - Store and manage the user's Figma Personal Access Token (`figd_...`) in the existing `integrations` table (`provider = 'figma'`), verified against `GET https://api.figma.com/v1/me` to display the connected Figma user's handle/email.
   - Render the Figma card in `/integrations` (`FigmaSettingsCard` using `BrandMark brand="figma"`) supporting Connect, Replace Key, and Disconnect.
2. **Figma Node-to-HTML Importer (`server/figma/html.ts`, `server/figma/importer.ts`)**:
   - Parse Figma URLs (`/file/<key>/...` and `/design/<key>/...`, with optional `?node-id=...`).
   - Discover top-level frames across pages when given a file URL without a specific frame node, or inspect the targeted frame(s) directly.
   - Convert Figma node trees (`FRAME`, `COMPONENT`, `INSTANCE`, `GROUP`, `TEXT`, `RECTANGLE`, `VECTOR`, etc.) into self-contained, editable HTML/CSS documents (`flexbox` from `layoutMode`, absolute bounds fallback, typography, solid/gradient fills, strokes, corner radii, shadows, and downloaded image/SVG fills stored via Doop's `createAsset` pipeline).
3. **Canvas Import Routes & UI Modal (`server/figma/extension.ts`, `server/index.ts`, `src/pages/CanvasPage.tsx`, `src/integrations/figma/index.tsx`)**:
   - Re-enable the extension canvas router loop in `server/index.ts` (`app.use('/api/canvases/:id/${extension.id}', ...)`).
   - Mount `POST /api/canvases/:id/figma/discover` (lists available frames with dimensions and page names for review) and `POST /api/canvases/:id/figma/import` (imports selected node IDs or a single node URL onto the canvas).
   - Re-enable the `clientIntegrations` `ImportSection` and `integrationReview` slot in `CanvasPage.tsx`'s `ImportModal`, so "Figma" appears automatically in `importSources()` and lets the user paste a Figma link, review/check frames when a file has multiple frames, and land them on the canvas.
4. **MCP Server Tool (`import_figma` in `server/figma/extension.ts`, `tests/agentToolParity.test.ts`)**:
   - Register `import_figma` via `registerMcpTools` and document it in `mcpGuideLines`.
   - Update `tests/agentToolParity.test.ts` (`MISSING` list) so resident/MCP tool parity stays green.

## Quality floor

- **Immediate feedback:** Every button (`Connect`, `Replace key`, `Continue`, `Import`) shows an immediate busy state (`Checking…`, `Reading file…`, `Importing…`) within 100 ms.
- **Empty & unconfigured states:** If a user opens the Figma import screen on a canvas before connecting Figma in `/integrations`, show a direct prompt linking to `/integrations` (or inline token entry) instead of a dead end.
- **Clear error recovery:** Invalid tokens (`403` from Figma API), malformed Figma URLs, or rate limits (`429`) return human-readable messages explaining what happened and how to fix it.
- **Data safety:** Personal Access Tokens are validated before saving, stored only server-side in `integrations.access_token`, never echoed to the client, and replacing a key preserves the existing key until the new one is verified.

## Safety notes

- Does not touch real money or require database schema migrations (`integrations` table already exists).
- User's `figd_...` token is only sent to `https://api.figma.com/v1/*` over HTTPS.
- Image fills fetched from Figma's S3/CDN URLs pass through `createAsset` (5 MB cap, MIME sniffing).
- All tests use mocked Figma API responses or isolated test harnesses so no live customer files are mutated.

## How we will verify

- **Start Check command:** `bun run typecheck && bun run lint && bun run test tests/agentToolParity.test.ts`
- **Automated tests (`tests/figmaIntegration.test.ts`):**
  - Connecting, replacing, and disconnecting a `figd_...` token against a stubbed Figma `/v1/me` server.
  - Parsing Figma `/design/` and `/file/` URLs and converting auto-layout, text, shapes, and image fills into editable HTML frames.
  - Discovering frames in a multi-frame file and importing selected frames onto a canvas via `/api/canvases/:id/figma/discover` and `/api/canvases/:id/figma/import`.
  - Calling `import_figma` over MCP and verifying `tests/agentToolParity.test.ts`.
- **Browser / User check:** Open `/integrations`, connect the `figd_...` key, open a canvas, click **Import -> Figma**, paste a Figma link, select frames, and verify they appear on the canvas.

## Deferred (cut list)

- **Figma OAuth app flow (`FIGMA_CLIENT_ID` / `FIGMA_CLIENT_SECRET`):** Left out in favor of Personal Access Tokens (`figd_...`) so self-hosters need zero OAuth app registration.
- **Exporting Doop frames back to Figma (`FigmaExportModal`):** Out of scope for the import-first SLC.
- **Scheduled Automation pulls (`runAutomationPull` for Figma):** Can be layered on once interactive import is proven.
- **Figma webhooks / live two-way sync:** Out of scope.

## Done checklist

- [ ] **F1 (`journey`)**: A user can connect, replace, and disconnect a Figma Personal Access Token (`figd_...`) on the `/integrations` page, displaying their Figma account handle when connected.
- [ ] **F2 (`journey`)**: A user can open **Import -> Figma** on a canvas, paste a Figma frame URL or file URL, review and select frames from a multi-frame file, and land editable HTML/CSS frames on the canvas.
- [ ] **F3 (`journey`)**: An MCP agent can call `import_figma` with a canvas ID and Figma URL (and optional `node_ids`) to import Figma frames onto a canvas.
- [ ] **F4 (`quality_floor`)**: Unconnected users, invalid `figd_...` tokens, malformed Figma URLs, and rate-limited requests show clear, actionable recovery messages without losing existing connection state.
- [ ] **F5 (`safety`)**: Figma Personal Access Tokens are never returned in `/api/integrations` responses, and all imported remote images pass through `createAsset` validation.
- [ ] **F6 (`test`)**: `tests/figmaIntegration.test.ts`, `tests/agentToolParity.test.ts`, `bun run lint`, and `bun run typecheck` all pass with zero warnings or errors.

## Open questions

- None. Ready to initialize `.harness/` and build in the next session.
