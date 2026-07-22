#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const pluginRoots = Object.freeze([
  join(projectRoot, "plugins", "evaldossier"),
  join(projectRoot, "claude-plugins", "evaldossier"),
]);
const commonTopLevelPaths = Object.freeze(["LICENSE", "fixtures", "runtime", "schemas"]);
const schemaNames = Object.freeze([
  "common.schema.json",
  "dossier.schema.json",
  "evaluation-attestation.schema.json",
  "evaluation-request.schema.json",
  "evaluator-manifest.schema.json",
  "evidence-bundle.schema.json",
  "profile-definition.schema.json",
]);
const fixtureFiles = Object.freeze([
  "fixtures/keys/exporter.private.jwk.json",
  "fixtures/keys/reference-evaluator.private.jwk.json",
  "fixtures/keys/requester.private.jwk.json",
  "fixtures/reference/deliverable.json",
  "fixtures/reference/deliverable.schema.json",
]);
const bundledDependencies = Object.freeze([
  { name: "ajv", licenseFile: "LICENSE" },
  { name: "ajv-formats", licenseFile: "LICENSE" },
  { name: "fast-deep-equal", licenseFile: "LICENSE" },
  { name: "fast-uri", licenseFile: "LICENSE" },
  { name: "json-canonicalize", licenseFile: "LICENSE.md" },
  { name: "json-schema-traverse", licenseFile: "LICENSE" },
  { name: "jsonc-parser", licenseFile: "LICENSE.md" },
  { name: "require-from-string", licenseFile: "license" },
]);

function toPosix(value) {
  return value.split(sep).join("/");
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertConfinedRegularFile(path, confinementRoot = projectRoot) {
  const lexicalConfinementRoot = resolve(confinementRoot);
  const lexicalPath = resolve(path);
  if (!pathIsWithin(lexicalConfinementRoot, lexicalPath)) {
    throw new Error(`Refusing build input outside its confinement: ${path}`);
  }

  const rootMetadata = await lstat(lexicalConfinementRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`Build-input confinement root must be a real directory: ${confinementRoot}`);
  }
  const canonicalConfinementRoot = await realpath(lexicalConfinementRoot);
  const relativePath = relative(lexicalConfinementRoot, lexicalPath);
  let cursor = lexicalConfinementRoot;
  const traversed = [];
  const segments = relativePath.split(sep);
  for (const [index, segment] of segments.entries()) {
    traversed.push(segment);
    cursor = join(cursor, segment);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing build input with a symbolic-link component: ${cursor}`);
    }
    const final = index === segments.length - 1;
    if (!final && !metadata.isDirectory()) {
      throw new Error(`Build input has a non-directory ancestor: ${cursor}`);
    }
    if (final && (!metadata.isFile() || metadata.nlink !== 1)) {
      throw new Error(`Refusing non-regular build input: ${cursor}`);
    }
    const canonicalCursor = await realpath(cursor);
    const expectedCursor = resolve(canonicalConfinementRoot, ...traversed);
    if (canonicalCursor !== expectedCursor) {
      throw new Error(`Refusing redirected build input: ${cursor}`);
    }
  }
}

const packageJsonPath = join(projectRoot, "package.json");
const packageLockPath = join(projectRoot, "package-lock.json");
await Promise.all([
  assertConfinedRegularFile(packageJsonPath),
  assertConfinedRegularFile(packageLockPath),
]);
const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
const packageLock = JSON.parse(await readFile(packageLockPath, "utf8"));

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function copyRegularFile(source, destination) {
  await assertConfinedRegularFile(source);
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { force: true, preserveTimestamps: false });
}

async function copyNormalizedLicenseText(source, destination) {
  await assertConfinedRegularFile(source);
  const text = await readFile(source, "utf8");
  const normalized = `${text
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+$/gmu, "")
    .replace(/\n*$/u, "")}\n`;
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, normalized, "utf8");
}

async function listRegularFiles(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Generated payload contains a symbolic link: ${path}`);
      }
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const metadata = await lstat(path);
        if (metadata.nlink !== 1) {
          throw new Error(`Generated payload contains a hard-linked file: ${path}`);
        }
        files.push(path);
      } else {
        throw new Error(`Generated payload contains an unsupported entry: ${path}`);
      }
    }
  }
  await walk(root);
  return files.sort((left, right) => left.localeCompare(right, "en"));
}

async function fileInventory(root, { excludeManifest = false } = {}) {
  const inventory = [];
  for (const path of await listRegularFiles(root)) {
    const relativePath = toPosix(relative(root, path));
    if (excludeManifest && relativePath === "runtime/BUNDLE_MANIFEST.json") {
      continue;
    }
    const bytes = await readFile(path);
    inventory.push({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  return inventory;
}

function installedPackage(name) {
  const record = packageLock.packages?.[`node_modules/${name}`];
  if (record === undefined || typeof record.version !== "string") {
    throw new Error(`package-lock.json does not pin ${name}`);
  }
  return record;
}

async function writeThirdPartyMaterials(payloadRoot) {
  const dependencies = [];
  const noticeLines = [
    "# Third-party notices",
    "",
    "The generated EvalDossier runtime bundle incorporates the packages below.",
    "Their license texts are included in `runtime/third-party-licenses/`.",
    "",
    "| Package | Version | License |",
    "|---|---:|---|",
  ];

  for (const dependency of bundledDependencies) {
    const record = installedPackage(dependency.name);
    const license = typeof record.license === "string" ? record.license : "SEE INCLUDED TEXT";
    const source = join(projectRoot, "node_modules", dependency.name, dependency.licenseFile);
    const destinationName = `${dependency.name.replaceAll("/", "__")}.txt`;
    const destination = join(
      payloadRoot,
      "runtime",
      "third-party-licenses",
      destinationName,
    );
    await copyNormalizedLicenseText(source, destination);
    dependencies.push({
      name: dependency.name,
      version: record.version,
      license,
      licenseFile: `runtime/third-party-licenses/${destinationName}`,
    });
    noticeLines.push(`| \`${dependency.name}\` | \`${record.version}\` | ${license} |`);
  }

  noticeLines.push(
    "",
    "These packages are bundled for offline execution. EvalDossier does not install",
    "or resolve packages when an installed agent plugin runs.",
    "",
  );
  await writeFile(
    join(payloadRoot, "runtime", "THIRD_PARTY_NOTICES.md"),
    noticeLines.join("\n"),
    "utf8",
  );
  return dependencies;
}

async function buildPayload(payloadRoot) {
  await mkdir(join(payloadRoot, "runtime", "shared"), { recursive: true });

  const entryPath = join(projectRoot, "integrations", "shared", "evaldossier-local-core.mjs");
  await assertConfinedRegularFile(entryPath);
  const bundlePath = join(
    payloadRoot,
    "runtime",
    "shared",
    "evaldossier-local-core.mjs",
  );
  const buildResult = await build({
    absWorkingDir: projectRoot,
    entryPoints: ["integrations/shared/evaldossier-local-core.mjs"],
    outfile: bundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node20.11"],
    mainFields: ["module", "main"],
    packages: "bundle",
    treeShaking: true,
    minify: false,
    sourcemap: false,
    legalComments: "none",
    charset: "utf8",
    metafile: true,
    logLevel: "silent",
  });

  const externalImports = [
    ...new Set(
      Object.values(buildResult.metafile.outputs)
        .flatMap((output) => output.imports)
        .filter((entry) => entry.external)
        .map((entry) => entry.path),
    ),
  ].sort();
  if (externalImports.some((path) => !path.startsWith("node:"))) {
    throw new Error(`Bundle has a non-Node external import: ${externalImports.join(", ")}`);
  }
  for (const inputPath of Object.keys(buildResult.metafile.inputs)) {
    if (inputPath.startsWith("<")) {
      throw new Error(`Bundle has an unsupported synthetic build input: ${inputPath}`);
    }
    await assertConfinedRegularFile(resolve(projectRoot, inputPath));
  }

  for (const schemaName of schemaNames) {
    await copyRegularFile(
      join(projectRoot, "schemas", schemaName),
      join(payloadRoot, "schemas", schemaName),
    );
  }
  for (const fixtureFile of fixtureFiles) {
    await copyRegularFile(join(projectRoot, fixtureFile), join(payloadRoot, fixtureFile));
  }
  await copyRegularFile(join(projectRoot, "LICENSE"), join(payloadRoot, "LICENSE"));
  const dependencies = await writeThirdPartyMaterials(payloadRoot);
  const assets = await fileInventory(payloadRoot, { excludeManifest: true });
  const esbuildVersion = installedPackage("esbuild").version;
  await writeJson(join(payloadRoot, "runtime", "BUNDLE_MANIFEST.json"), {
    schemaVersion: "evaldossier.agent-plugin-bundle/0.1",
    productVersion: packageJson.version,
    protocolVersion: "0.1",
    nodeTarget: ">=20.11",
    buildTool: {
      name: "esbuild",
      version: esbuildVersion,
    },
    runtimeCodeGeneration: {
      callerSuppliedCode: false,
      evaluatorDiscovery: false,
      committedSchemaCompilation: "AJV_RUNTIME_CODE_GENERATION",
    },
    externalImports,
    bundledDependencies: dependencies,
    assets,
  });
}

async function comparePayloads(left, right) {
  const [leftInventory, rightInventory] = await Promise.all([
    fileInventory(left),
    fileInventory(right),
  ]);
  if (JSON.stringify(leftInventory) !== JSON.stringify(rightInventory)) {
    throw new Error("Two clean agent-plugin payload builds were not byte-identical");
  }
}

async function commonPayloadInventory(pluginRoot) {
  const inventory = [];
  for (const relativePath of commonTopLevelPaths) {
    const absolutePath = join(pluginRoot, relativePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Installed payload contains a symbolic link: ${absolutePath}`);
    }
    if (metadata.isFile()) {
      if (metadata.nlink !== 1) {
        throw new Error(`Installed payload contains a hard-linked file: ${absolutePath}`);
      }
      const bytes = await readFile(absolutePath);
      inventory.push({
        path: toPosix(relativePath),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      });
      continue;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Installed payload contains an unsupported entry: ${absolutePath}`);
    }
    for (const path of await listRegularFiles(absolutePath)) {
      const bytes = await readFile(path);
      inventory.push({
        path: toPosix(join(relativePath, relative(absolutePath, path))),
        bytes: bytes.byteLength,
        sha256: sha256(bytes),
      });
    }
  }
  return inventory.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function inventoryDifference(expected, actual) {
  const expectedByPath = new Map(expected.map((entry) => [entry.path, entry]));
  const actualByPath = new Map(actual.map((entry) => [entry.path, entry]));
  for (const entry of expected) {
    const installed = actualByPath.get(entry.path);
    if (installed === undefined) {
      return `missing ${entry.path}`;
    }
    if (installed.bytes !== entry.bytes || installed.sha256 !== entry.sha256) {
      return `content mismatch at ${entry.path}`;
    }
  }
  for (const entry of actual) {
    if (!expectedByPath.has(entry.path)) {
      return `unexpected ${entry.path}`;
    }
  }
  return undefined;
}

async function compareCandidateToInstalledPayload(payloadRoot, pluginRoot) {
  const [expected, actual] = await Promise.all([
    fileInventory(payloadRoot),
    commonPayloadInventory(pluginRoot),
  ]);
  const difference = inventoryDifference(expected, actual);
  if (difference !== undefined) {
    throw new Error(
      `Installed agent-plugin payload drifted at ${toPosix(relative(projectRoot, pluginRoot))}: ${difference}`,
    );
  }
}

async function compareCandidateToInstalledPayloads(payloadRoot) {
  const failures = [];
  for (const pluginRoot of pluginRoots) {
    try {
      await compareCandidateToInstalledPayload(payloadRoot, pluginRoot);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new Error(`Agent-plugin payload drift detected:\n- ${failures.join("\n- ")}`);
  }
}

function pathIsWithin(root, candidate) {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot !== "" &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(fromRoot)
  );
}

async function assertSafeInstallRoot(pluginRoot, confinementRoot = projectRoot) {
  const lexicalConfinementRoot = resolve(confinementRoot);
  const lexicalPluginRoot = resolve(pluginRoot);
  if (!pathIsWithin(lexicalConfinementRoot, lexicalPluginRoot)) {
    throw new Error(`Refusing agent-plugin install root outside its confinement: ${pluginRoot}`);
  }

  const canonicalConfinementRoot = await realpath(lexicalConfinementRoot);
  const relativePluginRoot = relative(lexicalConfinementRoot, lexicalPluginRoot);
  let cursor = lexicalConfinementRoot;
  const traversed = [];
  for (const segment of relativePluginRoot.split(sep)) {
    traversed.push(segment);
    cursor = join(cursor, segment);
    const metadata = await lstat(cursor);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Refusing symbolic-link agent-plugin install root: ${cursor}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Agent-plugin install root component is not a directory: ${cursor}`);
    }
    const canonicalCursor = await realpath(cursor);
    const expectedCursor = resolve(canonicalConfinementRoot, ...traversed);
    if (canonicalCursor !== expectedCursor) {
      throw new Error(`Refusing redirected agent-plugin install root: ${cursor}`);
    }
  }
}

async function installPayload(payloadRoot, pluginRoot, confinementRoot = projectRoot) {
  await assertSafeInstallRoot(pluginRoot, confinementRoot);
  for (const relativePath of commonTopLevelPaths) {
    const destination = join(pluginRoot, relativePath);
    try {
      const metadata = await lstat(destination);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Refusing symbolic-link payload destination: ${destination}`);
      }
    } catch (error) {
      if (!(error instanceof Error) || !Reflect.has(error, "code") || error.code !== "ENOENT") {
        throw error;
      }
    }
    await rm(destination, { recursive: true, force: true });
    await assertSafeInstallRoot(pluginRoot, confinementRoot);
    await cp(join(payloadRoot, relativePath), destination, {
      recursive: true,
      force: true,
      preserveTimestamps: false,
    });
    await assertSafeInstallRoot(pluginRoot, confinementRoot);
  }
}

async function proveInstallRejectsRedirectedRoot(payloadRoot, temporaryRoot) {
  const regressionRoot = join(temporaryRoot, "install-root-regression");
  const victimRoot = join(regressionRoot, "victim");
  const redirectedPluginRoot = join(regressionRoot, "redirected-plugin");
  const marker = Buffer.from("EVALDOSSIER_INSTALL_ROOT_VICTIM\n", "utf8");
  await mkdir(victimRoot, { recursive: true });
  await writeFile(join(victimRoot, "LICENSE"), marker);
  await symlink(victimRoot, redirectedPluginRoot, "dir");

  let rejected = false;
  try {
    await installPayload(payloadRoot, redirectedPluginRoot, regressionRoot);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("symbolic-link")) {
      throw error;
    }
    rejected = true;
  }
  if (!rejected) {
    throw new Error("Install-root regression failed: redirected plugin root was accepted");
  }
  const markerAfter = await readFile(join(victimRoot, "LICENSE"));
  if (!markerAfter.equals(marker)) {
    throw new Error("Install-root regression failed: redirected victim bytes were modified");
  }
  for (const relativePath of commonTopLevelPaths.filter((path) => path !== "LICENSE")) {
    try {
      await lstat(join(victimRoot, relativePath));
      throw new Error(`Install-root regression failed: redirected victim received ${relativePath}`);
    } catch (error) {
      if (!(error instanceof Error) || !Reflect.has(error, "code") || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function proveBuildInputRejectsRedirectedAncestor(temporaryRoot) {
  const regressionRoot = join(temporaryRoot, "build-input-regression");
  const victimRoot = join(regressionRoot, "victim");
  const redirectedDirectory = join(regressionRoot, "schemas");
  const victimFile = join(victimRoot, "fixture.json");
  await mkdir(victimRoot, { recursive: true });
  await writeFile(victimFile, "{}\n", "utf8");
  await symlink(victimRoot, redirectedDirectory, "dir");

  let rejected = false;
  try {
    await assertConfinedRegularFile(join(redirectedDirectory, "fixture.json"), regressionRoot);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("symbolic-link")) {
      throw error;
    }
    rejected = true;
  }
  if (!rejected) {
    throw new Error("Build-input regression failed: redirected ancestor was accepted");
  }
  if ((await readFile(victimFile, "utf8")) !== "{}\n") {
    throw new Error("Build-input regression failed: redirected source bytes were modified");
  }
}

async function proveDriftCheckIsNonMutating(payloadRoot, temporaryRoot) {
  const simulatedPluginRoot = join(temporaryRoot, "drift-regression-plugin");
  await mkdir(simulatedPluginRoot, { recursive: true });
  for (const relativePath of commonTopLevelPaths) {
    await cp(join(payloadRoot, relativePath), join(simulatedPluginRoot, relativePath), {
      recursive: true,
      force: true,
      preserveTimestamps: false,
    });
  }

  const licensePath = join(simulatedPluginRoot, "LICENSE");
  const driftedBytes = Buffer.concat([
    await readFile(licensePath),
    Buffer.from("\nEVALDOSSIER_DRIFT_REGRESSION_MARKER\n", "utf8"),
  ]);
  await writeFile(licensePath, driftedBytes);

  let rejected = false;
  try {
    await compareCandidateToInstalledPayload(payloadRoot, simulatedPluginRoot);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("content mismatch at LICENSE")) {
      throw error;
    }
    rejected = true;
  }
  if (!rejected) {
    throw new Error("Drift regression failed: altered payload was accepted");
  }
  const afterCheck = await readFile(licensePath);
  if (!afterCheck.equals(driftedBytes)) {
    throw new Error("Drift regression failed: check modified the altered payload");
  }
}

const arguments_ = process.argv.slice(2);
if (arguments_.length > 1 || (arguments_.length === 1 && arguments_[0] !== "--check")) {
  throw new Error("Usage: build-agent-plugins.mjs [--check]");
}
const checkOnly = arguments_[0] === "--check";

const temporaryRoot = await mkdtemp(join(tmpdir(), "evaldossier-agent-plugin-build-"));
try {
  const first = join(temporaryRoot, "first");
  const second = join(temporaryRoot, "second");
  await Promise.all([buildPayload(first), buildPayload(second)]);
  await comparePayloads(first, second);
  await proveBuildInputRejectsRedirectedAncestor(temporaryRoot);
  await proveInstallRejectsRedirectedRoot(first, temporaryRoot);
  if (checkOnly) {
    await proveDriftCheckIsNonMutating(first, temporaryRoot);
    await compareCandidateToInstalledPayloads(first);
    process.stdout.write(
      `Checked deterministic standalone payload without modifying ${pluginRoots
        .map((pluginRoot) => toPosix(relative(projectRoot, pluginRoot)))
        .join(" or ")}.\n`,
    );
  } else {
    for (const pluginRoot of pluginRoots) {
      await installPayload(first, pluginRoot);
      await compareCandidateToInstalledPayload(first, pluginRoot);
    }
    process.stdout.write(
      `Built deterministic standalone payload for ${pluginRoots
        .map((pluginRoot) => basename(pluginRoot))
        .join(" and ")} plugins.\n`,
    );
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
