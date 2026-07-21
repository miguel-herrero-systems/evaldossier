# EvalDossier — Verifiable Evaluation Evidence for AI Agents

**Offline-verifiable evaluation attestations and portable dossiers for heterogeneous AI-agent evaluators.**

> Status: `v0.1.0` · offline-first · deterministic demos · settlement-independent

EvalDossier is a settlement-independent TypeScript reference implementation for packaging evaluator outputs, evidence, and signatures into dossiers that another system can verify offline. It is designed for AI-agent and agent-commerce workflows that must distinguish formal proof from model judgment or self-assertion before applying any economic policy.

Conceptual rationale: **[Supported by What?](./docs/PROOF_JUDGMENT_DECLARATION.md)** explains why a signed `supported: true` can still mean a formal predicate, a model judgment, or a self-assertion—and why downstream systems must not collapse them.

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

The canonical v0.1 path is a deterministic reference evaluator using `FORMAL_PREDICATE`. It demonstrates that a complete dossier can be generated and checked for its declared integrity and semantics without a server, external identity provider, payment rail, or upstream service.

A second, entirely synthetic path demonstrates a different property: an offline normalizer can preserve a heterogeneous `MODEL_JUDGMENT` without promoting it to factual proof. Every byte in that fixture is authored by this project, uses `SYNTHETIC` provenance, and makes no claim about an external evaluator, integration, production event, adoption, or demand.

## Quick start

```bash
npm ci
npm test
npm run demo
npm run verify:demo
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

These options pin the audience and nonce in the signed top-level dossier; a mismatch is rejected. The enclosed historical objects may carry other signed audiences, while the request and attestation must still agree with each other. Without `--audience`, the summary reports `Audience binding: UNPINNED`; without `--nonce`, it reports `Dossier nonce binding: UNPINNED`. Signer trust remains `UNPINNED` in either case.

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

## v0.1 scope

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

v0.1 is distributed as this GitHub repository, not as a supported npm package. `private: true` is deliberate, and the demo commands depend on fixtures committed with the repository.

## Security

The keys under `fixtures/keys/` are public test fixtures whose private components are intentionally committed for deterministic demos. They must never be used outside this repository.

See [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md).

## Future work

v0.2 targets a small evaluator SDK and conformance kit: a builder should be able to implement an evaluator, generate a conforming signed dossier, and verify it without modifying the core. External adapters will be added only against documented, compatible systems. The control plane, public API, marketplace and settlement integrations remain explicitly deferred and require separate security and demand evidence.

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
