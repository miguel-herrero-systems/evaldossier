# Codex integration specification

Status: standalone skills-only plugin `0.1.0` implemented and locally validated; repository and OpenAI Plugins Directory publication remain separate release decisions.

## Decision

Codex uses one Skill and a thin host launcher over the same generated runtime as the Claude Code plugin. It is not an MCP server, hook, public API, session recorder, remote evaluator, marketplace, or settlement adapter.

AgentProof remains the observed-session receipt layer. EvalDossier remains the typed evaluation layer. This plugin does not capture Codex prompts, commands, event streams, repository changes or session history. A future AgentProof receipt may be evidence presented to an evaluator, but neither product inherits the other's claims.

## Installable layout

```text
plugins/evaldossier/
├── .codex-plugin/plugin.json
├── LICENSE
├── README.md
├── fixtures/                       # five public synthetic fixtures only
├── runtime/
│   ├── BUNDLE_MANIFEST.json
│   ├── THIRD_PARTY_NOTICES.md
│   ├── shared/evaldossier-local-core.mjs
│   └── third-party-licenses/
├── schemas/                        # seven committed schemas
└── skills/verify/
    ├── SKILL.md
    ├── agents/openai.yaml
    └── scripts/evaldossier-local.mjs
```

The repository marketplace is [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json). The installed Skill is invoked explicitly as `$evaldossier:verify`. The launcher configures only `hostName`, `hostSlug` and `integrationId`; pinning rules, parsing, path rejection, semantic projection, conformance and non-claims remain inside the shared runtime.

The installed root is autonomous: it never imports the source checkout, `dist/`, `node_modules`, another plugin or a remote package. See [agent-plugin packaging](./AGENT_PLUGIN_PACKAGING.md).

## Structured-stdin transport

Codex command tools accept a command string. The plugin therefore forbids placing dossier paths, pins or source labels in that string.

After obtaining both pins outside the dossier, Codex starts a non-TTY process with the execution tool's structured working-directory field set to the directory containing `SKILL.md`. The command is exactly:

```text
node ./scripts/evaldossier-local.mjs verify-stdin --json
```

It then sends exactly one compact JSON object followed by one newline through the structured stdin tool:

```json
{"schemaVersion":"evaldossier.local-verification-request/0.1","dossier":"<absolute local dossier directory>","audience":"<expected audience>","nonce":"<expected nonce>","audienceSource":"<user-request|upstream-context>","nonceSource":"<user-request|upstream-context>"}
```

Conformance uses the same transport with a separate closed schema and one fixed command:

```text
node ./scripts/evaldossier-local.mjs conformance-stdin --json
```

```json
{"schemaVersion":"evaldossier.local-conformance-request/0.1","output":"<new absolute local output directory>"}
```

No request value may enter a shell command, pipe, heredoc, environment assignment, command substitution, generated program or temporary request file. If structured non-TTY stdin is unavailable, the Skill stops rather than downgrading the transport.

The runtime accepts one newline-terminated JSON document capped at 16 KiB. It rejects duplicate or unknown fields, malformed UTF-8, unsupported versions, unknown commands/options, missing values, extra lines, invalid pin sources, URLs, network roots, device namespaces and reserved Win32 aliases before dossier access.

## Pin and evidentiary semantics

Before reading or listing a dossier, the Skill requires exact expected audience and nonce values from either:

- the current user request (`user-request`); or
- a separate upstream trust context explicitly identified by the user (`upstream-context`).

It must never derive, copy, suggest, autocomplete or confirm either value from the dossier, its index, reports, filenames, examples or prior output. Missing pins stop the workflow.

Every result preserves:

- `CALLER_DECLARED_NOT_VERIFIED` for pin-source provenance;
- `PINNED` only as equality with a supplied value;
- declared result basis and predicate status;
- `MODEL_JUDGMENT → UNDETERMINED/INCONCLUSIVE`;
- `economicAction: OUT_OF_SCOPE`.

The fixed model-facing projection returns typed semantics plus SHA-256 commitments to free-form text, paths and downstream error details. A valid dossier signature does not make embedded strings safe instructions.

## Runtime and trust boundary

The plugin adds no owned network client, listener, child process, secrets, evaluator discovery, wallet or economic action. It rejects dynamic evaluator/module options. The surrounding Codex process, plugin manager/cache, host Node executable, structured tool transport and a dossier snapshot assumed unchanged during verification remain trusted external boundaries.

The bundled Ajv dependency generates validator functions at runtime only from committed protocol and synthetic-reference schemas. EvalDossier does not execute caller-supplied code or discover evaluator modules, but the current bundle does not claim an absolute absence of runtime code generation.

## Validation and installation

The repository commands below become valid after the plugin directory is merged into the repository's default branch.

```text
npm run plugins:check
python3 <plugin-creator>/scripts/validate_plugin.py ./plugins/evaldossier

codex plugin marketplace add miguel-herrero-systems/evaldossier
codex plugin add evaldossier@hrevn-evaldossier
```

The implemented checks build the common payload twice and require byte equality, copy each plugin to a hostile unrelated path, run without repository `dist/` or `node_modules`, compare Codex and Claude verification results, preserve model-judgment semantics, reject wrong pins and shell-like paths, run conformance, scan the exact tree and verify every generated digest.

OpenAI public submission is a later release step. The plugin is intentionally Skills-only and contains no MCP/app server. Submission materials must include the required positive and negative test cases and pass OpenAI's security and identity review.

## Acceptance criteria

1. The official Codex plugin validator passes.
2. The plugin works from an isolated copy without the source checkout or runtime installation.
3. Both pins are acquired before dossier access; missing or wrong pins fail closed.
4. No user-controlled value enters a shell command.
5. Structured stdin accepts exactly one bounded strict-JSON line and rejects ambiguity.
6. Formal conformance runs only the fixed reference evaluator and refuses output reuse.
7. Model judgment remains inconclusive and economic action remains out of scope.
8. Hostile signed text and raw errors never enter model-facing output.
9. Codex and Claude produce equivalent verification semantics except for host identity.
10. The generated payload contains no local paths, internal strategy documents, external evaluator probes, hooks, MCP or secrets other than explicitly public synthetic test keys.
11. Public marketplace submission remains gated on a final clean-cache install and release review.
