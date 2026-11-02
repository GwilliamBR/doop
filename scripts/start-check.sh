#!/usr/bin/env bash
set -e

bun run typecheck
bun run lint
bun test tests/agentToolParity.test.ts
