import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { canonicalize } from "json-canonicalize";

import type { Digest, JsonObject, JsonValue } from "./types.js";

export const DEFAULT_MAX_HASH_FILE_BYTES = 5 * 1024 * 1024;
const MAX_CANONICAL_DEPTH = 128;

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

function assertUnicodeScalarString(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new CanonicalizationError(`unpaired high surrogate at ${path}`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CanonicalizationError(`unpaired low surrogate at ${path}`);
    }
  }
}

function assertCanonicalizable(
  value: unknown,
  path: string,
  depth: number,
  ancestors: Set<object>,
): asserts value is JsonValue {
  if (depth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalizationError(`nesting exceeds ${MAX_CANONICAL_DEPTH} levels at ${path}`);
  }

  if (value === null || typeof value === "boolean") {
    return;
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value, path);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(`non-finite number at ${path}`);
    }
    if (Object.is(value, -0)) {
      throw new CanonicalizationError(`negative zero is not accepted at ${path}`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new CanonicalizationError(`unsafe integer at ${path}`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new CanonicalizationError(`unsupported ${typeof value} value at ${path}`);
  }
  if (ancestors.has(value)) {
    throw new CanonicalizationError(`cyclic reference at ${path}`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownNames = Object.getOwnPropertyNames(value);
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          throw new CanonicalizationError(`sparse array entry at ${path}/${index}`);
        }
        if (!("value" in descriptor)) {
          throw new CanonicalizationError(`accessor array entry at ${path}/${index}`);
        }
        assertCanonicalizable(descriptor.value, `${path}/${index}`, depth + 1, ancestors);
      }
      const unexpected = ownNames.filter(
        (name) => name !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(name),
      );
      if (unexpected.length > 0 || Object.getOwnPropertySymbols(value).length > 0) {
        throw new CanonicalizationError(`array has non-JSON properties at ${path}`);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalizationError(`non-plain object at ${path}`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new CanonicalizationError(`symbol-keyed property at ${path}`);
    }

    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      assertUnicodeScalarString(key, `${path}/<key>`);
      if (!descriptor.enumerable) {
        throw new CanonicalizationError(`non-enumerable property ${JSON.stringify(key)} at ${path}`);
      }
      if (!("value" in descriptor)) {
        throw new CanonicalizationError(`accessor property ${JSON.stringify(key)} at ${path}`);
      }
      assertCanonicalizable(
        descriptor.value,
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        depth + 1,
        ancestors,
      );
    }
  } finally {
    ancestors.delete(value);
  }
}

/** RFC 8785/JCS canonical JSON. */
export function canonicalString(value: unknown): string {
  assertCanonicalizable(value, "$", 0, new Set<object>());
  const result = canonicalize(value);
  if (typeof result !== "string") {
    throw new CanonicalizationError("canonicalizer did not return a string");
  }
  return result;
}

export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalString(value), "utf8");
}

export function sha256Bytes(input: Uint8Array | string): Digest {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return {
    algorithm: "sha-256",
    value: createHash("sha256").update(bytes).digest("hex"),
  };
}

export async function sha256File(
  filePath: string,
  maxBytes = DEFAULT_MAX_HASH_FILE_BYTES,
): Promise<Digest> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError("maxBytes must be a positive safe integer");
  }
  const metadata = await stat(filePath);
  if (!metadata.isFile()) {
    throw new Error(`${filePath}: path is not a regular file`);
  }
  if (metadata.size > maxBytes) {
    throw new Error(`${filePath}: file is ${metadata.size} bytes; limit is ${maxBytes}`);
  }
  const bytes = await readFile(filePath);
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${filePath}: file grew beyond the ${maxBytes}-byte limit while being read`);
  }
  return sha256Bytes(bytes);
}

/** Hash a complete JSON object as JCS bytes. Callers choose whether proof is present. */
export function digestOfObject(value: unknown): Digest {
  return sha256Bytes(canonicalBytes(value));
}

export function digestEquals(left: Digest, right: Digest): boolean {
  if (left.algorithm !== "sha-256" || right.algorithm !== "sha-256") {
    return false;
  }
  if (!/^[a-f0-9]{64}$/.test(left.value) || !/^[a-f0-9]{64}$/.test(right.value)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left.value, "hex"), Buffer.from(right.value, "hex"));
}

export function withoutProof(value: JsonObject): JsonObject {
  const result: JsonObject = Object.create(null) as JsonObject;
  for (const [key, member] of Object.entries(value)) {
    if (key !== "proof") {
      result[key] = member;
    }
  }
  return result;
}

/** Compatibility aliases used by early evaluator code. */
export const sha256Digest = sha256Bytes;
export const digestJson = digestOfObject;
