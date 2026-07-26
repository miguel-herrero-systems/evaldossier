# EvalDossier Claude Code plugin v0.2.2

This host-only patch makes the fixed synthetic conformance workflow work from a genuinely fresh Claude Code workspace.

The v0.2.1 Skill invoked the fixed conformance launcher beneath `./.evaldossier-local/` without first creating that fixed parent directory. The launcher therefore failed closed from an empty workspace, even though its automated runtime tests passed when given an already-existing parent.

v0.2.2 adds the same fixed, argument-free parent preparation to both verification and conformance:

```text
test ! -L ./.evaldossier-local && mkdir -p ./.evaldossier-local && test -d ./.evaldossier-local && test ! -L ./.evaldossier-local
```

The guard accepts an absent path or an existing real directory, rejects a regular file or symbolic link, and creates only the parent transport directory when absent. It does not create, remove, overwrite or replace the conformance output directory. No user-controlled value enters Bash.

All relative paths refer to Claude Code's current working directory at invocation. The Skill requires that directory to remain the intended trusted workspace for the workflow.

EvalDossier-owned launcher code performs no workspace browsing or pre/post audit. The Skill tells the host to copy each fixed command byte for byte and explicitly rejects appended status markers, redirections, diagnostics or other shell fragments. This remains behavioral guidance rather than enforcement; filesystem checks such as confirming marker-file absence remain the responsibility of an external harness.

The Codex plugin is unaffected by the original defect. Its published v0.2.1 Skill creates a unique private request directory with `mktemp`, passes a new absolute output through `conformance-request`, and has an executable regression that runs this path. It never uses `./.evaldossier-local/conformance-output`.

This release does not change:

- the EvalDossier protocol (`0.1`);
- the common generated runtime or schemas;
- the Codex plugin (`0.2.1`);
- evidentiary semantics, pin handling or `economicAction: OUT_OF_SCOPE`;
- the OpenAI marketplace ZIP previously validated for Codex.

## Release validation

- 132/132 automated tests pass.
- Deterministic packaging, the independent payload secret guard, both strict
  Claude plugin validators and `git diff --check` pass.
- The 25-file standalone source payload and a clean marketplace-cache
  installation are byte-identical. Their inventory-tree SHA-256 is
  `31fb5f9226d827c798b4bb9169b270f38674536f9ff0a4850d31fec8e8d9bf9e`.
- A final live sample passed five positive and three negative cases from fresh
  case directories using the installed `0.2.2` payload. The observed 8/8
  result is validation evidence, not a guarantee of future host-model
  behavior.
