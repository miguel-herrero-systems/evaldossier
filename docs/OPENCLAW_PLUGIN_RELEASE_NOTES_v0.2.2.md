# EvalDossier OpenClaw plugin v0.2.2

This host-only patch documents the recommended OpenClaw plugin allowlist.

After installing the plugin, operators should preserve any existing trusted
plugin IDs and add the EvalDossier manifest ID, `evaldossier`, to
`plugins.allow`. A fresh OpenClaw profile may load an installed plugin while
warning that the allowlist is empty; explicitly pinning the ID is host
hardening and does not grant EvalDossier any additional capability.

The patch does not change the verifier runtime, EvalDossier protocol, native
command behavior, network boundary, model boundary, or economic boundary.
