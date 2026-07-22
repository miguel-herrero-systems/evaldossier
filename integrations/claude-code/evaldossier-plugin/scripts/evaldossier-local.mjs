#!/usr/bin/env node

import { runLocalIntegrationCli } from "../../../shared/evaldossier-local-core.mjs";

await runLocalIntegrationCli({
  hostName: "Claude Code",
  hostSlug: "claude-code",
  integrationId: "evaldossier-claude-code-local/0.1",
});
