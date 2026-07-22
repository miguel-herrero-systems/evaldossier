#!/usr/bin/env node

import { runLocalIntegrationCli } from "../runtime/shared/evaldossier-local-core.mjs";

await runLocalIntegrationCli({
  hostName: "Claude Code",
  hostSlug: "claude-code",
  integrationId: "evaldossier-claude-code-plugin/0.1",
});
