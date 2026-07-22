# EvalDossier for Claude Code

This standalone Claude Code plugin verifies portable signed EvalDossier directories offline and runs a fixed synthetic evaluator-conformance path.

Prerequisite: Node.js `>=20.11` available as `node`.

The installed plugin includes its complete runtime, schemas and intentionally public test fixtures. It performs no runtime package installation, evaluator discovery, network request, session capture, wallet access, payment movement or settlement.

Invoke `/evaldossier:verify` and supply the expected audience and nonce separately from the dossier. Review the bundled [Skill](./skills/verify/SKILL.md), [bundle manifest](./runtime/BUNDLE_MANIFEST.json), [third-party notices](./runtime/THIRD_PARTY_NOTICES.md), and [license](./LICENSE) before use.

During verification, the Skill writes one request to `./.evaldossier-local/claude-code-request.json`. This file is local contextual transport, not encrypted or secret storage: never place credentials, private keys, wallet material or other secrets in it. Concurrent verification invocations in one workspace are unsupported; do not reuse stale request contents, and remove only this exact local request file when it is no longer needed.

## Install from this repository

After this plugin directory has been merged into the repository's default branch:

```text
claude plugin marketplace add miguel-herrero-systems/evaldossier
claude plugin install evaldossier@hrevn-evaldossier
```

## Security boundary

`PINNED` establishes equality with caller-supplied values, not independent provenance. Signatures establish integrity and key control, not truth, evaluator neutrality, legal identity, authority or payment entitlement. Economic action remains out of scope.

The bundled Ajv validator generates code at runtime from committed protocol and synthetic-reference schemas. It does not compile caller-selected schemas in the verification path, load caller-supplied code or discover evaluator modules.
