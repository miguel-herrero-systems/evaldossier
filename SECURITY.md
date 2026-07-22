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
- shared agent-wrapper closure, mandatory context pins, declared pin-source labels, strict stdin/file request transports and fixed-evaluator conformance;
- deterministic standalone Codex and Claude plugin payloads, embedded-asset digests and exact-file checks;
- package export and package-content checks.

The SDK invokes the evaluator function supplied by the caller. It does not sandbox that function. Only run evaluator implementations that you have independently chosen to execute under an appropriate process boundary.

The repository source integrations and standalone Codex/Claude plugins invoke thin host launchers over one fixed shared runtime. The standalone packages contain a byte-identical generated runtime, schemas and public synthetic fixtures and require no checkout, `dist/`, `node_modules`, install script or runtime network access. Verification requires an audience, nonce and declared source for each before the runtime reads the dossier. The source labels are restricted to `USER_REQUEST` and `UPSTREAM_CONTEXT`, but remain caller declarations with assurance `CALLER_DECLARED_NOT_VERIFIED`; neither a Skill nor the runtime can prove that a model did not copy a matching value from the dossier. Missing values must produce `INPUT_REQUIRED` rather than inference.

The shared runtime does not load evaluator code from caller-controlled paths, packages or URLs and has no owned network or child-process surface. It rejects URI schemes, UNC/network roots, protocol-relative roots, prefixed Windows device namespaces, and reserved Win32 aliases such as `NUL`, `CON`, and `COM1` before resolving or accessing a path. This lexical rejection cannot prove that a drive letter, mounted volume, or ancestor reparse point is backed by local storage; the caller must exclude mapped drives and network-backed mounts. Its conformance operation uses only the intentionally public repository fixture keys. Do not bypass it with a lower-level unpinned command and describe the result as independently pinned.

Codex creates one unique private directory with the exact fixed command `mktemp -d /tmp/evaldossier-request.XXXXXXXX`, writes one bounded strict-JSON request through the structured `apply_patch` tool, and invokes a request-file operation whose only variable is that system-generated path. The fixed short template contains no user-controlled text, while `mktemp` supplies the unpredictable suffix and creates the directory with private permissions. The Skill then removes exactly the request file and its empty generated directory with non-recursive commands. Claude Code uses one fixed project-relative strict-JSON request file created through its structured Write tool; its command varies only by the host-provided plugin root. No dossier path, pin or source label enters either host's shell command. The runtime opens the final request with no-follow where supported, compares pre-open and opened file identities, reads from the same handle, and rejects duplicate, missing or extra JSON members, malformed or oversized content, unsupported versions, symbolic links and hard links before dossier access. These controls do not prove that either host followed its Skill, that a parent directory was never redirected before the structured write, that the request is confidential, or that a privileged concurrent mutator cannot race the filesystem. Never place secrets in a request. Claude concurrent verification invocations in one workspace remain unsupported; treat `.evaldossier-local/` as sensitive local context and remove only the exact request file after use.

The standalone runtime bundles Ajv. Ajv generates validator functions at runtime from the seven committed protocol schemas and the committed synthetic reference schema. EvalDossier does not accept caller-selected schemas in plugin verification, execute caller-supplied code, or discover evaluator modules, but the current plugin bundle does not claim an absolute absence of runtime code generation. A future standalone-validator build would be a semantic and supply-chain change requiring separate equivalence and security review.

Signed dossier strings remain attacker-controlled data. Projection `evaldossier.model-safe-projection/0.2` separates operation success (`status`) from dossier verification (`verificationStatus`) and from the signed aggregate (`protocolOutcome`). It preserves criterion-scoped signed mappings through typed values and SHA-256 commitments in `criterionResults` rather than emitting raw dossier identifiers, predicate identifiers, reason codes, audience text, warnings, paths, request paths, or downstream verifier errors. Those digests support correlation only; they do not make the committed text true, safe, or confidential. Do not bypass this projection to place raw dossier text in a model context.

## Fixture keys

All private keys under `fixtures/keys/` are deterministic demo material. They are compromised by definition and must never be trusted outside the included fixtures.

## Explicit non-claims

Successful verification or SDK conformance does not establish truth, neutrality, institutional independence, legal authority, payment entitlement or production security.
