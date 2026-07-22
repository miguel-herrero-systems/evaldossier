import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import {
  parseTree,
  type Node as JsonSyntaxNode,
} from "jsonc-parser";

import type { JsonValue } from "./types.js";

export const DEFAULT_MAX_JSON_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_JSON_DEPTH = 128;

const MAX_DIAGNOSTIC_LABEL_CHARS = 160;
const MAX_DIAGNOSTIC_BODY_CHARS = 768;
const MAX_DIAGNOSTIC_PATH_CHARS = 512;
const MAX_DIAGNOSTIC_KEY_CHARS = 96;

function diagnosticDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function boundDiagnosticText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  const suffix = `...[sha256:${diagnosticDigest(value)};chars:${value.length}]`;
  return `${value.slice(0, Math.max(0, maxChars - suffix.length))}${suffix}`;
}

function diagnosticObjectSegment(key: string): string {
  if (key.length <= MAX_DIAGNOSTIC_KEY_CHARS) {
    // JSON quoting keeps control characters inert in logs and terminal output.
    return `[${JSON.stringify(key)}]`;
  }
  return `[key-sha256:${diagnosticDigest(key)};chars:${key.length}]`;
}

function appendDiagnosticPath(path: string, segment: string): string {
  return boundDiagnosticText(`${path}${segment}`, MAX_DIAGNOSTIC_PATH_CHARS);
}

function diagnosticKey(key: string): string {
  return key.length <= MAX_DIAGNOSTIC_KEY_CHARS
    ? JSON.stringify(key)
    : `<sha256:${diagnosticDigest(key)};chars:${key.length}>`;
}

export class StrictJsonError extends Error {
  readonly code: string;
  readonly sourceLabel: string;
  readonly offset: number | undefined;

  constructor(code: string, message: string, sourceLabel = "JSON input", offset?: number) {
    super(
      `${boundDiagnosticText(sourceLabel, MAX_DIAGNOSTIC_LABEL_CHARS)}: ${boundDiagnosticText(
        message,
        MAX_DIAGNOSTIC_BODY_CHARS,
      )}`,
    );
    this.name = "StrictJsonError";
    this.code = code;
    this.sourceLabel = boundDiagnosticText(sourceLabel, MAX_DIAGNOSTIC_LABEL_CHARS);
    this.offset = offset;
  }
}

function decodeUtf8Strict(input: Uint8Array, sourceLabel: string): string {
  if (input.byteLength >= 3 && input[0] === 0xef && input[1] === 0xbb && input[2] === 0xbf) {
    throw new StrictJsonError("UNEXPECTED_BOM", "a UTF-8 BOM is not accepted", sourceLabel, 0);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(input);
  } catch (error) {
    throw new StrictJsonError(
      "INVALID_UTF8",
      `input is not valid UTF-8 (${error instanceof Error ? error.message : "decode failed"})`,
      sourceLabel,
    );
  }
}

function locationSuffix(text: string, offset: number): string {
  const boundedOffset = Math.min(text.length, Math.max(0, offset));
  let line = 1;
  let lastLineBreak = -1;
  for (let index = 0; index < boundedOffset; index += 1) {
    if (text.charCodeAt(index) === 0x0a) {
      line += 1;
      lastLineBreak = index;
    }
  }
  return ` at line ${line}, column ${boundedOffset - lastLineBreak}`;
}

function assertNoDuplicateKeys(
  node: JsonSyntaxNode,
  text: string,
  sourceLabel: string,
  path: string,
  depth: number,
): void {
  if (depth > DEFAULT_MAX_JSON_DEPTH) {
    throw new StrictJsonError(
      "MAX_DEPTH_EXCEEDED",
      `nesting exceeds ${DEFAULT_MAX_JSON_DEPTH} levels at ${path}`,
      sourceLabel,
      node.offset,
    );
  }

  if (node.type === "object") {
    const seen = new Map<string, number>();
    for (const property of node.children ?? []) {
      const keyNode = property.children?.[0];
      const valueNode = property.children?.[1];
      if (keyNode === undefined || typeof keyNode.value !== "string" || valueNode === undefined) {
        throw new StrictJsonError(
          "MALFORMED_OBJECT",
          `malformed object member at ${path}`,
          sourceLabel,
          property.offset,
        );
      }

      const key = keyNode.value;
      const firstOffset = seen.get(key);
      if (firstOffset !== undefined) {
        throw new StrictJsonError(
          "DUPLICATE_KEY",
          `duplicate key ${diagnosticKey(key)} at ${path}${locationSuffix(text, keyNode.offset)}; first occurrence at offset ${firstOffset}`,
          sourceLabel,
          keyNode.offset,
        );
      }
      seen.set(key, keyNode.offset);
      assertNoDuplicateKeys(
        valueNode,
        text,
        sourceLabel,
        appendDiagnosticPath(path, diagnosticObjectSegment(key)),
        depth + 1,
      );
    }
    return;
  }

  if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries()) {
      assertNoDuplicateKeys(
        child,
        text,
        sourceLabel,
        appendDiagnosticPath(path, `[${index}]`),
        depth + 1,
      );
    }
  }
}

function assertUnicodeScalarString(value: string, sourceLabel: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new StrictJsonError(
          "INVALID_UNICODE_SCALAR",
          `unpaired high surrogate at ${path}`,
          sourceLabel,
        );
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new StrictJsonError(
        "INVALID_UNICODE_SCALAR",
        `unpaired low surrogate at ${path}`,
        sourceLabel,
      );
    }
  }
}

function assertUnicodeScalars(value: JsonValue, sourceLabel: string, path = "$"): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new StrictJsonError(
        "NON_FINITE_NUMBER",
        `non-finite number is not accepted at ${path}`,
        sourceLabel,
      );
    }
    if (Object.is(value, -0)) {
      throw new StrictJsonError("NEGATIVE_ZERO", `negative zero is not accepted at ${path}`, sourceLabel);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new StrictJsonError(
        "UNSAFE_INTEGER",
        `integer is outside the interoperable safe range at ${path}`,
        sourceLabel,
      );
    }
    return;
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value, sourceLabel, path);
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertUnicodeScalars(item, sourceLabel, appendDiagnosticPath(path, `[${index}]`));
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertUnicodeScalarString(key, sourceLabel, `${path}/<key>`);
      assertUnicodeScalars(
        item,
        sourceLabel,
        appendDiagnosticPath(path, diagnosticObjectSegment(key)),
      );
    }
  }
}

/**
 * Parse JSON without comments, trailing commas, duplicate keys, invalid UTF-8 or
 * unpaired Unicode surrogates. Byte input is preferred at trust boundaries.
 */
export function parseJsonStrict<T extends JsonValue = JsonValue>(
  input: Uint8Array | string,
  sourceLabel = "JSON input",
): T {
  const text = typeof input === "string" ? input : decodeUtf8Strict(input, sourceLabel);
  if (text.startsWith("\ufeff")) {
    throw new StrictJsonError("UNEXPECTED_BOM", "a UTF-8 BOM is not accepted", sourceLabel, 0);
  }

  // Use the native parser as a fail-fast syntax admission gate. In particular,
  // do not ask jsonc-parser to recover from and collect every error in an
  // attacker-controlled document: dense malformed input can otherwise create
  // work and diagnostics proportional to the number of recoverable errors.
  // The engine diagnostic is deliberately not reflected across this boundary.
  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch {
    throw new StrictJsonError("INVALID_JSON", "invalid JSON document", sourceLabel);
  }

  // JSON.parse has already established strict JSON syntax (and rejects comments
  // and trailing commas). Build a syntax tree only for invariants that the
  // native parser does not expose, chiefly duplicate object member detection.
  // No attacker-controlled malformed document reaches this stage, and no
  // parser recovery diagnostics are exposed or rendered by this boundary.
  const root = parseTree(text, undefined, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (root === undefined) {
    // Defensive disagreement guard. Keep the diagnostic fixed and bounded.
    throw new StrictJsonError("INVALID_JSON", "invalid JSON document", sourceLabel);
  }

  assertNoDuplicateKeys(root, text, sourceLabel, "$", 0);
  assertUnicodeScalars(value, sourceLabel);
  return value as T;
}

export interface ParseJsonFileOptions {
  maxBytes?: number;
  label?: string;
}

export async function parseJsonFileStrict<T extends JsonValue = JsonValue>(
  filePath: string,
  options: ParseJsonFileOptions = {},
): Promise<T> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }

  const metadata = await stat(filePath);
  if (!metadata.isFile()) {
    throw new StrictJsonError("NOT_A_FILE", "path is not a regular file", options.label ?? filePath);
  }
  if (metadata.size > maxBytes) {
    throw new StrictJsonError(
      "FILE_TOO_LARGE",
      `file is ${metadata.size} bytes; limit is ${maxBytes}`,
      options.label ?? filePath,
    );
  }

  const bytes = await readFile(filePath);
  if (bytes.byteLength > maxBytes) {
    throw new StrictJsonError(
      "FILE_TOO_LARGE",
      `file grew beyond the ${maxBytes}-byte limit while being read`,
      options.label ?? filePath,
    );
  }
  return parseJsonStrict<T>(bytes, options.label ?? filePath);
}

/** Compatibility alias for evaluator and test code. */
export const parseStrictJsonBytes = parseJsonStrict;
