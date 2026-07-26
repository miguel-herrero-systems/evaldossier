#!/usr/bin/env node

import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultRoots = [
  join(projectRoot, "plugins", "evaldossier"),
  join(projectRoot, "claude-plugins", "evaldossier"),
  join(projectRoot, "openclaw-plugins", "evaldossier"),
];
const privateFilenamePattern = /(?:^|[._-])private(?:[._-]|$)/iu;
const privatePemPattern =
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/u;

function displayPath(root, path) {
  return relative(root, path).split("\\").join("/");
}

async function listRegularFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === "node_modules") {
        continue;
      }
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        throw new Error(`symbolic link is forbidden in plugin payload: ${displayPath(root, path)}`);
      }
      if (metadata.isDirectory()) {
        await walk(path);
      } else if (metadata.isFile()) {
        files.push(path);
      } else {
        throw new Error(`unsupported payload entry: ${displayPath(root, path)}`);
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

function findPrivateJwk(value, pointer = "$") {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findPrivateJwk(item, `${pointer}[${index}]`);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
  if (
    typeof value.kty === "string" &&
    Object.prototype.hasOwnProperty.call(value, "d")
  ) {
    return pointer;
  }
  for (const [key, item] of Object.entries(value)) {
    const found = findPrivateJwk(item, `${pointer}.${key}`);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

async function checkRoot(rootInput) {
  const root = resolve(rootInput);
  for (const path of await listRegularFiles(root)) {
    const relativePath = displayPath(root, path);
    if (privateFilenamePattern.test(basename(path))) {
      throw new Error(`private-key filename is forbidden in plugin payload: ${relativePath}`);
    }
    const bytes = await readFile(path);
    if (bytes.includes(0)) {
      continue;
    }
    const text = bytes.toString("utf8");
    if (privatePemPattern.test(text)) {
      throw new Error(`private PEM material is forbidden in plugin payload: ${relativePath}`);
    }
    if (extname(path).toLowerCase() !== ".json") {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`invalid JSON in plugin payload: ${relativePath}`);
    }
    const pointer = findPrivateJwk(parsed);
    if (pointer !== undefined) {
      throw new Error(
        `private JWK member d is forbidden in plugin payload: ${relativePath} at ${pointer}`,
      );
    }
  }
}

const roots = process.argv.slice(2);
for (const root of roots.length === 0 ? defaultRoots : roots) {
  await checkRoot(root);
}
process.stdout.write(
  `Agent plugin secret guard passed for ${roots.length === 0 ? defaultRoots.length : roots.length} payload root(s).\n`,
);
