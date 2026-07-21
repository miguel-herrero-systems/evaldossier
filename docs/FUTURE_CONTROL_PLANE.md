# Future control plane — deliberately not implemented in v0.1

The long-term architecture may add evaluator registration, continuous conformance, job routing, attempts and leases, private artifact handling, operational observations, audit retention and customer-operated settlement adapters.

None of those components belongs in the first public artifact.

Implementation gates:

1. An external builder implements an evaluator or adapter.
2. Repeated remote execution creates an orchestration need.
3. An operator asks for managed retention, observability or audit export.
4. A security review precedes any public API.
5. Any settlement integration begins in testnet, remains outside the protocol kernel and receives separate legal review before managed production use.

The intended commercial boundary is an open protocol and verifier below, interchangeable evaluators in the middle, and an optional managed control plane above. A marketplace is not planned until independent buyers repeatedly select between evaluators operated by independent organizations.
