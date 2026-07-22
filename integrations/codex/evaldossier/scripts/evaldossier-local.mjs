#!/usr/bin/env node

import { runLocalIntegrationCli } from "../../../shared/evaldossier-local-core.mjs";

await runLocalIntegrationCli({
  hostName: "Codex",
  hostSlug: "codex",
  integrationId: "evaldossier-codex-local/0.1",
});
