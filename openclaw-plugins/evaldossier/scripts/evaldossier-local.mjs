#!/usr/bin/env node

const [nodeMajor, nodeMinor] = process.versions.node
  .split(".")
  .slice(0, 2)
  .map((value) => Number.parseInt(value, 10));

if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 11)) {
  process.stderr.write(
    `${JSON.stringify({
      schemaVersion: "evaldossier.local-error/0.1",
      integration: "evaldossier-openclaw-local/0.1",
      verificationStatus: "NOT_VERIFIED",
      error: {
        code: "UNSUPPORTED_NODE_VERSION",
        required: ">=20.11",
      },
    })}\n`,
  );
  process.exitCode = 1;
} else if (process.argv[2] !== "verify-request") {
  process.stdout.write(
    `${JSON.stringify({
      integration: "evaldossier-openclaw-plugin/0.1",
      operation: "unknown",
      status: "FAIL",
      verificationStatus: "NOT_VERIFIED",
      error: {
        code: "UNSUPPORTED_PLUGIN_OPERATION",
        message: "The native OpenClaw plugin launcher only accepts verify-request",
      },
    }, null, 2)}\n`,
  );
  process.exitCode = 1;
} else {
  const { runLocalIntegrationCli } = await import(
    "../runtime/shared/evaldossier-local-core.mjs"
  );

  await runLocalIntegrationCli({
    hostName: "OpenClaw",
    hostSlug: "openclaw",
    integrationId: "evaldossier-openclaw-plugin/0.1",
  });
}
