# Claude Code integration specification

Status: standalone plugin `0.2.2` implemented, transferred from the isolated laboratory and validated from a clean marketplace cache; repository and public-directory publication remain separate release decisions.

## Decision

Claude Code uses one manually invoked Skill and a thin host launcher over the same generated runtime as the Codex plugin. It is not a hook, MCP server, session recorder, public API, evaluator marketplace, or settlement adapter.

AgentProof remains the observed-session receipt layer. EvalDossier remains the typed evaluation layer. This plugin does not capture Claude Code prompts, commands, hooks, tool calls, files, repository changes, or session history. A future AgentProof receipt may be evidence presented to an evaluator, but neither product inherits the other's claims.

Official references:

- [Claude Code Skills](https://code.claude.com/docs/en/slash-commands)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)

## Installable layout

```text
claude-plugins/evaldossier/
├── .claude-plugin/plugin.json
├── LICENSE
├── README.md
├── fixtures/                       # two public reference inputs; no private keys
├── runtime/
│   ├── BUNDLE_MANIFEST.json
│   ├── THIRD_PARTY_NOTICES.md
│   ├── shared/evaldossier-local-core.mjs
│   └── third-party-licenses/
├── schemas/                        # seven committed schemas
├── scripts/evaldossier-local.mjs   # host identity only
└── skills/verify/SKILL.md
```

The repository marketplace is [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json). Installation copies only this plugin root into Claude's cache, so every runtime dependency is physically enclosed. The launcher never imports `dist/`, `node_modules`, a sibling repository directory, or a remote package.

The Codex and Claude payloads are generated independently twice and compared byte for byte before being copied into their host roots. See [agent-plugin packaging](./AGENT_PLUGIN_PACKAGING.md).

## Why the request uses a file

Claude Code invokes Bash with a command string. Placing a dossier path, audience, nonce, or source label directly in that string would make quoting depend on model behavior.

The Skill instead writes an exact JSON object through Claude Code's structured Write tool to:

```text
./.evaldossier-local/claude-code-request.json
```

It then invokes one fixed command:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/evaldossier-local.mjs" verify-request --request ./.evaldossier-local/claude-code-request.json --json
```

`CLAUDE_PLUGIN_ROOT` is supplied by the host and locates plugin code that is trusted and assumed unchanged during the invocation. No dossier path, pin, source label, project path, session identifier, prompt, or generated suffix enters the command.

The fixed request file is one non-secret transport slot. Concurrent invocations in one workspace are unsupported. The runtime:

- accepts strict JSON only and caps it at 16 KiB;
- rejects duplicate members, comments, trailing commas, malformed UTF-8, BOMs, extra/missing fields and unsupported versions;
- rejects URLs, network roots, device namespaces and reserved Win32 aliases;
- checks the final file before opening, opens with no-follow where supported, compares file identity, requires one regular non-linked file and reads from that same handle;
- validates both pin-source labels before resolving or reading the dossier;
- never reflects the request path, dossier path, raw dossier text or raw downstream errors into model-visible output.

Every relative transport and output path is resolved from Claude Code's current working directory when the Skill is invoked. Claude Code can preserve a directory change across Bash calls, so this can differ from the launch-time project root. The Skill requires the intended trusted local workspace to remain current throughout the workflow. See [Claude Code Bash tool behavior](https://code.claude.com/docs/en/tools-reference#bash-tool-behavior).

Before Write or conformance, the Skill prescribes one fixed, argument-free guard:

```text
test ! -L ./.evaldossier-local && mkdir -p ./.evaldossier-local && test -d ./.evaldossier-local && test ! -L ./.evaldossier-local
```

It accepts an absent path or an existing real directory and fails on a regular file or symbolic link. These controls do not prove that Claude obeyed the Skill, that the path remains unchanged after the guard, that the request is confidential, or that a privileged concurrent mutator cannot race the workspace. Use a trusted local workspace and never place secrets in the request.

## Pin and evidentiary semantics

Before any dossier access, the Skill requires exact expected audience and nonce values supplied either by the current user request or by an explicitly identified upstream context. It must never derive either value from the dossier. Missing pins stop the workflow.

Every successful result preserves:

- `CALLER_DECLARED_NOT_VERIFIED` for pin-source provenance;
- `PINNED` only as equality with the supplied expected value;
- the declared result basis and predicate status;
- `MODEL_JUDGMENT → UNDETERMINED/INCONCLUSIVE`;
- `economicAction: OUT_OF_SCOPE`.

Projection `evaldossier.model-safe-projection/0.2` separates operation `status` from `verificationStatus`, exposes the signed aggregate as `protocolOutcome`, and preserves criterion-scoped signed mappings as SHA-256 commitments in `criterionResults`. Signatures establish integrity and key control, not truth, identity, independence, authority or payment entitlement.

## Permissions and runtime boundary

Invoke `/evaldossier:verify`. The Skill sets `disable-model-invocation: true`, defines no `allowed-tools`, and blocks common dossier-reading, network, editing, delegation and nested-Skill tools for the invocation turn. Those restrictions are host-enforced behavioral controls, not cryptographic proof about the surrounding Claude Code process.

EvalDossier-owned launcher code performs no workspace browsing or pre/post audit. The Skill instructs the host model to copy the fixed commands byte for byte and not to append a success marker, redirection, diagnostic or other shell fragment. This is behavioral guidance, not enforcement: the plugin cannot control surrounding host-model behavior.

The plugin adds no hooks, MCP, network client, child process, packaged private key, wallet or economic action. Synthetic conformance generates fresh Ed25519 role keys in memory and persists only public components in its output dossier. Its bundled Ajv dependency generates validator functions only from committed protocol and synthetic-reference schemas. It does not execute caller-supplied code or discover evaluator modules, but it does not claim an absolute absence of runtime code generation.

## Validation and installation

The repository commands below become valid after the plugin directory is merged into the repository's default branch.

```text
npm run plugins:check
claude plugin validate ./claude-plugins/evaldossier --strict
claude plugin validate . --strict

claude plugin marketplace add miguel-herrero-systems/evaldossier
claude plugin install evaldossier@hrevn-evaldossier
```

The implemented checks independently reject private key material in CI, copy the plugin to a hostile unrelated path, run without repository `dist/` or `node_modules`, compare its verification semantics with Codex, exercise formal and model-judgment dossiers, reject wrong pins and linked request files, reject a regular-file or symbolic-link transport parent, prove that the relative slot is rooted in the invocation working directory, preserve an existing conformance output, run conformance with fresh in-memory keys, scan the exact file tree and verify every generated digest. Live conformance dossier bytes differ by design; declared semantics remain equivalent.

## Acceptance criteria

1. Both official Claude validators pass.
2. The plugin works from an isolated copy with no checkout/runtime installation dependency.
3. Missing or wrong pins fail closed before meaningful dossier use.
4. User-controlled values never enter Bash.
5. Invalid, duplicate, linked, oversized, network-referencing or schema-incompatible requests fail closed.
6. Hostile signed free-form text is represented only by typed fields, counts and SHA-256 commitments.
7. Codex and Claude produce equivalent verification semantics except for host identity.
8. Model judgment remains inconclusive and economic action remains out of scope.
9. The generated payload contains no local paths, internal strategy documents, external evaluator probes, hooks, MCP or private signing-key material; public verification JWKs remain allowed.
10. Public marketplace submission remains gated on a final clean-cache install and release review. A fresh workspace must run conformance without requiring the caller to pre-create `./.evaldossier-local`.
11. The fixed parent guard fails closed if `./.evaldossier-local` is a regular file or symbolic link, and all relative paths are explicitly scoped to the invocation working directory.
