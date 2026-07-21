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
- shared agent-wrapper argument closure, mandatory context pins, declared pin-source labels, strict structured-request transport and fixed-evaluator conformance;
- package export and package-content checks.

The SDK invokes the evaluator function supplied by the caller. It does not sandbox that function. Only run evaluator implementations that you have independently chosen to execute under an appropriate process boundary.

The repository-contained Codex Skill and Claude Code development plugin invoke thin host launchers over one fixed shared runtime. Verification requires an audience, nonce and declared source for each before the runtime reads the dossier. The source labels are restricted to `USER_REQUEST` and `UPSTREAM_CONTEXT`, but remain caller declarations with assurance `CALLER_DECLARED_NOT_VERIFIED`; neither a Skill nor the runtime can prove that a model did not copy a matching value from the dossier. Missing values must produce `INPUT_REQUIRED` rather than inference.

The shared runtime does not load evaluator code from caller-controlled paths, packages or URLs and has no owned network or child-process surface. It rejects URI schemes, UNC/network roots, protocol-relative roots, prefixed Windows device namespaces, and reserved Win32 aliases such as `NUL`, `CON`, and `COM1` before resolving or accessing a path. This lexical rejection cannot prove that a drive letter, mounted volume, or ancestor reparse point is backed by local storage; the caller must exclude mapped drives and network-backed mounts. Its conformance operation uses only the intentionally public repository fixture keys. Do not bypass it with a lower-level unpinned command and describe the result as independently pinned.

Claude Code transports user-supplied paths and pins through one ignored strict-JSON request file because its Bash tool accepts a command string rather than structured argv. The Skill must create that fixed project-relative file with the structured Write tool and then invoke only fixed project-relative commands containing no user-controlled value, host substitution, environment value, project path, or session identifier. The runtime rejects duplicate, missing or extra JSON members, malformed or oversized content, unsupported versions, symbolic links and hard links before dossier access. This does not prove that Claude followed the Skill, that the request file is confidential, or that an attacker with concurrent write access cannot exploit a time-of-check/time-of-use race. Concurrent verification invocations in one checkout are unsupported. Use a trusted local working tree, do not place secrets in the request, and treat `.evaldossier-local/` as sensitive local context even though it is gitignored.

Signed dossier strings remain attacker-controlled data. The shared runtime therefore returns a fixed typed projection and SHA-256 commitments rather than raw dossier identifiers, audience text, warnings, paths, request paths, or downstream verifier errors. Those digests support correlation only; they do not make the committed text true, safe, or confidential. Do not bypass this projection to place raw dossier text in a model context.

## Fixture keys

All private keys under `fixtures/keys/` are deterministic demo material. They are compromised by definition and must never be trusted outside the included fixtures.

## Explicit non-claims

Successful verification or SDK conformance does not establish truth, neutrality, institutional independence, legal authority, payment entitlement or production security.
