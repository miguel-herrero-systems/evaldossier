#!/usr/bin/env node

import { runLocalIntegrationCli } from "../../../runtime/shared/evaldossier-local-core.mjs";

await runLocalIntegrationCli({
  hostName: "Codex",
  hostSlug: "codex",
  integrationId: "evaldossier-codex-plugin/0.1",
});
