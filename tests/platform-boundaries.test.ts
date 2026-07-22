import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { readSafeDossierFile, UnsafeDossierPathError } from "../src/fs-safe.js";
import { parseJsonFileStrict } from "../src/json.js";
import { buildReferenceEvaluation } from "../src/reference-evaluator.js";
import { runEvaluator } from "../src/sdk.js";
import type { EvaluationRun, PrivateEd25519Jwk } from "../src/types.js";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CODEX_SKILL_ROOT = join(PROJECT_ROOT, "integrations", "codex", "evaldossier");
const CODEX_LAUNCHER = join(CODEX_SKILL_ROOT, "scripts", "evaldossier-local.mjs");

interface LauncherResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function temporaryDirectory(t: TestContext, label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `evaldossier-${label}-`));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function privateFixtureKey(name: string): Promise<PrivateEd25519Jwk> {
  return (await parseJsonFileStrict(
    join(PROJECT_ROOT, "fixtures", "keys", name),
  )) as unknown as PrivateEd25519Jwk;
}

function runLauncherThroughStdin(
  operation: "verify-stdin" | "conformance-stdin",
  request: Record<string, string>,
): Promise<LauncherResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [CODEX_LAUNCHER, operation, "--json"], {
      cwd: CODEX_SKILL_ROOT,
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

async function runLauncherThroughRequestFile(
  t: TestContext,
  operation: "verify-request" | "conformance-request",
  request: Record<string, string>,
): Promise<LauncherResult> {
  const requestRoot = await temporaryDirectory(t, `codex-${operation}`);
  const requestPath = join(requestRoot, "request.json");
  await writeFile(requestPath, `${JSON.stringify(request)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });

  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [CODEX_LAUNCHER, operation, "--request", requestPath, "--json"],
      {
        cwd: CODEX_SKILL_ROOT,
        env: { PATH: process.env.PATH ?? "" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code, stdout, stderr }));
  });
}

test("dossier paths reject reserved Win32 device segments portably", async (t) => {
  const dossierRoot = await temporaryDirectory(t, "windows-device-paths");
  const reservedPaths = [
    "CON",
    "prn.json",
    "folder/AUX.",
    "NUL ",
    "conin$",
    "CONOUT$.txt",
    "COM0",
    "com9.log",
    "COM¹",
    "com².txt",
    "LPT0",
    "lpt9.json",
    "LPT³:stream",
    "folder/CON .txt",
  ];

  for (const reservedPath of reservedPaths) {
    await assert.rejects(
      () => readSafeDossierFile(dossierRoot, reservedPath),
      (error: unknown) =>
        error instanceof UnsafeDossierPathError && error.code === "RESERVED_WINDOWS_DEVICE",
      reservedPath,
    );
  }

  for (const safeName of ["contest.json", "prn-data.json", "com10.json", "lpt10.json", "nulled.json"]) {
    await writeFile(join(dossierRoot, safeName), "safe", "utf8");
    assert.equal((await readSafeDossierFile(dossierRoot, safeName)).toString("utf8"), "safe");
  }
});

test("assembly rejects non-portable, duplicate and oversized output plans before creating output", async (t) => {
  const temporaryRoot = await temporaryDirectory(t, "assembly-plan");
  const [evaluatorKey, requesterKey, exporterKey] = await Promise.all([
    privateFixtureKey("reference-evaluator.private.jwk.json"),
    privateFixtureKey("requester.private.jwk.json"),
    privateFixtureKey("exporter.private.jwk.json"),
  ]);

  async function expectPlanRejection(
    label: string,
    mutate: (run: EvaluationRun) => void,
    expected: (error: unknown) => boolean,
  ): Promise<void> {
    const run = await buildReferenceEvaluation(PROJECT_ROOT, evaluatorKey, requesterKey);
    mutate(run);
    const outputDirectory = join(temporaryRoot, label);
    await assert.rejects(
      runEvaluator(
        {
          evaluatorId: "evaldossier-reference-evaluator",
          evaluate: () => run,
        },
        undefined,
        {
          outputDirectory,
          exporterKey,
          dossier: {
            dossierId: `platform-boundary.${label}`,
            generatedAt: "2026-07-22T12:00:10Z",
            classification: "INTERNAL_REFERENCE",
            exporterId: "evaldossier.fixture.exporter",
            audience: "evaldossier.platform-boundary.tests",
            nonce: "cGxhdGZvcm0tYm91bmRhcnktbm9uY2U",
          },
        },
      ),
      expected,
    );
    await assert.rejects(access(outputDirectory));
  }

  await expectPlanRejection(
    "reserved-device",
    (run) => {
      run.sourceArtifacts[0]!.dossierPath = "evidence/CON.json";
    },
    (error) =>
      error instanceof UnsafeDossierPathError && error.code === "RESERVED_WINDOWS_DEVICE",
  );
  await expectPlanRejection(
    "trailing-period",
    (run) => {
      run.sourceArtifacts[0]!.dossierPath = "evidence/report.";
    },
    (error) =>
      error instanceof UnsafeDossierPathError && error.code === "WINDOWS_NORMALIZED_SEGMENT",
  );
  await expectPlanRejection(
    "case-collision",
    (run) => {
      run.sourceArtifacts[1]!.dossierPath = "evidence/DELIVERABLE.json";
    },
    (error) => error instanceof Error && /case-colliding dossier path/u.test(error.message),
  );
  await expectPlanRejection(
    "too-many-entries",
    (run) => {
      const source = run.sourceArtifacts[0]!;
      run.sourceArtifacts = Array.from({ length: 59 }, (_, index) => ({
        ...source,
        artifactId: `oversized-${index}`,
        dossierPath: `evidence/oversized-${index}.json`,
      }));
    },
    (error) => error instanceof Error && /too many entries: 65/u.test(error.message),
  );
});

test("assembly reserves a new output root before reading source artifacts", async (t) => {
  const temporaryRoot = await temporaryDirectory(t, "assembly-existing-output");
  const outputDirectory = join(temporaryRoot, "already-present");
  await mkdir(outputDirectory);
  const markerPath = join(outputDirectory, "keep.txt");
  await writeFile(markerPath, "existing output must remain untouched", "utf8");

  const [evaluatorKey, requesterKey, exporterKey] = await Promise.all([
    privateFixtureKey("reference-evaluator.private.jwk.json"),
    privateFixtureKey("requester.private.jwk.json"),
    privateFixtureKey("exporter.private.jwk.json"),
  ]);
  const run = await buildReferenceEvaluation(PROJECT_ROOT, evaluatorKey, requesterKey);
  run.sourceArtifacts[0]!.sourcePath = join(temporaryRoot, "must-not-be-read.json");

  await assert.rejects(
    runEvaluator(
      {
        evaluatorId: "evaldossier-reference-evaluator",
        evaluate: () => run,
      },
      undefined,
      {
        outputDirectory,
        exporterKey,
        dossier: {
          dossierId: "platform-boundary.existing-output",
          generatedAt: "2026-07-22T12:00:10Z",
          classification: "INTERNAL_REFERENCE",
          exporterId: "evaldossier.fixture.exporter",
          audience: "evaldossier.platform-boundary.tests",
          nonce: "ZXhpc3Rpbmctb3V0cHV0LW5vbmNl",
        },
      },
    ),
    (error) => error instanceof Error && ("code" in error) && error.code === "EEXIST",
  );
  assert.equal(await readFile(markerPath, "utf8"), "existing output must remain untouched");
});

test("the source Codex Skill uses a unique structured request file and no live stdin", async () => {
  const skillPath = join(CODEX_SKILL_ROOT, "SKILL.md");
  const skill = await readFile(skillPath, "utf8");

  assert.match(skill, /exact fixed command `mktemp -d \/tmp\/evaldossier-request\.XXXXXXXX`/u);
  assert.match(skill, /structured `apply_patch` tool/u);
  assert.match(skill, /opaque system token/u);
  assert.match(skill, /compare it byte-for-byte before each call/u);
  assert.match(
    skill,
    /verify-request --request <system-generated-request-directory>\/request\.json --json/u,
  );
  assert.match(
    skill,
    /conformance-request --request <system-generated-request-directory>\/request\.json --json/u,
  );
  assert.match(skill, /structured working-directory field/u);
  assert.doesNotMatch(skill, /<skill-directory>/u);
  assert.match(skill, /Never use recursive deletion/u);
  assert.doesNotMatch(skill, /structured stdin tool/u);
  assert.doesNotMatch(skill, /evaldossier-local\.mjs verify \\\n/u);
  assert.doesNotMatch(skill, /--dossier <existing-local-directory>/u);
  assert.doesNotMatch(skill, /--output <new-local-directory>/u);
});

test("the fixed Codex request-file commands work without live stdin", async (t) => {
  const verification = await runLauncherThroughRequestFile(t, "verify-request", {
    schemaVersion: "evaldossier.local-verification-request/0.1",
    dossier: join(PROJECT_ROOT, "examples", "formal"),
    audience: "evaldossier.demo.consumer",
    nonce: "Zm9ybWFsLWRvc3NpZXItbm9uY2U",
    audienceSource: "user-request",
    nonceSource: "upstream-context",
  });
  const verificationOutput = JSON.parse(verification.stdout) as {
    status?: string;
    verificationStatus?: string;
  };

  assert.equal(verification.code, 0, verification.stderr);
  assert.equal(verificationOutput.status, "PASS");
  assert.equal(verificationOutput.verificationStatus, "VERIFIED");

  const temporaryRoot = await temporaryDirectory(t, "codex-conformance-request-output");
  const outputDirectory = join(temporaryRoot, "new-dossier");
  const conformance = await runLauncherThroughRequestFile(t, "conformance-request", {
    schemaVersion: "evaldossier.local-conformance-request/0.1",
    output: outputDirectory,
  });
  const conformanceOutput = JSON.parse(conformance.stdout) as {
    status?: string;
    verificationStatus?: string;
  };

  assert.equal(conformance.code, 0, conformance.stderr);
  assert.equal(conformanceOutput.status, "PASS");
  assert.equal(conformanceOutput.verificationStatus, "VERIFIED");
});

test("the legacy Codex stdin commands remain compatible", async (t) => {
  const verification = await runLauncherThroughStdin("verify-stdin", {
    schemaVersion: "evaldossier.local-verification-request/0.1",
    dossier: join(PROJECT_ROOT, "examples", "formal"),
    audience: "evaldossier.demo.consumer",
    nonce: "Zm9ybWFsLWRvc3NpZXItbm9uY2U",
    audienceSource: "user-request",
    nonceSource: "upstream-context",
  });
  const verificationOutput = JSON.parse(verification.stdout) as {
    status?: string;
    summary?: { audienceBinding?: string; dossierNonceBinding?: string };
  };

  assert.equal(verification.code, 0, verification.stderr);
  assert.equal(verificationOutput.status, "PASS");
  assert.equal(verificationOutput.summary?.audienceBinding, "PINNED");
  assert.equal(verificationOutput.summary?.dossierNonceBinding, "PINNED");

  const temporaryRoot = await temporaryDirectory(t, "codex-conformance-stdin");
  const outputDirectory = join(temporaryRoot, "new-dossier");
  const conformance = await runLauncherThroughStdin("conformance-stdin", {
    schemaVersion: "evaldossier.local-conformance-request/0.1",
    output: outputDirectory,
  });
  const conformanceOutput = JSON.parse(conformance.stdout) as { status?: string };

  assert.equal(conformance.code, 0, conformance.stderr);
  assert.equal(conformanceOutput.status, "PASS");
});
