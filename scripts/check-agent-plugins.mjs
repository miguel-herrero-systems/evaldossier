#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codexPluginRoot = join(projectRoot, "plugins", "evaldossier");
const claudePluginRoot = join(projectRoot, "claude-plugins", "evaldossier");
const forbiddenPublicTokenDigests = new Set([
  "83e3c2839af3037f287f9ad277c987d5220b5abd4a260a4f255bf7a3a1a9199f",
  "036ad6f9c6ee63ded72595d531443f8c9c818ba22345b6ec96318ac99a522997",
  "a6a9bc7fa47332c0e50487dc4c132605c2fb86aa61add7873b464da57e0bf9b1",
  "d804214808d35a82bdb024462c43080a70c184c884d3b62590304a711e81e048",
  "e0e0d3c4a4f5a1d4573a6f847d3a5bc6f7d87fb539f4e2348b1391113bd74113",
]);
const localHomePathPattern = /(?:^|[^A-Za-z0-9])(?:\/Users\/|\/home\/)[^/\s"'<>]+/u;
const internalDocumentTokenPattern =
  /(?:^|[^A-Za-z0-9])(?:RESUMEN|OUTREACH|CHECKPOINT|STRATEGY)[A-Z0-9_-]*/u;

function toPosix(value) {
  return value.split(sep).join("/");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function listFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      assert.equal(metadata.isSymbolicLink(), false, `symlink forbidden: ${path}`);
      if (metadata.isDirectory()) {
        await walk(path);
      } else {
        assert.equal(metadata.isFile(), true, `non-file entry forbidden: ${path}`);
        assert.equal(metadata.nlink, 1, `hard-linked plugin file forbidden: ${path}`);
        files.push(path);
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function inventory(root) {
  const result = [];
  for (const path of await listFiles(root)) {
    const bytes = await readFile(path);
    result.push({
      path: toPosix(relative(root, path)),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return result;
}

async function validateManifest(pluginRoot) {
  const manifest = JSON.parse(
    await readFile(join(pluginRoot, "runtime", "BUNDLE_MANIFEST.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, "evaldossier.agent-plugin-bundle/0.1");
  assert.equal(manifest.runtimeCodeGeneration.callerSuppliedCode, false);
  assert.equal(manifest.runtimeCodeGeneration.evaluatorDiscovery, false);
  assert.equal(
    manifest.runtimeCodeGeneration.committedSchemaCompilation,
    "AJV_RUNTIME_CODE_GENERATION",
  );
  assert.ok(manifest.externalImports.every((path) => path.startsWith("node:")));
  const actual = new Map(
    (await inventory(pluginRoot)).map((entry) => [entry.path, entry]),
  );
  for (const expected of manifest.assets) {
    assert.deepEqual(actual.get(expected.path), expected, `bundle digest mismatch: ${expected.path}`);
  }
  return manifest;
}

async function assertExactPluginTree(pluginRoot, hostFiles) {
  const manifest = await validateManifest(pluginRoot);
  const expected = new Set([
    ...manifest.assets.map((entry) => entry.path),
    "runtime/BUNDLE_MANIFEST.json",
    ...hostFiles,
  ]);
  const actual = (await inventory(pluginRoot)).map((entry) => entry.path);
  assert.deepEqual(actual, [...expected].sort((left, right) => left.localeCompare(right, "en")));

  for (const path of await listFiles(pluginRoot)) {
    const bytes = await readFile(path);
    if (bytes.includes(0)) {
      continue;
    }
    const text = bytes.toString("utf8");
    assert.equal(localHomePathPattern.test(text), false, `local home path leaked into ${path}`);
    assert.equal(
      internalDocumentTokenPattern.test(text),
      false,
      `internal document marker leaked into ${path}`,
    );
    for (const token of text.match(/[A-Za-z0-9._-]+/gu) ?? []) {
      assert.equal(
        forbiddenPublicTokenDigests.has(sha256(Buffer.from(token, "utf8"))),
        false,
        `internal token marker leaked into ${path}`,
      );
    }
  }
}

function runNode(script, args, options = {}) {
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: options.cwd,
      env: {
        PATH: dirname(process.execPath),
        NODE_PATH: join(options.cwd, "hostile-node-path"),
        NODE_OPTIONS: "--no-addons",
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectResult);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    if (options.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.stdin);
    }
  });
}

function parsed(result) {
  return JSON.parse(result.stdout);
}

function verificationRequest(dossier, overrides = {}) {
  return {
    schemaVersion: "evaldossier.local-verification-request/0.1",
    dossier,
    audience: "evaldossier.demo.consumer",
    nonce: "Zm9ybWFsLWRvc3NpZXItbm9uY2U",
    audienceSource: "user-request",
    nonceSource: "upstream-context",
    ...overrides,
  };
}

function oneLine(value) {
  return `${JSON.stringify(value)}\n`;
}

function withoutIntegration(value) {
  return { ...value, integration: "evaldossier-host-plugin/0.1" };
}

await assertExactPluginTree(codexPluginRoot, [
  ".codex-plugin/plugin.json",
  "README.md",
  "skills/verify/SKILL.md",
  "skills/verify/agents/openai.yaml",
  "skills/verify/scripts/evaldossier-local.mjs",
]);
await assertExactPluginTree(claudePluginRoot, [
  ".claude-plugin/plugin.json",
  "README.md",
  "scripts/evaldossier-local.mjs",
  "skills/verify/SKILL.md",
]);

const [codexInventory, claudeInventory] = await Promise.all([
  inventory(codexPluginRoot),
  inventory(claudePluginRoot),
]);
const commonPath = (path) =>
  path === "LICENSE" ||
  path.startsWith("fixtures/") ||
  path.startsWith("runtime/") ||
  path.startsWith("schemas/");
assert.deepEqual(
  codexInventory.filter((entry) => commonPath(entry.path)),
  claudeInventory.filter((entry) => commonPath(entry.path)),
  "Codex and Claude common payloads must be byte-identical",
);

const isolatedRoot = await mkdtemp(join(tmpdir(), "evaldossier-$(touch marker)-"));
try {
  const isolatedCodex = join(isolatedRoot, "codex plugin 'quoted'");
  const isolatedClaude = join(isolatedRoot, "claude plugin 'quoted'");
  const workspace = join(isolatedRoot, "workspace $(touch marker)");
  await Promise.all([
    cp(codexPluginRoot, isolatedCodex, { recursive: true }),
    cp(claudePluginRoot, isolatedClaude, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const formalDossier = join(workspace, "formal dossier");
  const modelDossier = join(workspace, "model dossier");
  await Promise.all([
    cp(join(projectRoot, "examples", "formal"), formalDossier, { recursive: true }),
    cp(join(projectRoot, "examples", "model-judgment"), modelDossier, { recursive: true }),
  ]);

  const codexLauncher = join(
    isolatedCodex,
    "skills",
    "verify",
    "scripts",
    "evaldossier-local.mjs",
  );
  const claudeLauncher = join(isolatedClaude, "scripts", "evaldossier-local.mjs");
  const formalRequest = verificationRequest(formalDossier);
  const claudeRequestPath = join(workspace, "claude-request.json");
  await writeFile(claudeRequestPath, JSON.stringify(formalRequest), "utf8");

  const [codexVerify, claudeVerify] = await Promise.all([
    runNode(codexLauncher, ["verify-stdin", "--json"], {
      cwd: workspace,
      stdin: oneLine(formalRequest),
    }),
    runNode(
      claudeLauncher,
      ["verify-request", "--request", claudeRequestPath, "--json"],
      { cwd: workspace },
    ),
  ]);
  assert.equal(codexVerify.code, 0, codexVerify.stderr);
  assert.equal(claudeVerify.code, 0, claudeVerify.stderr);
  assert.deepEqual(withoutIntegration(parsed(codexVerify)), withoutIntegration(parsed(claudeVerify)));
  assert.equal(parsed(codexVerify).integration, "evaldossier-codex-plugin/0.1");
  assert.equal(parsed(claudeVerify).integration, "evaldossier-claude-code-plugin/0.1");
  assert.equal(parsed(codexVerify).summary.economicAction, "OUT_OF_SCOPE");

  const modelRequest = verificationRequest(modelDossier, {
    nonce: "synthetic-model-judgment-nonce-0001",
    nonceSource: "user-request",
  });
  const modelResult = await runNode(codexLauncher, ["verify-stdin", "--json"], {
    cwd: workspace,
    stdin: oneLine(modelRequest),
  });
  assert.equal(modelResult.code, 0, modelResult.stderr);
  assert.equal(parsed(modelResult).summary.overallBasis, "MODEL_JUDGMENT");
  assert.equal(parsed(modelResult).summary.obligationVerdict, "INCONCLUSIVE");

  const wrongPin = await runNode(codexLauncher, ["verify-stdin", "--json"], {
    cwd: workspace,
    stdin: oneLine(verificationRequest(formalDossier, { audience: "wrong" })),
  });
  assert.equal(wrongPin.code, 1);
  assert.equal(parsed(wrongPin).error.code, "VERIFICATION_FAILED");

  const extraLine = await runNode(codexLauncher, ["verify-stdin", "--json"], {
    cwd: workspace,
    stdin: `${JSON.stringify(formalRequest)}\n{}\n`,
  });
  assert.equal(extraLine.code, 1);
  assert.equal(parsed(extraLine).error.code, "INVALID_VERIFICATION_REQUEST");

  const injectedPath = join(workspace, "$(touch marker)");
  const injected = await runNode(codexLauncher, ["verify-stdin", "--json"], {
    cwd: workspace,
    stdin: oneLine(verificationRequest(injectedPath)),
  });
  assert.equal(injected.code, 1);
  await assert.rejects(access(join(workspace, "marker")), { code: "ENOENT" });

  const targetRequest = join(workspace, "request-target.json");
  await writeFile(targetRequest, JSON.stringify(formalRequest), "utf8");
  const symlinkRequest = join(workspace, "request-symlink.json");
  const hardlinkRequest = join(workspace, "request-hardlink.json");
  await symlink(targetRequest, symlinkRequest);
  await link(targetRequest, hardlinkRequest);
  for (const requestPath of [symlinkRequest, hardlinkRequest]) {
    const result = await runNode(
      claudeLauncher,
      ["verify-request", "--request", requestPath, "--json"],
      { cwd: workspace },
    );
    assert.equal(result.code, 1);
    assert.equal(parsed(result).error.code, "INVALID_VERIFICATION_REQUEST");
  }

  const codexOutput = join(workspace, "codex conformance");
  const claudeOutput = join(workspace, "claude conformance");
  const [codexConformance, claudeConformance] = await Promise.all([
    runNode(codexLauncher, ["conformance-stdin", "--json"], {
      cwd: workspace,
      stdin: oneLine({
        schemaVersion: "evaldossier.local-conformance-request/0.1",
        output: codexOutput,
      }),
    }),
    runNode(
      claudeLauncher,
      ["conformance", "--output", claudeOutput, "--json"],
      { cwd: workspace },
    ),
  ]);
  assert.equal(codexConformance.code, 0, codexConformance.stderr);
  assert.equal(claudeConformance.code, 0, claudeConformance.stderr);
  assert.equal(parsed(codexConformance).summary.overallBasis, "FORMAL_PREDICATE");
  assert.equal(parsed(claudeConformance).summary.overallBasis, "FORMAL_PREDICATE");
  assert.equal(parsed(codexConformance).summary.obligationVerdict, "SATISFIED");
  assert.equal(parsed(claudeConformance).summary.obligationVerdict, "SATISFIED");
  assert.deepEqual(parsed(codexConformance).checks, parsed(claudeConformance).checks);

  await assert.rejects(access(join(isolatedRoot, "marker")), { code: "ENOENT" });
} finally {
  await rm(isolatedRoot, { recursive: true, force: true });
}

process.stdout.write(
  "Standalone Codex and Claude plugin payloads passed deterministic, isolated and adversarial checks.\n",
);
