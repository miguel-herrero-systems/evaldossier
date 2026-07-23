# EvalDossier v0.2.1

This patch release hardens the standalone Codex and Claude Code plugin payloads without changing wire protocol `evaldossier/0.1` or model-safe projection `0.2`.

- Replaces packaged deterministic private test JWKs with fresh Ed25519 role keys generated only in memory for each synthetic conformance invocation.
- Persists only public key components in generated conformance dossiers.
- Adds an independent CI guard that rejects private-key filenames, private PEM blocks and JWK objects with a private `d` member while preserving public verification JWKs.
- Makes the reproducibility boundary explicit: plugin builds remain byte-reproducible; live conformance dossiers intentionally differ in keys, signatures and digests while preserving the same eleven checks and typed semantics.
- Keeps offline verification, caller-supplied audience and nonce pinning, fail-closed behavior and economic inaction unchanged.

The deterministic private JWKs retained in the source repository remain deliberately public test fixtures for source-level demos and are not included in either standalone plugin payload.
