# Standalone agent-plugin packaging

## Goal

An installed EvalDossier plugin must work without trusting or locating the source checkout. A user should be able to copy one plugin root to an unrelated directory, remove access to repository `dist/` and `node_modules`, and still verify a dossier or run the fixed synthetic conformance workflow offline.

This packaging layer adds distribution, not new evaluation semantics. It does not add an API, MCP server, hook, remote evaluator, secret, wallet or settlement action.

## Three hosts, one payload line

Codex and Claude Code use separate installable roots because their manifests, Skill frontmatter and safe transports differ:

```text
plugins/evaldossier/          # Codex
claude-plugins/evaldossier/   # Claude Code
```

Both contain one byte-identical generated payload:

```text
LICENSE
fixtures/
runtime/
schemas/
```

The only host-specific files are manifests, READMEs, Skills and thin launchers. No generated file is edited manually.

The Codex root additionally carries one content-addressed, synthetic model-judgment reviewer fixture under `skills/verify/fixtures/`. It is host-specific submission material rather than part of the common runtime payload. The exact-tree gate requires it to remain byte-identical to `examples/model-judgment/` and recomputes its adjacent `SHA256SUMS` manifest.

OpenClaw uses a third root:

```text
openclaw-plugins/evaldossier/ # native OpenClaw code plugin
```

It packages the same generated payload line behind a native authenticated
`registerCommand` transport. `/evaldossier-check` bypasses the LLM and accepts
only a relative path to a strict request file confined to the active agent
workspace. The package neither selects nor invokes a model provider and has no
runtime dependency on Anthropic, Claude, or any other model API.

## Build closure

`npm run plugins:build` invokes `scripts/build-agent-plugins.mjs` in its explicit
install mode. It:

1. compiles the TypeScript project;
2. bundles the shared local runtime as readable Node ESM for Node `>=20.11`;
3. includes only Node built-ins as external imports;
4. copies all seven committed protocol schemas;
5. copies only two public reference-evaluator input files and no private signing-key material;
6. includes the complete license text for every bundled runtime dependency, with only newline and trailing-whitespace normalization;
7. writes `runtime/BUNDLE_MANIFEST.json` with dependency versions and SHA-256/size commitments for every generated asset;
8. performs two independent clean payload builds and requires byte equality;
9. copies the same payload into both plugin roots and verifies their equality.

`scripts/build-agent-plugins.mjs --check` performs the same two clean temporary
builds, then compares the fresh candidate's complete common-payload inventory,
sizes and SHA-256 digests against both committed plugin roots. It never installs
or rewrites either root. A focused temporary regression deliberately alters a
candidate copy, requires the comparison to reject it, and verifies that the
altered bytes remain untouched.

The runtime installs nothing, runs no package-manager lifecycle scripts and resolves resources only inside its installed root.

## Runtime code generation

Ajv remains bundled to preserve the reviewed verifier semantics. Ajv generates validator functions from committed schemas during execution. The manifest therefore records:

```json
{
  "runtimeCodeGeneration": {
    "callerSuppliedCode": false,
    "evaluatorDiscovery": false,
    "committedSchemaCompilation": "AJV_RUNTIME_CODE_GENERATION"
  }
}
```

This is narrower than arbitrary dynamic code: the plugins do not accept caller-selected schemas in verification, import evaluator modules, or execute caller-supplied programs. Nevertheless, documentation must not claim “no runtime code generation.” Replacing Ajv with standalone precompiled validators is deferred because it changes implementation semantics and requires a new equivalence and security review.

## Verification gates

`npm run plugins:check` compiles the project, generates two fresh Codex/Claude
candidates only in temporary storage, checks determinism and committed-payload
drift without mutating either root, and then:

- enforces an exact file allowlist for both plugin roots;
- requires the Codex reviewer fixture and manifest to match the canonical model-judgment example byte for byte;
- rejects symbolic links, hard links and unsupported filesystem entries;
- verifies every manifest digest;
- independently rejects private-key filenames, PEM private keys and private JWK members while allowing public verification JWKs;
- scans text assets for local home paths and internal strategy/probe names;
- copies both plugins to unrelated paths containing spaces, quotes and shell syntax;
- runs with hostile `NODE_PATH`, no project `node_modules`, and no runtime installation;
- verifies the same formal dossier through Codex's unique structured request file and Claude's structured request file;
- checks semantic equality except for host identity;
- preserves `MODEL_JUDGMENT → INCONCLUSIVE` and `economicAction: OUT_OF_SCOPE`;
- rejects wrong pins, malformed legacy stdin documents, shell-like dossier paths, and linked request files;
- runs fixed conformance through both plugins;
- requires Claude's fixed parent guard to reject regular-file and symbolic-link transport parents while resolving the slot from the invocation working directory;
- asserts that shell syntax in paths never creates a marker file.

`npm run openclaw-plugin:check` separately type-checks and builds the native
OpenClaw package, executes its deterministic 5-positive/6-negative command
gate, and checks its npm pack inventory. CI runs it in a separate Node 24.15
job because OpenClaw's own supported Node range is narrower than EvalDossier's
Node `>=20.11` SDK range. The job installs development dependencies with
lifecycle scripts disabled and independently scans the complete package root
for private-key material. The published package has no runtime npm
dependencies.

The Codex and Claude official manifest validators are also run before release. Clean marketplace-cache installation remains a distinct release gate because it mutates host plugin configuration and exercises each host's downloader/cache rather than the payload alone.

## Versioning

- EvalDossier package/runtime source: `0.2.1`.
- Protocol: `0.1`.
- Model-safe projection: `0.2`.
- Codex plugin: `0.2.1`.
- Claude Code plugin: `0.2.2`.
- OpenClaw plugin: `0.2.1`.

Any change to the common generated payload requires rebuilding and bumping every
published host package that carries it. A host-only manifest, Skill, or native
transport change may bump only that host package, but its payload-drift gate
must still pass.

Host versions are independent. A host-only correction does not make another
host's lower number stale. The OpenClaw package version describes its packaged
payload line and native transport; it does not imply byte-identical host
instructions.

## Ephemeral conformance keys

Standalone plugins package no private signing-key material. Each synthetic conformance invocation generates separate evaluator, requester and exporter Ed25519 keys in memory. Only public key components enter the generated dossier; private components are neither persisted nor returned.

Consequently, the plugin payload remains reproducible byte for byte, but two live conformance dossiers intentionally do not: their public keys, signatures and dependent digests differ. Tests compare declared checks and typed semantics rather than output dossier bytes.

`scripts/check-agent-plugin-secrets.mjs` is invoked directly by CI, outside the payload builder. It rejects `*.private.*`-style filenames, private-key PEM blocks and any JSON Web Key object containing a private `d` member. Public JWKs without `d` remain allowed for verification fixtures.
