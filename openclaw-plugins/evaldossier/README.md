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

- npm package: `@miguel-herrero-systems/evaldossier-openclaw@0.2.2`;
- OpenClaw manifest/config ID: `evaldossier`;
- result integration ID: `evaldossier-openclaw-plugin/0.1`;
- EvalDossier protocol: `evaldossier/0.1`.

## Recommended host allowlist

After installation, explicitly add the OpenClaw manifest ID `evaldossier` to
the host's `plugins.allow` list:

```json
{
  "plugins": {
    "allow": ["evaldossier"]
  }
}
```

If the list already contains trusted plugins, preserve those entries and
append `evaldossier` rather than replacing the list. A fresh OpenClaw profile
may load an installed plugin while warning that `plugins.allow` is empty;
pinning the allowed ID is recommended host hardening, not an additional
capability or a requirement imposed by EvalDossier.

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
