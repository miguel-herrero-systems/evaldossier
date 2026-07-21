import { readFile, stat } from "node:fs/promises";
import {
  parseTree,
  printParseErrorCode,
  type Node as JsonSyntaxNode,
  type ParseError,
} from "jsonc-parser";

import type { JsonValue } from "./types.js";

export const DEFAULT_MAX_JSON_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_JSON_DEPTH = 128;

export class StrictJsonError extends Error {
  readonly code: string;
  readonly sourceLabel: string;
  readonly offset: number | undefined;

  constructor(code: string, message: string, sourceLabel = "JSON input", offset?: number) {
    super(`${sourceLabel}: ${message}`);
    this.name = "StrictJsonError";
    this.code = code;
    this.sourceLabel = sourceLabel;
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
  const before = text.slice(0, Math.max(0, offset));
  const lines = before.split("\n");
  return ` at line ${lines.length}, column ${(lines.at(-1)?.length ?? 0) + 1}`;
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
          `duplicate key ${JSON.stringify(key)} at ${path}${locationSuffix(text, keyNode.offset)}; first occurrence at offset ${firstOffset}`,
          sourceLabel,
          keyNode.offset,
        );
      }
      seen.set(key, keyNode.offset);
      assertNoDuplicateKeys(valueNode, text, sourceLabel, `${path}/${escapeJsonPointer(key)}`, depth + 1);
    }
    return;
  }

  if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries()) {
      assertNoDuplicateKeys(child, text, sourceLabel, `${path}/${index}`, depth + 1);
    }
  }
}

function escapeJsonPointer(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
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
      assertUnicodeScalars(item, sourceLabel, `${path}/${index}`);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertUnicodeScalarString(key, sourceLabel, `${path}/<key>`);
      assertUnicodeScalars(item, sourceLabel, `${path}/${escapeJsonPointer(key)}`);
    }
  }
}

function describeParseErrors(errors: ParseError[], text: string): string {
  return errors
    .map((error) => `${printParseErrorCode(error.error)}${locationSuffix(text, error.offset)}`)
    .join(", ");
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

  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    allowEmptyContent: false,
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (root === undefined || errors.length > 0) {
    throw new StrictJsonError(
      "INVALID_JSON",
      errors.length > 0 ? describeParseErrors(errors, text) : "empty or invalid JSON document",
      sourceLabel,
      errors[0]?.offset,
    );
  }

  assertNoDuplicateKeys(root, text, sourceLabel, "$", 0);

  let value: JsonValue;
  try {
    value = JSON.parse(text) as JsonValue;
  } catch (error) {
    throw new StrictJsonError(
      "INVALID_JSON",
      error instanceof Error ? error.message : "JSON.parse failed",
      sourceLabel,
    );
  }
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
