#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyDossier } from "./dossier.js";
import { runDemo } from "./demo.js";
import { renderVerificationSummary } from "./report.js";

const HELP = `EvalDossier SDK 0.2.0 — protocol 0.1 — offline evaluation dossiers

Usage:
  evaldossier demo [--out <directory>]
  evaldossier verify <dossier-directory> [--audience <value>] [--nonce <value>] [--json]
  evaldossier help

The CLI performs no network requests and never executes an economic action.`;

function valueAfter(args: string[], option: string): string | undefined {
  if (args.filter((argument) => argument === option).length > 1) {
    throw new Error(`${option} may be supplied only once`);
  }
  const index = args.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function positionalArguments(args: string[], optionsWithValues: Set<string>): string[] {
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("--")) {
      positional.push(argument);
    }
  }
  return positional;
}

function assertKnownOptions(args: string[], allowed: Set<string>): void {
  for (const argument of args) {
    if (argument.startsWith("--") && !allowed.has(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
}

async function demoCommand(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--out"]));
  const output = valueAfter(args, "--out") ?? "demo-output";
  const result = await runDemo(resolve(output));
  process.stdout.write(
    [
      `Demo dossiers written to ${result.outputRoot}`,
      "",
      "Formal reference dossier:",
      renderVerificationSummary(result.formal),
      "",
      "Synthetic model-judgment dossier:",
      renderVerificationSummary(result.modelJudgment),
      "",
    ].join("\n"),
  );
  return 0;
}

async function verifyCommand(args: string[]): Promise<number> {
  assertKnownOptions(args, new Set(["--json", "--audience", "--nonce"]));
  const expectedAudience = valueAfter(args, "--audience");
  const expectedDossierNonce = valueAfter(args, "--nonce");
  const positional = positionalArguments(args, new Set(["--audience", "--nonce"]));
  if (positional.length !== 1) {
    throw new Error("verify requires exactly one dossier directory");
  }
  const verified = await verifyDossier(resolve(positional[0] as string), {
    ...(expectedAudience === undefined ? {} : { expectedAudience }),
    ...(expectedDossierNonce === undefined ? {} : { expectedDossierNonce }),
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(verified.summary, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderVerificationSummary(verified.summary)}\n`);
  }
  return 0;
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "demo":
      return demoCommand(rest);
    case "verify":
      return verifyCommand(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${HELP}\n`);
      return 0;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

function isDirectInvocation(invokedPath: string | undefined): boolean {
  if (invokedPath === undefined) {
    return false;
  }
  try {
    return import.meta.url === pathToFileURL(realpathSync(invokedPath)).href;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`EvalDossier error: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
