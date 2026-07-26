# EvalDossier for OpenClaw

This is the native OpenClaw distribution of EvalDossier's offline verifier.

The native command:

```text
/evaldossier-check .evaldossier-local/verify-request.json
```

loads a caller-created structured request from the active agent workspace and
runs the bundled verifier locally. OpenClaw plugin commands bypass the LLM.
The plugin does not select or call a model provider, make network requests,
require an API key, or authorize payment.

Package and protocol identifiers serve different scopes:

- npm package: `@miguel-herrero-systems/evaldossier-openclaw@0.2.1`;
- OpenClaw manifest/config ID: `evaldossier`;
- result integration ID: `evaldossier-openclaw-plugin/0.1`;
- EvalDossier protocol: `evaldossier/0.1`.

The request file uses `evaldossier.local-verification-request/0.1`:

```json
{
  "schemaVersion": "evaldossier.local-verification-request/0.1",
  "dossier": "incoming/dossier",
  "audience": "caller-supplied-audience",
  "nonce": "caller-supplied-nonce",
  "audienceSource": "user-request",
  "nonceSource": "user-request"
}
```

Both the request and dossier must resolve canonically inside the active
workspace. Symlinks, parent traversal, network references, and unsupported
request fields fail closed.

The result checks integrity and the dossier's declared evidentiary basis. It
does not establish external truth, identity, authority, work quality, or
payment entitlement.

EvalDossier-owned package code is MIT-licensed. Bundled third-party components
retain their original licenses and notices under `runtime/`.
