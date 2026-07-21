# Claude Code integration specification

Status: repository-contained development plugin. It is not yet a standalone marketplace package.

## Decision

Claude Code is the second EvalDossier agent integration after Codex. It uses one manually invoked plugin Skill and a thin launcher over the same closed local runtime as Codex.

This is intentionally not a hook, MCP server, session recorder, public API, or settlement adapter. Anthropic recommends Skills for reusable local procedures; plugins provide the repository-contained packaging and namespace used here.

Official references:

- [Claude Code Skills](https://code.claude.com/docs/en/slash-commands)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins)
- [Plugin reference](https://code.claude.com/docs/en/plugins-reference)
- [Permissions](https://code.claude.com/docs/en/permissions)

## Layout

```text
integrations/
├── shared/
│   └── evaldossier-local-core.mjs
├── codex/evaldossier/scripts/
│   └── evaldossier-local.mjs
└── claude-code/evaldossier-plugin/
    ├── .claude-plugin/plugin.json
    ├── scripts/evaldossier-local.mjs
    └── skills/verify/SKILL.md
```

The two launchers configure only host identity and synthetic fixture naming. Parsing, context pinning, path rejection, verification, conformance, model-safe projection, non-claims, and the economic boundary live in the shared runtime and cannot be weakened by a host launcher.

## Why the request uses a file

Claude Code invokes Bash with a command string. Placing a dossier path, audience, nonce, or source label directly in that string would make correct quoting depend on model behavior and would create a command-injection boundary.

The Skill instead writes an exact JSON object through Claude Code's structured Write tool to the fixed project-relative path `./.evaldossier-local/claude-code-request.json`. Every Bash command is a fixed project-relative literal: it contains neither request values nor host substitutions such as project paths or session identifiers. Claude Code must be started at the EvalDossier repository root.

The fixed file is deliberately a single request slot. Concurrent verification invocations in one checkout are unsupported; each invocation writes fresh pins to the same exact ignored path without reading prior contents. This trades concurrency for a smaller, auditable shell boundary in the development plugin.

The runtime:

- accepts strict JSON only;
- rejects duplicate members, comments, trailing commas, malformed UTF-8, BOMs, extra or missing fields, unsupported schema versions, and oversized requests;
- accepts only one regular request file with no symbolic or hard links;
- validates both pins and their closed source labels before resolving or reading the dossier;
- rejects URL, network-root, device-namespace, and reserved Win32 alias paths;
- never reflects the request path, dossier path, raw dossier text, or raw downstream errors into model-visible output.

The request file is transport, not evidence. Its values remain caller-declared and `CALLER_DECLARED_NOT_VERIFIED`.

## Invocation and permissions

Load the development plugin from a built EvalDossier clone:

```text
claude --plugin-dir ./integrations/claude-code/evaldossier-plugin
```

Invoke `/evaldossier:verify`. The Skill sets `disable-model-invocation: true`; Claude cannot select it automatically. It deliberately defines no `allowed-tools`, because that field pre-approves tools rather than restricting the tool surface. A narrow `disallowed-tools` list removes common dossier-reading, network, editing, delegation, and nested-Skill paths for the invocation turn while leaving the structured Write and fixed Bash calls available.

These controls are behavioral and host-enforced, not cryptographic proof. The Skill cannot prove that Claude obeyed its instructions, that user or enterprise settings expose no other tools, or that the surrounding process lacks plugins, hooks, shell, network, mapped drives, mounts, or reparse points.

## Repository-contained boundary

The launcher imports the shared runtime and compiled `dist/` from the EvalDossier repository. Therefore this source directory works with `--plugin-dir` only from a clone that has already run the normal build. Copying or installing the plugin directory alone will not produce a working standalone plugin.

A future distributable bundle must include a reviewed self-contained runtime or depend on a separately published, pinned EvalDossier package. That packaging and supply-chain decision is out of scope for this integration version.

## AgentProof boundary

AgentProof records what its instrumented collector observed during an agent session. EvalDossier records what an evaluator concluded about predicates and an obligation. This Skill does not capture Claude Code hooks, prompts, commands, tool calls, files, or session history. An AgentProof receipt may later be presented as evidence, but neither product inherits the other's claims automatically.

## Acceptance criteria

1. The plugin manifest passes `claude plugin validate` on the supported local Claude Code version.
2. Missing pins stop before dossier inspection, request creation, or launcher invocation in a model-level forward test.
3. Structured-request verification matches direct-argv verification semantically.
4. Codex and Claude Code produce the same verification result except for the declared integration identifier.
5. Invalid, duplicated, linked, oversized, network-referencing, or schema-incompatible requests fail closed.
6. Documented shell commands contain no host-substitution, environment, project-path, session, dossier, pin, or model-generated fragment.
7. Hostile signed free-form text remains represented only by counts and SHA-256 commitments.
8. Both launchers and the shared runtime contain no owned network or child-process client.
9. Model judgment remains `UNDETERMINED`/`INCONCLUSIVE`; all results retain `economicAction: OUT_OF_SCOPE`.
10. SDK/runtime exports and dependencies remain unchanged, and the npm payload still excludes `integrations/` executable code; public documentation may be added to the package.
11. OpenClaw compatibility is tested later against the same Claude bundle; no native OpenClaw plugin is implied by this document.
