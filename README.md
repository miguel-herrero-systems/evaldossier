# EvalDossier — Verifiable Evaluation Evidence for AI Agents

[![CI](https://github.com/miguel-herrero-systems/evaldossier/actions/workflows/ci.yml/badge.svg)](https://github.com/miguel-herrero-systems/evaldossier/actions/workflows/ci.yml)

**Offline-verifiable evaluation attestations and portable dossiers for heterogeneous AI-agent evaluators.**

> Status: SDK `v0.2.0` · protocol `evaldossier/0.1` · Codex/Claude plugins `v0.1.0` · offline-first · settlement-independent

EvalDossier is a settlement-independent TypeScript SDK and reference implementation for packaging evaluator outputs, evidence, and signatures into dossiers that another system can verify offline. It is designed for AI-agent and agent-commerce workflows that must distinguish formal proof from model judgment or self-assertion before applying any economic policy.

Conceptual rationale: **[Supported by What?](./docs/PROOF_JUDGMENT_DECLARATION.md)** explains why a signed `supported: true` can still mean a formal predicate, a model judgment, or a self-assertion—and why downstream systems must not collapse them.

Its central normalization invariant is **evidentiary non-escalation**: an adapter may preserve or weaken the declared evidentiary strength of an upstream result, but it must not strengthen that result without additional evidence. Signing a normalized value makes the adapter's declaration tamper-evident; it does not turn a judgment into proof or an assertion into an independent observation.

EvalDossier separates three questions that agent-commerce systems often collapse:

1. What kind of basis produced a result?
2. What conclusion did the evaluator return?
3. What, if anything, does the evidence establish?

Its core is evaluator-agnostic:

```text
any evaluator or offline adapter
              |
              v
manifest + profile + request + evidence + attestation
              |
              v
       signed portable dossier
              |
              v
         offline verifier
```

The canonical protocol 0.1 path is a deterministic reference evaluator using `FORMAL_PREDICATE`. It demonstrates that a complete dossier can be generated and checked for its declared integrity and semantics without a server, external identity provider, payment rail, or upstream service.

A second, entirely synthetic path demonstrates a different property: an offline normalizer can preserve a heterogeneous `MODEL_JUDGMENT` without promoting it to factual proof. Every byte in that fixture is authored by this project, uses `SYNTHETIC` provenance, and makes no claim about an external evaluator, integration, production event, adoption, or demand.

## Quick start

```bash
git clone https://github.com/miguel-herrero-systems/evaldossier.git
cd evaldossier
npm ci
npm test
npm run demo
npm run verify:demo
npm run demo:sdk
```

The demo writes two dossiers to `demo-output/`. You can verify either one directly:

```bash
node dist/src/cli.js verify demo-output/formal
node dist/src/cli.js verify demo-output/model-judgment
```

Committed golden dossiers are available under [`examples/`](./examples/) so the repository can be inspected without running code.

Expected semantic output:

| Case | Basis | Predicate status | Obligation verdict | Economic action |
|---|---|---|---|---|
| Canonical formal evaluator | `FORMAL_PREDICATE` | `ESTABLISHED_TRUE` | `SATISFIED` | `OUT_OF_SCOPE` |
| Synthetic model-judgment normalizer | `MODEL_JUDGMENT` | `UNDETERMINED` | `INCONCLUSIVE` | `OUT_OF_SCOPE` |

## Evaluator SDK

SDK v0.2 makes the evaluator boundary executable without changing protocol v0.1. An integration can define an evaluator, return one complete signed `EvaluationRun`, assemble it into a dossier, verify it with audience and nonce pinned, and assert its expected declared semantics.

Until a supported npm release exists, the imports below are exercised from a cloned repository after `npm run build`; `npm install evaldossier` is not a supported installation path.

```js
import {
  assertEvaluatorConformance,
  defineEvaluator,
  runEvaluator,
} from "evaldossier/sdk";

const evaluator = defineEvaluator({
  evaluatorId: "example-evaluator",
  async evaluate(input) {
    return buildSignedEvaluationRun(input);
  },
});

const execution = await runEvaluator(evaluator, input, options);
console.log(execution.verified.summary);
```

The SDK also provides `createSignedProtocolObject`, exact-byte and protocol-object digest helpers, and a conformance runner. EvalDossier-owned orchestration does not register evaluators, persist keys, initiate network requests, establish institutional trust, or authorize economic action. A caller-supplied evaluator may use the network and remains outside that guarantee.

See the [SDK guide](./docs/SDK.md) and the executable [reference integration](./examples/sdk/reference-evaluator.mjs).

## Standalone agent plugins

EvalDossier packages the same closed verification semantics as two independent, installable plugins:

- [Codex plugin](./plugins/evaldossier/) with `$evaldossier:verify`;
- [Claude Code plugin](./claude-plugins/evaldossier/) with `/evaldossier:verify`.

Both contain a byte-identical generated runtime, all seven committed schemas, only the five public synthetic conformance fixtures they need, exact dependency licenses, and a digest manifest. They work when copied outside this repository and do not require `dist/`, `node_modules`, npm installation, a server, or network access at runtime. Host-specific launchers configure identity only; neither can change pin policy, non-claims, path rejection, semantic projection, conformance behavior, or the economic boundary.

Both plugins require an expected audience and nonce before dossier inspection and retain `CALLER_DECLARED_NOT_VERIFIED`: matching pins do not prove how the caller obtained them. They reject URL, UNC/network-root, prefixed Windows device-namespace, and reserved Win32 device-alias paths before dossier access. This is a lexical boundary, not proof that a drive, mount, or ancestor reparse point has local backing. Agent-facing output exposes typed fields while committing free-form dossier text, local paths, and downstream errors by SHA-256 rather than reflecting attacker-controlled strings.

Codex transports one strict JSON line through structured non-TTY stdin while the shell command stays fixed. Claude Code writes one exact JSON request through its structured Write tool and invokes a fixed plugin-root command. Its fixed request slot does not support concurrent invocations in one workspace. Strict request parsing rejects duplicate or unknown fields, malformed or oversized JSON, linked files, unsupported versions, and invalid sources before dossier access. Tests assert equivalent verification semantics across both hosts except for the integration identifier.

Build and exercise both standalone payloads:

```bash
npm run plugins:check
```

Install from this repository after the plugin files are merged into the repository's default branch:

```text
codex plugin marketplace add miguel-herrero-systems/evaldossier
codex plugin add evaldossier@hrevn-evaldossier

claude plugin marketplace add miguel-herrero-systems/evaldossier
claude plugin install evaldossier@hrevn-evaldossier
```

The generated bundle records one narrow runtime-code-generation caveat: Ajv compiles only committed schemas. EvalDossier executes no caller-supplied code and performs no evaluator discovery, but it does not claim that the current bundle contains no runtime-generated validator code. See the [Codex specification](./docs/CODEX_INTEGRATION_SPEC.md), [Claude Code specification](./docs/CLAUDE_CODE_INTEGRATION_SPEC.md), and each plugin's `runtime/BUNDLE_MANIFEST.json`.

## What `verify` verifies

The offline verifier checks:

- all six JSON Schema contracts;
- raw file sizes and SHA-256 commitments;
- Ed25519 detached-JWS signatures and key-thumbprint bindings;
- request, profile, evidence, manifest and attestation cross-bindings;
- exact-input digest and byte-length equality between request commitments and evidence;
- evaluator identity and execution mode against the enclosed manifest;
- declared basis eligibility and the resulting obligation verdict;
- exact criterion coverage, per-predicate basis binding and one-to-one evidence-file coverage;
- for supported normalization records, that the declared source pointer resolves to the committed `nativeValue` and that the mapping policy identifier and normalized result are signed;
- path confinement, file limits and the absence of uncommitted files.

An external consumer can pin the intended dossier context:

```bash
node dist/src/cli.js verify <dossier-directory> \
  --audience <expected-audience> \
  --nonce <expected-nonce>
```

These options pin the audience and nonce in the signed top-level dossier; a mismatch is rejected. The relying party must obtain the expected values independently rather than copy them from the dossier under verification. `PINNED` means that the supplied expected value matched; the verifier cannot prove how the caller obtained it. The enclosed historical objects may carry other signed audiences, while the request and attestation must still agree with each other. Without `--audience`, the summary reports `Audience binding: UNPINNED`; without `--nonce`, it reports `Dossier nonce binding: UNPINNED`. Signer trust remains `UNPINNED` in either case.

`verify` does **not** re-execute the evaluator's predicate or a general normalization mapping, authenticate a demo key as a real organization, establish factual truth, or authorize payment. The canonical formal predicate is executed when `demo` builds its attestation; independent replay is a separate operation and is not implied by a successful dossier verification.

## What signatures mean here

A valid signature establishes control of a signing key and integrity of the signed payload. Across the signed binding chain, a normalizer commits to source-byte digests, mapping-policy identifier, source pointer, native value and normalized result that it declares. This makes alteration detectable; it does not prove that a general mapping program was executed or that the declared mapping is semantically correct.

A signature also does **not** establish that:

- a model judgment is factually correct;
- the signer is institutionally independent;
- a source is authoritative for a commercial obligation;
- or funds should be released or refunded.

Every attestation therefore declares its result basis. The economic action is fixed to `OUT_OF_SCOPE`.

Read the standalone essay, [Supported by What?](./docs/PROOF_JUDGMENT_DECLARATION.md), and the [protocol guide](./docs/PROTOCOL.md).

The essay includes a [related-work and scope boundary](./docs/PROOF_JUDGMENT_DECLARATION.md#related-work-and-scope-boundary) covering adjacent dossier, offline-trust, and cryptographically verifiable evaluation systems. EvalDossier is not an implementation of the Trust over IP Verifiable Dossiers specification.

## Protocol v0.1 scope

Included:

- six versioned protocol objects;
- Ed25519 detached JWS over RFC 8785/JCS canonical JSON;
- signed audience, nonce, timestamps and key bindings, with optional external audience/nonce pinning at verification time;
- deterministic reference evaluation;
- offline normalization of a project-authored synthetic model-judgment response;
- portable dossier indexes;
- strict offline verification and adversarial tamper tests.

Excluded:

- public API, database, accounts or RBAC;
- remote evaluator execution;
- arbitrary URLs or outbound requests;
- private or personal data;
- escrow, wallets, payment recommendations or settlement;
- rankings, marketplace, staking, token or claims of neutrality.

## Protocol objects

1. Evaluator manifest
2. Profile definition
3. Evaluation request
4. Evidence bundle
5. Evaluation attestation
6. Dossier

JSON Schemas live in [`schemas/`](./schemas/). The implementation rejects duplicate JSON keys before parsing.

## Distribution

The v0.2 tree is shaped as an importable Node.js package with explicit root, SDK, and schema exports. `npm pack` is checked in CI, but `private: true` remains deliberate: EvalDossier is not yet presented as a supported npm-registry release. Registry naming, support guarantees, and supply-chain publication remain separate decisions.

The package policy is a guard against common accidental inclusions and entrypoint drift. It is not a content-level secret scanner or a supply-chain security guarantee.

The repository and package fixtures contain intentionally public deterministic test keys so the demos remain reproducible. They are not production credentials.

## Security

The keys under `fixtures/keys/` are public test fixtures whose private components are intentionally committed for deterministic demos. They must never be used outside this repository.

See [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md).

## Future work

The next host target is an OpenClaw compatibility test against the same standalone runtime, not a third verification implementation. Submission to the public Codex/OpenAI and Claude community directories remains a separate release decision after clean-cache installation testing and final security review. AgentProof remains the observed-session receipt layer; EvalDossier remains the typed evaluation layer. External evaluator adapters will be added only against documented, compatible systems. Production signing requires a separately reviewed external-signer interface. The [control plane, public API, evaluator marketplace and settlement integrations](./docs/FUTURE_CONTROL_PLANE.md) remain explicitly deferred and require separate security and demand evidence.

## Open empirical questions

This artifact establishes a technical vocabulary and a reproducible implementation that make several operational questions more precise. It does not answer them with synthetic evidence:

- How often does a paid agent job fail after a payment rail has successfully charged?
- What does that failure cost, who bears it, and does anyone care enough to pay to prevent it?
- Is there an independent source capable of establishing the relevant obligation?
- Would an operator delegate any real authority to an external attestation?
- Does the defensible value live in evaluation, normalization, audit and exceptions, or would a rail absorb it directly?
- Who would pay for managed execution, observability or retention?

## Contact

Miguel Herrero · contact@hrevn.com
