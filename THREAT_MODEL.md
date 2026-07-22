# Threat model

## Assets

- Integrity and provenance of each protocol object.
- Binding between request, profile, evidence, evaluator and attestation.
- Honest representation of the epistemic basis of a result.
- Portability and offline verifiability of a dossier.
- Clear separation from economic action.

## Trust boundaries

- Embedded fixture keys prove only control of those fixture keys.
- The evaluator controls its conclusion and may be wrong or malicious.
- Data represented as an upstream response is not ground truth; without portable source authentication, even its named origin is only recorder-attested.
- The dossier exporter packages objects; it does not upgrade their truth.
- A dossier tree may be attacker-supplied, but v0.1 verification assumes that tree is a static snapshot and is not concurrently mutated by another process while verification runs.
- The top-level dossier's signed audience and nonce are self-declared protocol data unless the consumer supplies expected values out of band. Historical enclosed objects may use different audiences; only request and attestation are required to agree internally.
- The SDK runs a caller-supplied evaluator function in the caller's process. `defineEvaluator` freezes a JavaScript object but is not a sandbox, capability boundary or code-authenticity check.
- Caller-supplied signing keys exist in process memory while signing. The SDK does not persist them, but it cannot protect them from other code already executing in that process.
- The Codex and Claude Code Skills are natural-language behavioral controls. A model can disobey them, use a lower-level command, inspect a dossier too early, or misstate where it obtained an expected audience or nonce.
- The shared agent runtime can verify equality with caller-supplied context and record a declared pin source. It cannot observe a model's prior context or prove that a matching value was obtained independently rather than copied from the dossier.
- Codex relies on the host's structured non-TTY process and stdin tools. Its Skill must stop if those channels are unavailable rather than move request data into shell syntax.
- Claude Code's Bash surface accepts a command string rather than structured argv. Its Skill therefore moves user-controlled values through a strict request file written by a structured tool and invokes one fixed plugin-root command. The runtime can validate that file, but cannot prove the model avoided another shell path or that a parent directory was not redirected before Write.
- Installed plugin code, the host-supplied plugin root/cache, the host Node executable and environment are trusted distribution boundaries. The generated payload detects source/build drift through committed hashes; it does not make a compromised plugin manager or cache trustworthy.
- Ajv generates validator functions from bundled committed schemas at runtime. This is not caller-supplied evaluator execution, but it is runtime code generation and remains visible in the bundle's machine-readable manifest.
- A valid dossier signature authenticates free-form strings but does not make them trusted instructions. Model-visible wrapper output is a separate trust boundary from cryptographic verification.
- A filesystem path can name a remote resource or device without using a URI scheme, notably through Windows UNC syntax, prefixed device namespaces, reserved legacy aliases, mapped drives, mounts, and reparse points.

## Principal threats

- JSON duplicate-key ambiguity.
- Signature substitution or algorithm downgrade.
- Modification of signed context outside the signature.
- Replay under another audience or request.
- Artifact substitution across dossiers.
- Path traversal through a malicious dossier index.
- Mapping an upstream `pass` or `supported` value to factual proof.
- Treating a signed mapping tuple as proof that a general mapping implementation was executed correctly.
- Presenting a self-assertion as independent evidence.
- Treating an offline demo as external adoption.
- Using an attestation as a payment instruction.
- Treating SDK conformance as evaluator certification or marketplace approval.
- Running an untrusted evaluator implementation in the same process as signing keys.
- Publishing an incomplete dossier directory after an assembly failure.
- Auto-sourcing expected audience or nonce values from the dossier and presenting self-consistency as independent context pinning.
- Presenting an agent pin-source label as verified provenance rather than a caller declaration.
- Bypassing a closed host launcher to invoke unpinned verification or load evaluator code chosen from a path, URL, package or model-generated source.
- Interpolating a dossier path, audience, nonce, source label, or request body into a shell command.
- Supplying an ambiguous, oversized, linked, stale, parent-redirected, or concurrently replaced structured request file.
- Replacing the plugin cache, runtime executable, or host-provided plugin-root value with attacker-controlled code or location.
- Reflecting instruction-like dossier fields or raw verifier errors into the surrounding model context.
- Reaching a network-backed filesystem through UNC, protocol-relative, or device-namespace paths despite the offline claim.

## Current mitigations (SDK v0.2.0, protocol v0.1)

- Strict parsing before schema or signature verification.
- One mandatory signature suite: Ed25519 detached JWS with JCS payloads.
- Audience, nonce, timestamps, issuer and key bindings live in the signed payload.
- Every artifact is bound by raw-byte SHA-256 and size.
- Dossier paths are normalized, relative and confined to the dossier root.
- Result basis, evaluator conclusion and evidentiary status are separate fields.
- Upstream responses are preserved by digest and mapping policy version.
- Supported normalization records bind the declared source pointer and `nativeValue` to a signed result; this checks the committed tuple, not arbitrary mapping execution.
- Consumers may pin the expected top-level dossier audience and nonce. Without them, the verifier reports the corresponding audience or dossier-nonce binding as `UNPINNED`; signer trust is a separate property and remains unpinned.
- `economicAction` is schema-fixed to `OUT_OF_SCOPE`.
- No EvalDossier-owned network client, dynamic plugin discovery, remote storage or signing-key persistence; caller-supplied evaluator I/O is outside this guarantee.
- The SDK owns protocol envelope fields, validates every run object before assembly, binds the executable definition to signed evaluator identities, and pins the finished dossier's audience and nonce during immediate verification.
- The repository source integrations and standalone Codex/Claude Skills require expected audience and nonce values before dossier inspection, refuse to infer missing values, and route supported operations through thin launchers over one shared runtime.
- The standalone packages contain a byte-identical runtime, schemas, public synthetic fixtures, dependency licenses and a digest manifest. Their checks run each plugin from an isolated copy without `dist/`, `node_modules`, package installation or network access.
- The shared runtime validates both pins and their closed source labels before resolving or reading the dossier, requires JSON output, rejects URLs, syntactically network-backed roots, prefixed device namespaces, reserved Win32 device aliases, and evaluator/module options, and always reports pin provenance as `CALLER_DECLARED_NOT_VERIFIED`.
- Codex uses one bounded JSON line over structured stdin and a fixed relative command executed from the Skill directory; no request value enters shell syntax.
- Claude Code uses one fixed project-relative local request path. Its documented command uses only the host-provided plugin root and contains no dossier, pin, source-label, project-path or session value. The runtime opens and reads the final request through one checked handle and rejects duplicate, missing, extra, malformed, oversized, unsupported, symbolic-linked, and hard-linked inputs before dossier access. Concurrent verification invocations in one workspace are unsupported.
- Agent-facing results are fixed typed projections. Free-form dossier identifiers, audience text, warnings, local and request paths, and downstream errors are represented by counts or SHA-256 commitments rather than emitted verbatim.
- Host conformance paths execute only the fixed bundled reference evaluator with intentionally public fixture keys and refuse to overwrite an existing output directory.
- Package checks require the SDK exports and schemas while excluding compiled tests and common local-only paths.

## Residual limitations

Cryptography cannot prove that an organization is independent, that a model is correct, that a declared mapping program really ran, or that a source has contractual authority. Those relationships require external evidence, replay, and governance not present in v0.1.

The filesystem checks reject traversal, symlinks, hardlinks, unexpected files and byte mismatches at the points where they are inspected. They do not create an atomic snapshot of the whole directory. A hostile process with concurrent write access may still introduce time-of-check/time-of-use races between directory enumeration and later reads. Verify only an immutable snapshot, a read-only copy, or a directory whose mutation is otherwise excluded for the duration of verification.

`runEvaluator` requires a new output path and prevalidates protocol schemas and evaluator identity before creating it. A failure during later dossier assembly may still leave a partial directory. It must not be published or interpreted as a dossier; remove only that exact known target before retrying.

The Skills and shared runtime cannot establish pin independence. Every successful pinned verification necessarily compares equal values, so equality cannot distinguish an independently supplied pin from one copied by a model. The integrations therefore expose declared source provenance with the fixed assurance `CALLER_DECLARED_NOT_VERIFIED`; consumers must not upgrade that declaration into proof. A relying party that needs stronger provenance must deliver expected context through a separately authenticated channel outside these integrations.

The Claude request file is neither encrypted nor protected as secret storage. This repository ignores it, but an arbitrary host workspace may track it unless the user adds `.evaldossier-local/` to local ignore rules. Reading the final component from one checked handle narrows but does not eliminate races involving parent directories, mounts, or privileged mutation. Do not place secrets in it; use a trusted local workspace and remove only the exact known local request when its retention is no longer wanted.

Lexical path rejection cannot establish physical storage locality. A drive letter may map to a UNC share, and a path that appears local may cross a network mount or an ancestor reparse point configured outside the dossier tree. EvalDossier does not query mount topology or claim to exclude those operating-system configurations; the caller must select a genuinely local trusted volume.

Commitments to suppressed free-form text are not a confidentiality mechanism: a predictable warning or path may be guessed and hashed. They exist only to make omission explicit and allow correlation without placing raw attacker-controlled strings in the model-facing result. Human review of those strings must happen outside the agent context.
