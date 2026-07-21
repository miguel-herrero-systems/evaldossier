import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export const DEFAULT_MAX_DOSSIER_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_MAX_DOSSIER_PATH_BYTES = 200;

export class UnsafeDossierPathError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "UnsafeDossierPathError";
    this.code = code;
  }
}

export interface ResolveSafeDossierPathOptions {
  maxBytes?: number;
  maxPathBytes?: number;
  requireRegularFile?: boolean;
}

function assertPositiveLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function validateRelativeDossierPath(relativePath: string, maxPathBytes: number): string[] {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new UnsafeDossierPathError("EMPTY_PATH", "dossier path must be a non-empty string");
  }
  if (Buffer.byteLength(relativePath, "utf8") > maxPathBytes) {
    throw new UnsafeDossierPathError(
      "PATH_TOO_LONG",
      `dossier path exceeds the ${maxPathBytes}-byte limit`,
    );
  }
  if (relativePath.includes("\0")) {
    throw new UnsafeDossierPathError("NUL_BYTE", "dossier path contains a NUL byte");
  }
  if (relativePath.includes("\\")) {
    throw new UnsafeDossierPathError("BACKSLASH", "dossier paths must use forward slashes");
  }
  if (isAbsolute(relativePath) || win32.isAbsolute(relativePath)) {
    throw new UnsafeDossierPathError("ABSOLUTE_PATH", "absolute dossier paths are forbidden");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(relativePath)) {
    throw new UnsafeDossierPathError(
      "UNSAFE_CHARACTER",
      "dossier path contains a character outside [A-Za-z0-9._/-]",
    );
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new UnsafeDossierPathError(
      "UNSAFE_SEGMENT",
      "empty, current-directory and parent-directory path segments are forbidden",
    );
  }
  return segments;
}

/**
 * Resolve an existing dossier file while rejecting traversal and every symlink
 * component. This function performs no URL or network resolution.
 */
export async function resolveSafeDossierPath(
  dossierRoot: string,
  relativePath: string,
  options: ResolveSafeDossierPathOptions = {},
): Promise<string> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOSSIER_FILE_BYTES;
  const maxPathBytes = options.maxPathBytes ?? DEFAULT_MAX_DOSSIER_PATH_BYTES;
  const requireRegularFile = options.requireRegularFile ?? true;
  assertPositiveLimit(maxBytes, "maxBytes");
  assertPositiveLimit(maxPathBytes, "maxPathBytes");
  const segments = validateRelativeDossierPath(relativePath, maxPathBytes);

  const lexicalRoot = resolve(dossierRoot);
  const rootMetadata = await lstat(lexicalRoot);
  if (rootMetadata.isSymbolicLink()) {
    throw new UnsafeDossierPathError("SYMLINK_ROOT", "dossier root must not be a symbolic link");
  }
  if (!rootMetadata.isDirectory()) {
    throw new UnsafeDossierPathError("INVALID_ROOT", "dossier root is not a directory");
  }
  const canonicalRoot = await realpath(lexicalRoot);
  const candidate = resolve(canonicalRoot, ...segments);
  if (!pathIsWithin(canonicalRoot, candidate)) {
    throw new UnsafeDossierPathError("PATH_ESCAPE", "dossier path escapes its root");
  }

  let cursor = canonicalRoot;
  for (const [index, segment] of segments.entries()) {
    cursor = resolve(cursor, segment);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) {
      throw new UnsafeDossierPathError(
        "SYMLINK_COMPONENT",
        `symbolic link is forbidden at path segment ${index + 1}`,
      );
    }
    const final = index === segments.length - 1;
    if (!final && !metadata.isDirectory()) {
      throw new UnsafeDossierPathError(
        "NON_DIRECTORY_COMPONENT",
        `path segment ${index + 1} is not a directory`,
      );
    }
    if (final && requireRegularFile && !metadata.isFile()) {
      throw new UnsafeDossierPathError("NOT_REGULAR_FILE", "dossier artifact is not a regular file");
    }
    if (final && metadata.isFile() && metadata.nlink !== 1) {
      throw new UnsafeDossierPathError("HARDLINK", "hard-linked dossier artifacts are forbidden");
    }
    if (final && metadata.size > maxBytes) {
      throw new UnsafeDossierPathError(
        "FILE_TOO_LARGE",
        `dossier artifact is ${metadata.size} bytes; limit is ${maxBytes}`,
      );
    }
  }

  const canonicalCandidate = await realpath(candidate);
  if (!pathIsWithin(canonicalRoot, canonicalCandidate)) {
    throw new UnsafeDossierPathError("PATH_ESCAPE", "resolved dossier path escapes its root");
  }
  if (canonicalCandidate !== candidate) {
    throw new UnsafeDossierPathError(
      "NON_CANONICAL_PATH",
      "dossier path does not resolve to the exact confined path",
    );
  }
  return canonicalCandidate;
}

export interface ReadSafeDossierFileOptions extends ResolveSafeDossierPathOptions {}

/** Read a confined regular file, with a no-follow final open and size cap. */
export async function readSafeDossierFile(
  dossierRoot: string,
  relativePath: string,
  options: ReadSafeDossierFileOptions = {},
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_DOSSIER_FILE_BYTES;
  const safePath = await resolveSafeDossierPath(dossierRoot, relativePath, {
    ...options,
    maxBytes,
    requireRegularFile: true,
  });

  let handle;
  try {
    handle = await open(safePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new UnsafeDossierPathError("NOT_REGULAR_FILE", "opened artifact is not a regular file");
    }
    if (before.nlink !== 1) {
      throw new UnsafeDossierPathError("HARDLINK", "hard-linked dossier artifacts are forbidden");
    }
    if (before.size > maxBytes) {
      throw new UnsafeDossierPathError(
        "FILE_TOO_LARGE",
        `opened artifact is ${before.size} bytes; limit is ${maxBytes}`,
      );
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > maxBytes) {
      throw new UnsafeDossierPathError(
        "FILE_TOO_LARGE",
        `artifact grew beyond the ${maxBytes}-byte limit while being read`,
      );
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}
