import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import register from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtureDossier = join(here, "fixture-dossier");
const audience = "evaldossier.openclaw.skill.example";
const nonce = "b3BlbmNsYXctc2tpbGwtcmVmZXJlbmNlLW5vbmNlLTAwMQ";

function createHarness(workspace) {
  let command;
  const api = {
    runtime: {
      version: "2026.7.1-2",
      agent: {
        resolveAgentWorkspaceDir: () => workspace,
      },
    },
    registerCommand(definition) {
      command = definition;
    },
  };
  register(api);
  assert.ok(command, "plugin must register one command");
  assert.equal(command.name, "evaldossier-check");
  assert.equal(command.acceptsArgs, true);
  assert.equal(command.requireAuth, true);
  return command;
}

function request(overrides = {}) {
  return {
    schemaVersion: "evaldossier.local-verification-request/0.1",
    dossier: "incoming/dossier",
    audience,
    nonce,
    audienceSource: "user-request",
    nonceSource: "user-request",
    ...overrides,
  };
}

async function writeRequest(workspace, relativePath, value) {
  const path = join(workspace, ...relativePath.split("/"));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function context(args, runtimeContext = undefined) {
  return {
    channel: "test",
    isAuthorizedSender: true,
    agentId: "main",
    args,
    commandBody: `/evaldossier-check ${args}`,
    config: {},
    runtimeContext,
    requestConversationBinding: async () => ({ status: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
  };
}

function parseResult(result) {
  assert.equal(typeof result.text, "string");
  return JSON.parse(result.text);
}

test("native command gate: 5 positive and 6 negative cases", async (suite) => {
  const workspace = await mkdtemp(join(tmpdir(), "evaldossier-native-openclaw-"));
  await mkdir(join(workspace, "incoming"), { recursive: true });
  await cp(fixtureDossier, join(workspace, "incoming", "dossier"), { recursive: true });
  const command = createHarness(workspace);

  await suite.test("P1 valid user-supplied pins", async () => {
    await writeRequest(workspace, "requests/p1.json", request());
    const output = parseResult(await command.handler(context("requests/p1.json")));
    assert.equal(output.status, "PASS", JSON.stringify(output));
    assert.equal(output.verificationStatus, "VERIFIED");
    assert.equal(output.integration, "evaldossier-openclaw-plugin/0.1");
  });

  await suite.test("P2 valid upstream-context pins", async () => {
    await writeRequest(
      workspace,
      "requests/p2.json",
      request({ audienceSource: "upstream-context", nonceSource: "upstream-context" }),
    );
    const output = parseResult(await command.handler(context("requests/p2.json")));
    assert.equal(output.status, "PASS", JSON.stringify(output));
    assert.equal(output.pinProvenance.audience, "UPSTREAM_CONTEXT");
    assert.equal(output.pinProvenance.nonce, "UPSTREAM_CONTEXT");
  });

  await suite.test("P3 repeat verification is deterministic", async () => {
    await writeRequest(workspace, "requests/p3.json", request());
    const first = await command.handler(context("requests/p3.json"));
    const second = await command.handler(context("requests/p3.json"));
    assert.equal(first.text, second.text);
  });

  await suite.test("P4 result preserves the economic boundary and non-claims", async () => {
    await writeRequest(workspace, "requests/p4.json", request());
    const output = parseResult(await command.handler(context("requests/p4.json")));
    assert.equal(output.status, "PASS", JSON.stringify(output));
    assert.equal(output.summary.economicAction, "OUT_OF_SCOPE");
    assert.ok(output.nonClaims.some((value) => value.includes("payment entitlement")));
  });

  await suite.test("P5 command does not access an LLM runtime", async () => {
    await writeRequest(workspace, "requests/p5.json", request());
    const runtimeContext = {};
    Object.defineProperty(runtimeContext, "llm", {
      get() {
        throw new Error("LLM runtime must not be accessed");
      },
    });
    const output = parseResult(await command.handler(context("requests/p5.json", runtimeContext)));
    assert.equal(output.status, "PASS", JSON.stringify(output));
  });

  await suite.test("N1 wrong audience fails closed", async () => {
    await writeRequest(workspace, "requests/n1.json", request({ audience: "wrong-audience" }));
    const output = parseResult(await command.handler(context("requests/n1.json")));
    assert.equal(output.status, "FAIL");
    assert.equal(output.verificationStatus, "NOT_VERIFIED");
  });

  await suite.test("N2 wrong nonce fails closed", async () => {
    await writeRequest(workspace, "requests/n2.json", request({ nonce: "wrong-nonce" }));
    const output = parseResult(await command.handler(context("requests/n2.json")));
    assert.equal(output.status, "FAIL");
    assert.equal(output.verificationStatus, "NOT_VERIFIED");
  });

  await suite.test("N3 request traversal is rejected before execution", async () => {
    const output = parseResult(await command.handler(context("../request.json")));
    assert.equal(output.status, "FAIL");
    assert.equal(output.error.code, "INVALID_WORKSPACE_PATH");
  });

  await suite.test("N4 symlinked request is rejected", async () => {
    await writeRequest(workspace, "requests/n4-target.json", request());
    await symlink("n4-target.json", join(workspace, "requests", "n4-link.json"));
    const output = parseResult(await command.handler(context("requests/n4-link.json")));
    assert.equal(output.status, "FAIL");
    assert.equal(output.error.code, "SYMLINK_FORBIDDEN");
  });

  await suite.test("N5 dossier symlink outside the workspace is rejected", async () => {
    await symlink(fixtureDossier, join(workspace, "escape-dossier"));
    await writeRequest(
      workspace,
      "requests/n5.json",
      request({ dossier: "escape-dossier" }),
    );
    const output = parseResult(await command.handler(context("requests/n5.json")));
    assert.equal(output.status, "FAIL");
    assert.equal(output.error.code, "SYMLINK_FORBIDDEN");
  });

  await suite.test("N6 existing non-dossier content fails without echoing content or absolute paths", async () => {
    const marker = "PRIVATE_NON_DOSSIER_MARKER_6c099520";
    await mkdir(join(workspace, "incoming", "not-a-dossier"), { recursive: true });
    await writeFile(
      join(workspace, "incoming", "not-a-dossier", "unrelated.json"),
      `${JSON.stringify({ marker })}\n`,
      { mode: 0o600 },
    );
    await writeRequest(
      workspace,
      "requests/n6.json",
      request({ dossier: "incoming/not-a-dossier" }),
    );
    const result = await command.handler(context("requests/n6.json"));
    const output = parseResult(result);
    assert.equal(output.status, "FAIL");
    assert.equal(output.verificationStatus, "NOT_VERIFIED");
    assert.equal(result.text.includes(marker), false);
    assert.equal(result.text.includes(workspace), false);
  });
});
