# EvalDossier SDK 0.2.0

The SDK is a small, local orchestration layer over the EvalDossier protocol 0.1 core. It lets an evaluator author produce a conforming signed run, assemble it into a portable dossier, verify that dossier offline, and assert the declared semantic result without changing the verifier.

Package version `0.2.0` does **not** introduce a new wire protocol. Every object remains `evaldossier/0.1` and uses the schemas published with [tag `v0.1.0`](https://github.com/miguel-herrero-systems/evaldossier/tree/v0.1.0/schemas).

## Design boundary

The SDK makes evaluators executable. It does not make them authoritative.

```text
evaluator implementation
        |
        | EvaluationRun
        v
schema and evaluator-id preflight
        |
        v
optional declared-semantic preflight
        |
        v
signed dossier assembly
        |
        v
offline verification with audience + nonce pinned
        |
        v
verified declared-semantic assertion
```

The evaluator, requester, evidence collector and dossier exporter remain separate signed roles. The SDK does not collapse those roles, register an evaluator globally, discover keys over the network, or decide whether any signer should be trusted.

## Public API

Import the SDK from the explicit subpath:

Until a supported npm release exists, these imports are exercised from a clone after `npm run build`; `npm install evaldossier` is not a supported installation path.

```js
import {
  assertEvaluatorConformance,
  createSignedProtocolObject,
  defineEvaluator,
  runEvaluator,
} from "evaldossier/sdk";
```

The same exports are also available from the package root.

### `createSignedProtocolObject(kind, payload, signingKey)`

Creates one of the five signed objects that can appear in an `EvaluationRun`:

- `evaluator-manifest`
- `profile-definition`
- `evaluation-request`
- `evidence-bundle`
- `evaluation-attestation`

The SDK owns `protocolVersion`, `schemaVersion`, and `proof`. A caller supplies only the role-specific payload. The function snapshots the payload and signing key, signs the isolated object, and validates its schema and signature before returning it.

```js
const profile = await createSignedProtocolObject(
  "profile-definition",
  {
    profileId: "example-profile",
    // Remaining profile fields are required by the protocol schema.
  },
  evaluatorKey,
);
```

Successful creation establishes schema conformance, signature integrity, and control of the supplied key. It does not establish the signer's institutional identity or the truth of the payload.

Helper functions are deliberately narrow:

- `artifactDigest(bytes)` hashes exact source bytes.
- `protocolObjectDigest(object)` hashes a complete signed object.
- `publicSigningKey(privateKey)` derives the public JWK.

They do not persist keys or contact a key service.

### `defineEvaluator(definition)`

Defines a local evaluator or offline adapter as an identifier plus one function that returns a complete `EvaluationRun`.

```js
const evaluator = defineEvaluator({
  evaluatorId: "example-evaluator",
  async evaluate(input) {
    return buildSignedEvaluationRun(input);
  },
});
```

The definition is frozen to prevent accidental replacement in the same process. Freezing is a programming safeguard, not a sandbox or a trust boundary.

### `runEvaluator(evaluator, input, options)`

`runEvaluator` performs one end-to-end local execution:

1. Calls the evaluator.
2. Validates all five run objects against their exact protocol schemas.
3. Requires the definition's evaluator ID to match the signed manifest, request target, and attestation.
4. Creates the dossier in a new output directory.
5. Verifies the finished dossier offline.
6. Pins the verification to the audience and nonce supplied in the dossier options.

The evaluator ID and function are captured once. Options are deeply snapshotted before the evaluator runs, and a returned `EvaluationRun` is deeply snapshotted before asynchronous validation or assembly. Options and runs must therefore be structured-cloneable; the evaluator input is passed through unchanged. These programming safeguards keep one invocation internally consistent, but they are not a sandbox or a defense against other code already executing with access to source files or signing keys.

```js
const execution = await runEvaluator(evaluator, input, {
  outputDirectory: "/new/path/dossier",
  exporterKey,
  dossier: {
    dossierId: "example.dossier.001",
    generatedAt: "2026-07-21T12:00:10Z",
    classification: "INTERNAL_REFERENCE",
    exporterId: "example-exporter",
    audience: "example-consumer",
    nonce: "ZXhhbXBsZS1ub25jZS0wMDAwMDE",
    warnings: [],
  },
});

console.log(execution.verified.summary);
```

The output directory must not already exist. Schema and evaluator-ID failures occur before output is created. A later assembly failure may leave an incomplete directory; callers must treat it as invalid and remove only that exact known target before retrying.

### `assertEvaluatorConformance(...)`

The conformance helper runs the same complete path and optionally asserts the evaluator author's expected:

- atomic bases;
- overall basis;
- predicate statuses;
- obligation verdict.

Expected declared semantics are checked against the validated run before the output directory is created. After assembly, the same expectations are checked again against the fully verified dossier summary. An expectation mismatch therefore leaves no dossier directory; a later assembly or verification failure may still leave an incomplete directory that must be treated as invalid.

The expectation object is closed: unknown or misspelled members are rejected instead of being ignored.

```js
const result = await assertEvaluatorConformance(
  evaluator,
  input,
  options,
  {
    bases: ["FORMAL_PREDICATE"],
    overallBasis: "FORMAL_PREDICATE",
    predicateStatuses: ["ESTABLISHED_TRUE"],
    obligationVerdict: "SATISFIED",
  },
);

console.log(result.status); // PASS
```

A conformance `PASS` means that the signed objects, bindings, declared semantics, and expected result survive the reference verifier. It is not certification of evaluator quality, neutrality, independence, legal identity, factual correctness, or commercial authority.

The executable repository example is [`examples/sdk/reference-evaluator.mjs`](../examples/sdk/reference-evaluator.mjs):

```bash
npm run demo:sdk
```

## Key custody

The SDK accepts private Ed25519 JWK values because signing is part of the local reference implementation. It never writes those private values into a dossier, log, registry, or network request. The public component is embedded where the protocol requires it.

Production integrations should keep private keys outside prompts and model context. An agent such as Codex should invoke a narrowly scoped local signer or external signing service; it should not receive the raw private key. The committed keys under `fixtures/keys/` are intentionally public deterministic test fixtures and must never be reused.

## Network and economic behavior

EvalDossier-owned code performs no evaluator discovery, outbound HTTP requests, payment operations, escrow actions, settlement decisions, rankings, or marketplace registration. A caller-supplied evaluator may perform its own I/O and remains outside this guarantee. `economicAction` remains `OUT_OF_SCOPE` under protocol 0.1.

These omissions are deliberate. A future control plane or agent adapter may call the SDK, but neither can strengthen the evidentiary basis declared by the evaluator.

## Distribution status

Version 0.2 is package-shaped and `npm pack`-verifiable, but the repository retains `private: true`; it is not presented as a supported npm-registry release. This keeps registry naming, long-term support, and supply-chain publication as explicit later decisions.
