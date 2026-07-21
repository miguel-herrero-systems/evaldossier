# Security policy

EvalDossier v0.1 is intentionally offline. It does not expose a server, make outbound network requests, execute untrusted code, hold credentials or move funds.

## Reporting

Please report security issues privately to **contact@hrevn.com**. Do not include sensitive third-party data in a report unless necessary and authorized.

## Supported scope

The current security boundary covers:

- strict JSON parsing and duplicate-key rejection;
- schema validation;
- canonicalization and detached-JWS verification;
- digest and object-binding verification;
- safe relative dossier paths;
- rejection of unknown signature algorithms and protocol versions.

## Fixture keys

All private keys under `fixtures/keys/` are deterministic demo material. They are compromised by definition and must never be trusted outside the included fixtures.

## Explicit non-claims

Successful verification does not establish truth, neutrality, institutional independence, legal authority, payment entitlement or production security.
