# Local Codex integration specification

Status: implemented as a repository-contained Skill; installation and plugin packaging remain separate decisions.

## 1. Decision

The first Codex integration is a small, repository-contained Codex Skill. It exposes a repeatable local workflow over the existing EvalDossier CLI and SDK. It is not an MCP server, public API, session recorder, remote service, or settlement adapter.

A plugin may package the Skill later if distribution requires it. That decision is separate from the local integration and must not enlarge the v0.2 trust boundary by default.

## 2. Product boundary

AgentProof and EvalDossier solve different stages of an evidence pipeline:

```text
agent execution
    -> AgentProof observed-session receipt (optional evidence source)
    -> evidence presented to an evaluator
    -> EvalDossier typed evaluation and portable dossier
    -> consumer policy outside both projects
```

- **AgentProof** records what its instrumented collector observed during an agent session, protects the receipt against later modification, and may seal and anchor it.
- **EvalDossier** records what an evaluator concluded about defined predicates and an obligation, the evidentiary basis it declared, and the integrity bindings needed for offline verification.

The Codex integration belongs to EvalDossier only as a local **client and orchestrator**. It must not capture Codex event streams, commands, prompts, repository changes, or session history. Those are AgentProof concerns. A future profile may accept an AgentProof receipt as evidence, but neither project inherits the other's claims automatically.

## 3. Intended users and concrete requests

The Skill should support two narrow workflows.

### 3.1 Verify a presented dossier

Example request:

> Use EvalDossier to verify this dossier offline for audience `buyer.example` and nonce `...`, then explain what the result does and does not establish.

The Skill invokes a deterministic local wrapper around the existing verifier, requires caller-supplied audience and nonce pins, and returns a model-safe projection of the typed verification result. Free-form dossier text is not copied into the model-facing result: identifiers, audience, warnings, paths, and raw failure details are represented only by counts and SHA-256 commitments where needed. The fixed interpretation limitations remain explicit.

The Skill must establish both expected values **before it reads or asks a tool to inspect the dossier being verified**. It may take them only from exact values explicitly supplied in the user's request or from a separate upstream trust context that the user explicitly identifies as the source of the expected pins. It must never derive, copy, suggest, or complete either value from the dossier, its index, enclosed objects, reports, adjacent examples, filenames, or verifier output.

If either expected value is absent, the Skill must stop and request it or return `INPUT_REQUIRED`; it must not invoke verification to discover a matching value. This is a behavioral rule for the orchestrating model as well as an argument rule for the wrapper.

### 3.2 Exercise evaluator conformance locally

Example request:

> Run the bundled EvalDossier reference evaluator and show whether its declared formal result survives schema, signature, binding, and conformance checks.

The first implementation uses only the repository's built-in reference evaluator and intentionally public fixture keys. It demonstrates orchestration and semantic preservation; it is not a production issuance path and cannot establish an institutional signer identity.

The Skill must not dynamically import or execute an evaluator chosen by path, URL, package name, or model-generated source. Support for third-party evaluators belongs in a later, separately reviewed interface.

## 4. Source layout

```text
integrations/codex/evaldossier/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── scripts/
    └── evaldossier-local.mjs
```

The Skill source remains inside this repository so its instructions and script are reviewable with the protocol implementation. It is not automatically installed into a user's Codex home directory. Installation and plugin packaging remain explicit later steps.

No additional README, server, database, registry, or network client is required for this integration.

## 5. Command contract

The bundled script exposes only closed subcommands and options:

```text
node integrations/codex/evaldossier/scripts/evaldossier-local.mjs verify \
  --dossier <existing-directory> \
  --audience <expected-audience> \
  --nonce <expected-nonce> \
  --audience-source <user-request|upstream-context> \
  --nonce-source <user-request|upstream-context> \
  --json

node integrations/codex/evaldossier/scripts/evaldossier-local.mjs conformance \
  --output <new-directory> \
  --json
```

Normative behavior:

1. Reject unknown commands, duplicate options, missing values, and unexpected positional arguments.
2. Accept only syntactically local filesystem paths. Reject URLs, UNC/network roots, protocol-relative roots, prefixed Windows device namespaces, and reserved Win32 device aliases such as `NUL`, `CON`, `COM1`, and their extension forms before path resolution or any filesystem operation. This lexical control cannot prove that an apparently local drive, mount, or ancestor reparse point has local physical backing.
3. Require both audience and nonce for Skill-driven verification. The lower-level CLI may still support diagnostic unpinned verification, but the Skill must not silently select it.
4. Require a closed, explicit declared source for each pin: `user-request` or `upstream-context`. Reject absent, unknown, `dossier`, inferred, or derived source values.
5. Treat each source label as an orchestrator declaration for audit, not as proof that the model obtained the pin independently. The wrapper cannot observe the model's prior context or establish provenance cryptographically.
6. Require a new output directory for conformance and never overwrite an existing path.
7. Emit one stable JSON result to standard output when `--json` is used; diagnostics go to standard error and failures return non-zero. Neither stream may reflect raw attacker-controlled dossier text, paths, option names, or downstream error details.
8. Preserve the verifier's typed basis, predicate status, obligation verdict, trust status, pin status, and provenance. Preserve the existence and integrity of free-form warning text through a count and per-warning SHA-256 commitments, not by returning the raw strings to Codex.
9. Keep `economicAction` equal to `OUT_OF_SCOPE` and never translate a verdict into payment advice.

The wrapper must call repository code through fixed imports. It must not construct shell commands from user input.

## 6. Evidentiary interpretation

Codex is an orchestrator, not an authority upgrade.

- A deterministic predicate executed by the fixed reference evaluator remains `FORMAL_PREDICATE` because of the evaluator method, not because Codex invoked it.
- A qualitative conclusion supplied by Codex or another model would remain `MODEL_JUDGMENT`.
- A valid signature establishes integrity and key control, not truth, neutrality, legal identity, independence, or commercial authority.
- SDK conformance establishes compatibility with declared protocol semantics, not evaluator certification.
- An AgentProof receipt, if introduced later, would establish only the properties its own receipt format and verifier support. Merely including it cannot establish fulfillment of an obligation.
- `PINNED` means that the signed value matched an expected value supplied to the verifier. It does not prove that the expected value was obtained independently. The Skill's pin-source field is caller-declared provenance and must not be presented as cryptographic or institutional assurance.

The integration must repeat these boundaries in its machine-readable output and user-facing summary where relevant. It must follow evidentiary non-escalation: preserve or weaken an upstream basis, never strengthen it without additional evidence.

## 7. Security envelope

The initial integration inherits and narrows the current offline posture:

- no wrapper-owned network client or listener; syntactically remote paths and reserved Win32 device aliases are rejected before filesystem access;
- no MCP server, HTTP listener, telemetry, update check, or remote schema fetch;
- no session interception or Codex history access;
- no sourcing of expected audience or nonce values from the dossier under verification;
- no following, interpreting as instructions, or model-facing reflection of free-form text from the dossier; a valid signature does not make text safe to execute;
- no dynamic evaluator, plugin, package, script, or URL discovery;
- no arbitrary shell execution;
- no funds, wallets, escrow, transaction construction, or settlement recommendation;
- no production private key in a prompt, Skill file, command argument, fixture, log, or model-readable configuration;
- no overwrite of an existing output directory;
- no interpretation of unsigned or partially assembled output as a dossier.

The conformance workflow uses only the public deterministic fixture keys already marked as compromised test material. A production issuance workflow is explicitly deferred until EvalDossier has a narrow external-signer interface whose authorization and key custody can be reviewed independently. Passing a key path or raw JWK through Codex is not an acceptable substitute.

The integration cannot guarantee that the surrounding Codex process lacks general filesystem or shell access. Its claim is narrower: EvalDossier-owned integration code neither requests secrets nor introduces a new network, dynamic-code, or economic-action capability.

Path syntax is not storage provenance. A drive letter can be mapped to a UNC share, and an apparently local directory can sit beneath a network mount or reparse point configured outside EvalDossier. The caller must provide a genuinely local, trusted storage location; the initial wrapper does not query operating-system mount topology and does not claim to prove physical locality.

## 8. Output contract

Successful JSON output should include:

```json
{
  "integration": "evaldossier-codex-local/0.1",
  "operation": "verify",
  "status": "PASS",
  "dossierLocation": {
    "kind": "LOCAL_PATH",
    "pathSha256": "<sha256-of-resolved-local-path>",
    "rawPathEmitted": false
  },
  "pinProvenance": {
    "audience": "USER_REQUEST",
    "nonce": "USER_REQUEST",
    "assurance": "CALLER_DECLARED_NOT_VERIFIED"
  },
  "summary": {
    "audienceBinding": "PINNED",
    "dossierNonceBinding": "PINNED",
    "economicAction": "OUT_OF_SCOPE",
    "untrustedText": {
      "dossierIdSha256": "<sha256>",
      "audienceSha256": "<sha256>",
      "warningCount": 1,
      "warningSha256": ["<sha256>"],
      "rawTextEmitted": false
    }
  },
  "nonClaims": [
    "No truth, neutrality, legal authority, or payment entitlement is established by this result alone."
  ]
}
```

`summary` is a fixed wrapper projection of the verified EvalDossier summary, not a model-generated reinterpretation. It exposes only typed semantic fields plus commitments to free-form text. The wrapper does not return raw dossier identifiers, audience text, warnings, local paths, or downstream error details to the model; a human who needs those strings must inspect the dossier outside the agent context. These SHA-256 values provide stable correlation, not confidentiality or truth. `pinProvenance` records what the orchestrator declares about the source of each expected value; it does not prove independence and must always retain the `CALLER_DECLARED_NOT_VERIFIED` assurance. The conformance operation additionally reports the exact conformance check identifiers returned by the SDK.

## 9. Acceptance criteria

Implementation is acceptable only if all of the following hold from a clean clone:

1. The Skill folder passes the official skill structural validator.
2. The full test suite, typecheck, demos, package policy, and vulnerability audit remain green.
3. A valid dossier verifies successfully when both caller-declared, out-of-dossier expected values and their declared sources are supplied before dossier inspection.
4. With either expected value absent, the Skill requests input or returns `INPUT_REQUIRED` without inspecting the dossier or invoking the wrapper.
5. In an adversarial forward-test where the dossier contains audience and nonce values but the user supplies neither as expected values, the Skill refuses to extract or reuse them.
6. A wrong audience or nonce fails closed.
7. Successful output records source provenance for both pins as `CALLER_DECLARED_NOT_VERIFIED` and never describes that provenance as independently established.
8. A modified artifact or signature fails closed.
9. The model-judgment fixture remains `UNDETERMINED` and `INCONCLUSIVE`.
10. Conformance runs only the fixed bundled evaluator and produces a new verified dossier.
11. Unknown options, reused output paths, URLs, UNC/network roots, prefixed Windows device namespaces, reserved Win32 aliases (including extension forms), and evaluator/module path injection are rejected before filesystem access.
12. The integration performs no network requests in success or failure paths.
13. No production secret, local strategy document, user-home path, or unapproved file enters the package or public repository.
14. Public documentation describes the AgentProof boundary in one sentence and does not claim Codex certification or endorsement.
15. A valid signed dossier containing instruction-like warning text returns only its warning count and digests; the raw string never appears in standard output or standard error.
16. Malformed dossier values, local paths, and unknown option names are not reflected into model-facing failure output; downstream details are represented only by a diagnostic digest.

## 10. Explicitly deferred

- production signing and key custody;
- third-party evaluator loading or discovery;
- AgentProof-to-EvalDossier evidence profiles;
- Claude Code and OpenClaw clients;
- npm or Codex marketplace publication;
- plugin packaging;
- MCP, public API, control plane, accounts, registry, or marketplace;
- networked evidence acquisition;
- blockchain anchoring and settlement.

Each deferred item requires its own utility and security justification. None is implied by completion of the local Skill.

## 11. Implementation and validation sequence

1. Scaffold the Skill with the official skill initializer.
2. Write the closed local wrapper over existing CLI and SDK functions.
3. Add adversarial integration tests for arguments, path behavior, pins, tampering, and semantic non-escalation.
4. Forward-test the Skill with missing pins and a dossier that contains tempting self-sourced values; require refusal before verification.
5. Validate the Skill structure and the full repository from a clean clone.
6. Review the public presentation and package contents before any commit or publication.
