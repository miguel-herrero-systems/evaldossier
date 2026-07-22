# EvalDossier for Codex

This standalone, skills-only Codex plugin verifies portable signed EvalDossier directories offline and runs a fixed synthetic evaluator-conformance path.

Prerequisite: Node.js `>=20.11` available as `node`.

The installed plugin includes its complete runtime, schemas and intentionally public test fixtures. It does not install npm packages at runtime, load third-party evaluators, initiate network requests, capture Codex sessions, access wallets, settle payments or infer audience/nonce pins from a dossier.

Invoke `$evaldossier:verify` and supply the expected audience and nonce separately from the dossier. The Skill transports request data through a unique strict-JSON request file created with structured tooling; no user-controlled value enters a shell command and no live stdin is required.

## Install from this repository

After this plugin directory has been merged into the repository's default branch:

```text
codex plugin marketplace add miguel-herrero-systems/evaldossier
codex plugin add evaldossier@hrevn-evaldossier
```

Start a new Codex chat after installation. Review the bundled [Skill](./skills/verify/SKILL.md), [bundle manifest](./runtime/BUNDLE_MANIFEST.json), [third-party notices](./runtime/THIRD_PARTY_NOTICES.md), and [license](./LICENSE) before use.

## Security boundary

`PINNED` establishes equality with caller-supplied values, not independent provenance. Signatures establish integrity and key control, not truth, evaluator neutrality, legal identity, authority or payment entitlement. Economic action remains out of scope.

The bundled Ajv validator generates code at runtime from committed protocol and synthetic-reference schemas. It does not compile caller-selected schemas in the verification path, load caller-supplied code or discover evaluator modules.
