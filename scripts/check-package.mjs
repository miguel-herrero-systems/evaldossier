import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(
  await readFile(join(projectRoot, "package.json"), "utf8"),
);

const expectedExports = {
  ".": {
    types: "./dist/src/index.d.ts",
    import: "./dist/src/index.js",
  },
  "./sdk": {
    types: "./dist/src/sdk.d.ts",
    import: "./dist/src/sdk.js",
  },
  "./schemas/*": "./schemas/*",
  "./package.json": "./package.json",
};

assert.equal(manifest.private, true, "package must remain private until registry release");
assert.equal(manifest.main, "./dist/src/index.js", "unexpected package main entrypoint");
assert.equal(manifest.types, "./dist/src/index.d.ts", "unexpected package types entrypoint");
assert.deepEqual(manifest.exports, expectedExports, "unexpected package exports map");
assert.deepEqual(
  manifest.bin,
  { evaldossier: "dist/src/cli.js" },
  "unexpected package CLI entrypoint",
);

const approvedFixtureDigests = new Map([
  [
    "fixtures/keys/adapter.private.jwk.json",
    "a40f4748ccd18c6faff41508a64822e00ff749a6b6e3cfb0089ce63246758d50",
  ],
  [
    "fixtures/keys/exporter.private.jwk.json",
    "c3489f235c4707f1cb8ed21a2c7c070a38a683e63048feb8f27379be4a1744ac",
  ],
  [
    "fixtures/keys/reference-evaluator.private.jwk.json",
    "ea3bc4174875a81db23cf807e836a6ffe2dcb0513ed415b313d415841d20c912",
  ],
  [
    "fixtures/keys/requester.private.jwk.json",
    "060cbe594ccab8a064646cf32d0645dd8ff9cb4c886a12ecb008fe85cba2f0d1",
  ],
]);

for (const [path, expectedDigest] of approvedFixtureDigests) {
  const bytes = await readFile(join(projectRoot, path));
  const actualDigest = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    actualDigest,
    expectedDigest,
    `approved public fixture changed and requires explicit review: ${path}`,
  );
}

const isolatedCache = await mkdtemp(join(tmpdir(), "evaldossier-npm-cache-"));
let output;
try {
  output = execFileSync(
    "npm",
    ["pack", "--dry-run", "--json", "--cache", isolatedCache],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      cwd: projectRoot,
    },
  );
} finally {
  await rm(isolatedCache, { recursive: true, force: true });
}
const reports = JSON.parse(output);
if (!Array.isArray(reports) || reports.length !== 1 || !Array.isArray(reports[0].files)) {
  throw new Error("npm pack did not return one package report");
}

const paths = new Set(reports[0].files.map((entry) => entry.path));
const required = [
  "package.json",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "THREAT_MODEL.md",
  "dist/src/index.d.ts",
  "dist/src/index.js",
  "dist/src/cli.js",
  "dist/src/sdk.d.ts",
  "dist/src/sdk.js",
  "docs/SDK.md",
  "examples/sdk/reference-evaluator.mjs",
  ...approvedFixtureDigests.keys(),
  "schemas/common.schema.json",
  "schemas/dossier.schema.json",
  "schemas/evaluation-attestation.schema.json",
  "schemas/evaluation-request.schema.json",
  "schemas/evaluator-manifest.schema.json",
  "schemas/evidence-bundle.schema.json",
  "schemas/profile-definition.schema.json",
];
for (const path of required) {
  if (!paths.has(path)) {
    throw new Error(`package is missing required artifact: ${path}`);
  }
}

const forbiddenPrefixes = ["dist/tests/", "demo-output/", ".git/", "node_modules/"];
const sensitiveExactNames = new Set([
  ".envrc",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "secret.json",
  "secrets.json",
  "token.json",
]);

function hasCommonSensitiveFilename(path) {
  if (approvedFixtureDigests.has(path)) {
    return false;
  }
  const basename = path.toLowerCase().split("/").at(-1);
  if (basename === undefined) {
    return false;
  }
  return (
    /^\.env(?:$|[._-])/.test(basename) ||
    sensitiveExactNames.has(basename) ||
    /\.(?:jks|key|keystore|p12|pem|pfx)$/.test(basename) ||
    /\.private\.jwk(?:\.json)?$/.test(basename) ||
    /^(?:client[-_]secret|service[-_]account)(?:[._-].*)?\.json$/.test(basename)
  );
}

for (const path of paths) {
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`package contains forbidden path: ${path}`);
  }
  if (hasCommonSensitiveFilename(path)) {
    throw new Error(`package contains a common sensitive filename: ${path}`);
  }
}

const cli = await readFile(join(projectRoot, manifest.bin.evaldossier), "utf8");
if (!cli.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("packaged CLI entrypoint is missing its Node.js shebang");
}

const binSmokeRoot = await mkdtemp(join(tmpdir(), "evaldossier-bin-smoke-"));
try {
  const linkedCli = join(binSmokeRoot, "evaldossier");
  await symlink(join(projectRoot, manifest.bin.evaldossier), linkedCli);
  const help = execFileSync(process.execPath, [linkedCli, "--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    cwd: projectRoot,
  });
  if (!help.includes("EvalDossier SDK 0.2")) {
    throw new Error("packaged CLI entrypoint did not execute through a bin symlink");
  }
} finally {
  await rm(binSmokeRoot, { recursive: true, force: true });
}

process.stdout.write(
  `Package policy: PASS (${paths.size} files; entrypoints and bin execution valid; schemas present; common sensitive filenames absent; approved public fixture keys pinned)\n`,
);
