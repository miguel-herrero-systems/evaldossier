import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/core";

const REQUEST_SCHEMA_VERSION = "evaldossier.local-verification-request/0.1";
const INTEGRATION_ID = "evaldossier-openclaw-plugin/0.1";
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_COMMAND_PATH_BYTES = 512;
const REQUEST_KEYS = Object.freeze([
  "audience",
  "audienceSource",
  "dossier",
  "nonce",
  "nonceSource",
  "schemaVersion",
]);

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = resolve(pluginRoot, "scripts", "evaldossier-local.mjs");

type VerificationRequest = {
  audience: string;
  audienceSource: string;
  dossier: string;
  nonce: string;
  nonceSource: string;
  schemaVersion: string;
};

class CommandFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CommandFailure";
  }
}

function failure(code: string, message: string): PluginCommandResult {
  return {
    text: JSON.stringify(
      {
        integration: INTEGRATION_ID,
        operation: "verify",
        status: "FAIL",
        verificationStatus: "NOT_VERIFIED",
        error: { code, message },
      },
      null,
      2,
    ),
  };
}

function assertRelativeWorkspacePath(value: string, label: string): string[] {
  if (
    value.length === 0
    || Buffer.byteLength(value, "utf8") > MAX_COMMAND_PATH_BYTES
    || value.includes("\0")
    || value.includes("\\")
    || value.includes("\n")
    || value.includes("\r")
    || isAbsolute(value)
    || win32.isAbsolute(value)
  ) {
    throw new CommandFailure("INVALID_WORKSPACE_PATH", `${label} must be a short relative workspace path`);
  }
  const segments = value.split("/");
  if (
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || !/^[A-Za-z0-9._/-]+$/u.test(value)
  ) {
    throw new CommandFailure(
      "INVALID_WORKSPACE_PATH",
      `${label} contains an unsupported path segment or character`,
    );
  }
  return segments;
}

function pathIsInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

async function resolveConfinedPath(
  workspace: string,
  input: string,
  label: string,
  expectedKind: "file" | "directory",
): Promise<{ root: string; relativePath: string; absolutePath: string }> {
  const segments = assertRelativeWorkspacePath(input, label);
  const root = await realpath(workspace);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory()) {
    throw new CommandFailure("INVALID_WORKSPACE", "The active agent workspace is not a directory");
  }

  let cursor = root;
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment);
    if (!pathIsInside(root, cursor)) {
      throw new CommandFailure("WORKSPACE_ESCAPE_FORBIDDEN", `${label} escapes the active workspace`);
    }
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) {
      throw new CommandFailure("SYMLINK_FORBIDDEN", `${label} contains a symbolic-link component`);
    }
    const final = index === segments.length - 1;
    if (!final && !metadata.isDirectory()) {
      throw new CommandFailure("INVALID_WORKSPACE_PATH", `${label} contains a non-directory component`);
    }
    if (final && expectedKind === "file" && (!metadata.isFile() || metadata.nlink !== 1)) {
      throw new CommandFailure("INVALID_REQUEST_FILE", `${label} must be one regular, non-linked file`);
    }
    if (final && expectedKind === "directory" && !metadata.isDirectory()) {
      throw new CommandFailure("INVALID_DOSSIER_DIRECTORY", `${label} must be a directory`);
    }
  }

  const canonical = await realpath(cursor);
  if (!pathIsInside(root, canonical) || canonical !== cursor) {
    throw new CommandFailure("WORKSPACE_ESCAPE_FORBIDDEN", `${label} does not resolve canonically inside the workspace`);
  }
  return { root, relativePath: segments.join("/"), absolutePath: canonical };
}

function exactRequestShape(value: unknown): value is VerificationRequest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...REQUEST_KEYS].sort();
  return (
    keys.length === expected.length
    && keys.every((key, index) => key === expected[index])
    && record.schemaVersion === REQUEST_SCHEMA_VERSION
    && typeof record.dossier === "string"
    && typeof record.audience === "string"
    && typeof record.nonce === "string"
    && typeof record.audienceSource === "string"
    && typeof record.nonceSource === "string"
  );
}

async function inspectRequestFile(
  workspace: string,
  requestInput: string,
): Promise<{ root: string; requestPath: string; dossierPath: string }> {
  const request = await resolveConfinedPath(workspace, requestInput, "request path", "file");
  const handle = await open(request.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > MAX_REQUEST_BYTES) {
      throw new CommandFailure("INVALID_REQUEST_FILE", "The request file is not a bounded regular file");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_REQUEST_BYTES) {
      throw new CommandFailure("INVALID_REQUEST_FILE", "The request file has an invalid byte length");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new CommandFailure("INVALID_VERIFICATION_REQUEST", "The request file is not valid JSON");
    }
    if (!exactRequestShape(parsed)) {
      throw new CommandFailure("INVALID_VERIFICATION_REQUEST", "The request has unsupported or missing fields");
    }
    const dossier = await resolveConfinedPath(request.root, parsed.dossier, "dossier path", "directory");
    return {
      root: request.root,
      requestPath: request.relativePath,
      dossierPath: dossier.relativePath,
    };
  } finally {
    await handle.close();
  }
}

function executeVerifier(cwd: string, requestPath: string): Promise<string> {
  return new Promise((resolveOutput, rejectOutput) => {
    execFile(
      process.execPath,
      [
        launcherPath,
        "verify-request",
        "--request",
        requestPath,
        "--json",
      ],
      {
        cwd,
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        const output = String(stdout).trim();
        if (output.length > 0) {
          try {
            resolveOutput(JSON.stringify(JSON.parse(output), null, 2));
            return;
          } catch {
            rejectOutput(new CommandFailure("INVALID_RUNTIME_OUTPUT", "The bundled verifier returned non-JSON output"));
            return;
          }
        }
        if (error) {
          rejectOutput(new CommandFailure("VERIFIER_EXECUTION_FAILED", "The bundled verifier did not return a result"));
          return;
        }
        rejectOutput(new CommandFailure("EMPTY_RUNTIME_OUTPUT", "The bundled verifier returned no result"));
      },
    );
  });
}

async function handleCheck(
  api: OpenClawPluginApi,
  ctx: PluginCommandContext,
): Promise<PluginCommandResult> {
  try {
    const requestPath = ctx.args?.trim() ?? "";
    if (requestPath.length === 0) {
      return failure(
        "INPUT_REQUIRED",
        "Usage: /evaldossier-check <relative-workspace-request.json>",
      );
    }
    if (!ctx.agentId) {
      return failure("ACTIVE_AGENT_REQUIRED", "OpenClaw did not identify the active agent workspace");
    }
    const workspace = api.runtime.agent.resolveAgentWorkspaceDir(ctx.config, ctx.agentId);
    const inspected = await inspectRequestFile(workspace, requestPath);
    const text = await executeVerifier(inspected.root, inspected.requestPath);
    return { text };
  } catch (error) {
    if (error instanceof CommandFailure) {
      return failure(error.code, error.message);
    }
    return failure("PLUGIN_FAILURE", "The native verifier failed closed");
  }
}

export default function register(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "evaldossier-check",
    description: "Check a signed EvalDossier request locally without invoking an LLM.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => handleCheck(api, ctx),
  });
}
