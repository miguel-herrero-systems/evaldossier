# Claude Code integration specification

Status: standalone plugin `0.1.0` implemented and locally validated; repository and public-directory publication remain separate release decisions.

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
├── fixtures/                       # five public synthetic fixtures only
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

These controls do not prove that Claude obeyed the Skill, that the parent directory was not redirected before Write, that the request is confidential, or that a privileged concurrent mutator cannot race the workspace. Use a trusted local workspace and never place secrets in the request.

## Pin and evidentiary semantics

Before any dossier access, the Skill requires exact expected audience and nonce values supplied either by the current user request or by an explicitly identified upstream context. It must never derive either value from the dossier. Missing pins stop the workflow.

Every successful result preserves:

- `CALLER_DECLARED_NOT_VERIFIED` for pin-source provenance;
- `PINNED` only as equality with the supplied expected value;
- the declared result basis and predicate status;
- `MODEL_JUDGMENT → UNDETERMINED/INCONCLUSIVE`;
- `economicAction: OUT_OF_SCOPE`.

Signatures establish integrity and key control, not truth, identity, independence, authority or payment entitlement.

## Permissions and runtime boundary

Invoke `/evaldossier:verify`. The Skill sets `disable-model-invocation: true`, defines no `allowed-tools`, and blocks common dossier-reading, network, editing, delegation and nested-Skill tools for the invocation turn. Those restrictions are host-enforced behavioral controls, not cryptographic proof about the surrounding Claude Code process.

The plugin adds no hooks, MCP, network client, child process, secrets, wallet or economic action. Its bundled Ajv dependency generates validator functions only from committed protocol and synthetic-reference schemas. It does not execute caller-supplied code or discover evaluator modules, but it does not claim an absolute absence of runtime code generation.

## Validation and installation

The repository commands below become valid after the plugin directory is merged into the repository's default branch.

```text
npm run plugins:check
claude plugin validate ./claude-plugins/evaldossier --strict
claude plugin validate . --strict

claude plugin marketplace add miguel-herrero-systems/evaldossier
claude plugin install evaldossier@hrevn-evaldossier
```

The implemented checks copy the plugin to a hostile unrelated path, run without repository `dist/` or `node_modules`, compare its verification semantics with Codex, exercise formal and model-judgment dossiers, reject wrong pins and linked request files, run conformance, scan the exact file tree and verify every generated digest.

## Acceptance criteria

1. Both official Claude validators pass.
2. The plugin works from an isolated copy with no checkout/runtime installation dependency.
3. Missing or wrong pins fail closed before meaningful dossier use.
4. User-controlled values never enter Bash.
5. Invalid, duplicate, linked, oversized, network-referencing or schema-incompatible requests fail closed.
6. Hostile signed free-form text is represented only by typed fields, counts and SHA-256 commitments.
7. Codex and Claude produce equivalent verification semantics except for host identity.
8. Model judgment remains inconclusive and economic action remains out of scope.
9. The generated payload contains no local paths, internal strategy documents, external evaluator probes, hooks, MCP or secrets other than explicitly public synthetic test keys.
10. Public marketplace submission remains gated on a final clean-cache install and release review.
