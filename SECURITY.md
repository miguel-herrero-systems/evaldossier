# Security policy

EvalDossier SDK v0.2.0 and protocol v0.1 are intentionally offline. EvalDossier-owned code does not expose a server, initiate outbound network requests, discover or load evaluator plugins, persist credentials, or move funds. A caller-supplied evaluator may perform its own I/O and remains outside this guarantee.

The SDK accepts caller-supplied Ed25519 private keys in memory for local signing. Key generation, storage, rotation, authorization and process isolation remain the caller's responsibility. Never place a production private key in an agent prompt or model context.

## Reporting

Please report security issues privately to **contact@hrevn.com**. Do not include sensitive third-party data in a report unless necessary and authorized.

## Supported scope

The current security boundary covers:

- strict JSON parsing and duplicate-key rejection;
- schema validation;
- canonicalization and detached-JWS verification;
- digest and object-binding verification;
- safe relative dossier paths;
- rejection of unknown signature algorithms and protocol versions;
- SDK protocol-envelope ownership and evaluator-ID binding;
- package export and package-content checks.

The SDK invokes the evaluator function supplied by the caller. It does not sandbox that function. Only run evaluator implementations that you have independently chosen to execute under an appropriate process boundary.

## Fixture keys

All private keys under `fixtures/keys/` are deterministic demo material. They are compromised by definition and must never be trusted outside the included fixtures.

## Explicit non-claims

Successful verification or SDK conformance does not establish truth, neutrality, institutional independence, legal authority, payment entitlement or production security.
