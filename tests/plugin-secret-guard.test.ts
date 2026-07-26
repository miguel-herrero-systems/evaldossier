import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const guardScript = join(projectRoot, "scripts", "check-agent-plugin-secrets.mjs");
const ciWorkflow = join(projectRoot, ".github", "workflows", "ci.yml");

function runGuard(root: string) {
  return spawnSync(process.execPath, [guardScript, root], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

async function temporaryPayload(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "evaldossier-plugin-secret-guard-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "fixtures"), { recursive: true });
  return root;
}

test("plugin secret guard allows public verification JWKs", async (t) => {
  const root = await temporaryPayload(t);
  await writeFile(
    join(root, "fixtures", "public.jwk.json"),
    `${JSON.stringify({
      alg: "EdDSA",
      crv: "Ed25519",
      kid: "public-test-key",
      kty: "OKP",
      use: "sig",
      x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    })}\n`,
    "utf8",
  );
  const result = runGuard(root);
  assert.equal(result.status, 0, result.stderr);
});

test("plugin secret guard rejects private-key filenames", async (t) => {
  const root = await temporaryPayload(t);
  await writeFile(join(root, "fixtures", "fixture.private.txt"), "synthetic\n", "utf8");
  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private-key filename is forbidden/u);
});

test("plugin secret guard rejects private JWK members under innocuous filenames", async (t) => {
  const root = await temporaryPayload(t);
  await writeFile(
    join(root, "fixtures", "verification-key.json"),
    `${JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "public", d: "private" })}\n`,
    "utf8",
  );
  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private JWK member d is forbidden/u);
});

test("plugin secret guard rejects PEM private keys", async (t) => {
  const root = await temporaryPayload(t);
  await writeFile(
    join(root, "fixtures", "verification-key.txt"),
    "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n",
    "utf8",
  );
  const result = runGuard(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /private PEM material is forbidden/u);
});

test("CI invokes the plugin secret guard directly outside the build command", async () => {
  const workflow = await readFile(ciWorkflow, "utf8");
  assert.match(workflow, /run: node scripts\/check-agent-plugin-secrets\.mjs/u);
});

test("the default secret guard covers Codex, Claude Code and OpenClaw payloads", async () => {
  const guard = await readFile(guardScript, "utf8");
  assert.match(guard, /join\(projectRoot, "plugins", "evaldossier"\)/u);
  assert.match(guard, /join\(projectRoot, "claude-plugins", "evaldossier"\)/u);
  assert.match(guard, /join\(projectRoot, "openclaw-plugins", "evaldossier"\)/u);
});
