# Supported by What?

## Formal predicates, model judgments, and signed assertions in AI-agent evaluation

An AI-agent payment system eventually needs a decision. A buyer may need to know whether an artifact was delivered, a marketplace may need to decide whether an obligation was satisfied, and a settlement rail may need an instruction. It is tempting to compress that chain into one reassuring field:

```json
{
  "claim": "The delivered artifact conforms to schema S",
  "supported": true
}
```

The field looks precise. It is not. The same value could mean that a deterministic validator executed schema `S` over committed bytes, that a model considered the artifact plausibly conformant, or that the provider declared it conformant. Those are three different propositions. They can all be useful. They can all be signed. They do not license the same downstream inference.

`Supported` is not an intrinsic property of a sentence. It is a relation among a proposition, an evidence set, an evaluation method, and a trust model. If that context disappears when a result is serialized, a downstream consumer can accidentally turn an opinion into a fact, an assertion into independent evidence, or a narrow machine check into proof of commercial performance.

EvalDossier starts from a deliberately modest principle:

> Keeping an assessment basis machine-readable and signed is a necessary condition for disciplined automation, not proof that the declared basis is honest or sufficient.

That principle implies **evidentiary non-escalation** at every normalization boundary: an adapter may preserve or weaken an upstream result's declared evidentiary strength, but it must not strengthen that result without additional evidence. Serialization, normalization, and a new signature can improve integrity and interoperability. They cannot, by themselves, convert a model judgment into a formal predicate result or a party's assertion into an independent observation.

EvalDossier does not rank assessment methods by prestige. It keeps the declared method explicit and rejects protocol combinations that would silently promote ineligible bases. It cannot detect an evaluator that dishonestly labels the method it used without replay or stronger proof.

## Three results that only look alike

Consider an agent commissioned to deliver a JSON analysis. The agreement contains both a syntactic requirement and a semantic one: the file must conform to an agreed schema, and its analysis must be relevant and well reasoned.

A schema validator can evaluate the first requirement mechanically. A model may be useful for the second. The provider may also report that the work is complete. A complete dossier may preserve all three results, but it should not flatten them into a common `true` value. These types remain declarations by the signer until a relying party independently establishes their execution or authority; typing prevents semantic collapse, not dishonesty.

| Assessment basis | Honest interpretation | It does not establish by itself |
|---|---|---|
| `FORMAL_PREDICATE` | The evaluator declares a result from a versioned predicate over specifically bound inputs | That the predicate actually ran without replay or proof of execution; that the inputs came from an honest, complete, or independent source; that the specification captured commercial intent |
| `MODEL_JUDGMENT` | The evaluator declares an assessment attributed to a named model or service under a declared rubric and context | That the named process actually ran, factual truth, deterministic reproduction, or a calibrated probability of truth |
| `SELF_ASSERTION` | A party made a statement, possibly authenticated by a bound key | The truth of the statement, the party's independence, or its authority to decide |

These are not three rungs on a quality ladder. A model judgment may be the appropriate mechanism for tone or usefulness. A self-assertion may be operationally important and even contractually decisive. A formal predicate may be perfectly reproducible while checking an inadequate specification. The protocol's job is not to pretend that one basis solves every problem. Its job is to preserve what each basis actually establishes.

## 1. Formal predicate evaluation

EvalDossier uses `FORMAL_PREDICATE` rather than the broader label *formal proof*. In the protocol, the label means that the signer declares a result from a versioned, machine-executable predicate over cryptographically bound inputs:

```text
P_v(I) -> ESTABLISHED_TRUE | ESTABLISHED_FALSE | UNDETERMINED
```

For example, a dossier can bind the exact digest of an artifact, the exact digest of a JSON Schema, the validator and version, and the applicable validation profile. The signed attestation commits its evaluator to a narrow result over those inputs. A third party can separately replay a defined procedure offline; if that independent replay returns the same result, the verifier has its own support for the narrow proposition that those committed bytes do or do not validate under that committed schema and procedure.

EvalDossier's included reference evaluator actually executes its three documented predicates while constructing the formal demo. The general `verify` command does not perform that replay. It validates the schemas, signatures, bytes, declared graph, semantic invariants and obligation aggregation of the enclosed dossier. A successful run proves neither that an arbitrary evaluator executed its declared predicate nor that it labelled its basis honestly. Re-execution or a cryptographic proof of execution is an additional layer.

That is useful evidence. It is not a theorem about the world outside the inputs.

The artifact might have been acquired from the wrong endpoint. A provider might have supplied only the favorable portion of a larger dataset. A passing test suite might omit the behavior the buyer actually cared about. Two parties might have agreed on a predicate that is easy to game. None of those limitations changes the deterministic result; each limits what can responsibly be inferred from it.

This produces two important rules. First, `ESTABLISHED_FALSE` and `UNDETERMINED` are not synonyms. The former means that the committed procedure established the negative result. The latter means that the proof obligation was not met: evidence may be absent, incomplete, unsupported, or outside the procedure's scope. Second, the established proposition must be written narrowly enough to remain true. “These bytes validate under schema `S`” is defensible. “The provider fulfilled the commercial agreement” generally requires additional premises.

Formal evaluation is therefore powerful precisely because it is bounded. A formal predicate can also prove the wrong specification with perfect reproducibility.

## 2. Model judgment

A model judgment has a different shape:

```text
J(model, rubric, context, input) -> label, score, rationale
```

This procedure can address questions that a fixed predicate cannot: Is the answer relevant? Is an explanation coherent? Does a design satisfy a qualitative brief? Is the output likely to contain a contradiction? Such judgments may be commercially valuable. Their usefulness does not turn them into formal entailments.

An honest model-derived result should preserve, when available, the model or upstream service, version, rubric digest, evidence mode, input bindings, relevant inference settings, and declared limitations. It should also distinguish an upstream confidence score from a calibrated probability. A number between zero and one is an output of a measurement procedure; it is not automatically the probability that a proposition is true.

Showing evidence to a model does not automatically promote the model's synthesis to formal proof. If a mixed pipeline verifies some claims mechanically and asks a model to interpret others, each atomic result should retain its own basis. Basis is claim-scoped, not merely dossier-scoped.

EvalDossier consequently separates two fields that interfaces often conflate:

- `assessment` records what the evaluator concluded: `AFFIRMED`, `REJECTED`, or `INCONCLUSIVE`.
- `predicateStatus` records whether an eligible method established the requested predicate: `ESTABLISHED_TRUE`, `ESTABLISHED_FALSE`, or `UNDETERMINED`.

A favorable model assessment can therefore be represented without semantic inflation:

```json
{
  "basis": "MODEL_JUDGMENT",
  "assessment": "AFFIRMED",
  "predicateStatus": "UNDETERMINED"
}
```

This does not say that the model was wrong. It says that the protocol has not silently reclassified a judgment as a formally established predicate.

## 3. Assertion and self-attestation

An assertion records that an actor said something. “Mere assertion” does not mean worthless; it means that no evidentiary upgrade has been established beyond the act of assertion.

A valid cryptographic signature narrows and strengthens that record, but only in specific ways. At the cryptographic layer, it establishes that a signature verifies under public key `k` over message `m`. Attribution to a named person, service, or agent depends on a separate key binding and assumptions about key control. The truth of `m`, the signer's independence, and the signer's authority are separate questions.

If a provider signs `job_status=completed`, a verifier may be able to establish that the bound provider key signed those bytes. It cannot infer from the signature alone that the job was completed. A separate key or hostname also does not prove independent control. Independence concerns governance and incentives, not cryptographic formatting.

Authority is different again. The parties may appoint an evaluator whose signed decision is contractually sufficient for a later settlement policy. In that case the decision can be operationally authoritative without becoming a formal proof of an external fact. Contractual authority can make a judgment sufficient for settlement without making the underlying proposition formally proven.

This distinction is especially important in agent-to-agent systems. Automation does not eliminate trust merely because a statement is signed. It makes the location of trust easier to miss unless identity, authentication, independence, authority, and evidentiary basis remain separate.

## A synthetic interface example

The repository includes a deliberately synthetic source response to make the serialization problem executable without making claims about an external evaluator. Its fictional model judge emits `supported: true` for a qualitative claim and for the statement that a response contains no factual errors, while also declaring that no evidence was supplied and no deterministic predicate ran.

Those values are not presented as a model failure or a factual observation about any provider. They are project-authored test inputs. Their purpose is to show that the same native boolean can be preserved without acquiring a stronger meaning:

```json
{
  "basis": "MODEL_JUDGMENT",
  "assessment": "AFFIRMED",
  "predicateStatus": "UNDETERMINED"
}
```

If a payment policy consumed the synthetic `supported: true` as “factually established,” the policy would add a proposition that the source record never established. The safe response is not to ban model judgment. It is to preserve its type and evidentiary boundary.

## The offline adapter boundary

EvalDossier's model-judgment adapter operates only over project-authored synthetic fixtures. It makes no live API call and has no external provider dependency.

The adapter preserves the committed source bytes, the native field and JSON pointer, the adapter mapping-policy identifier and version, and the normalized result. Its signed binding chain commits the adapter to that tuple. For the mapping records in v0.1, the verifier can resolve the pointer against the committed synthetic response and confirm that it equals the declared `nativeValue`. It cannot infer merely from those checks that a general mapping implementation executed or that the named policy was followed correctly.

Its own signature has the same boundary:

> An adapter's signature commits to captured-byte digests, a mapping-policy identifier, source pointer, native value and normalized result. It makes alteration of that declaration detectable; it does not prove execution or correctness of a general mapping program, and it does not make the upstream conclusion more truthful, independent, or authoritative.

This leads to a monotonicity rule for adapters: normalization may preserve or weaken an upstream claim; it must never strengthen it without additional evidence. An upstream `supported: true` produced by a no-evidence model path may become `assessment: AFFIRMED` with `basis: MODEL_JUDGMENT` and `predicateStatus: UNDETERMINED`. It must not become `ESTABLISHED_TRUE` merely because an adapter serialized and signed it.

This optional fixture is deliberately replaceable. It establishes neither external interoperability nor demand. Removing it would remove one normalization example, not the protocol's native evaluator, dossier generator or verifier.

## Audience is a relying-party input

Signing an audience and nonce prevents undetected edits, but it does not show that the named audience actually requested the evaluation. A producer can sign any string. Historical objects may also retain different signing contexts; only request and attestation audiences must agree internally. The relying party must obtain its expected top-level dossier audience and nonce independently and supply them to verification. A mismatch is then rejected. Without an expected audience, verification reports `Audience binding: UNPINNED`; without an expected nonce, it reports `Dossier nonce binding: UNPINNED`. Signer trust is a separate question and remains `UNPINNED` even when both context values match.

## Four layers before money moves

Agent-payment systems often collapse a longer reasoning chain into one verdict. EvalDossier keeps four concepts separate:

```text
assessment
    -> predicateStatus
        -> obligationVerdict
            -> economic action
```

**`assessment`** answers: What did this evaluator conclude under its declared method?

**`predicateStatus`** answers: Was the requested predicate established true, established false, or left undetermined by a basis eligible under the profile?

**`obligationVerdict`** answers: After applying the signed profile's aggregation and basis-eligibility rules, was the contractual obligation `SATISFIED`, `NOT_SATISFIED`, or `INCONCLUSIVE`?

**Economic action** answers: What should a payment or escrow system do—if anything—because of that obligation verdict?

The implications do not run automatically. `AFFIRMED` is not `ESTABLISHED_TRUE`. `ESTABLISHED_TRUE` is not necessarily `SATISFIED`; an obligation can contain several criteria or a different aggregation policy. `SATISFIED` is not automatically `RELEASE`; the economic policy may include time windows, caps, appeals, or no automated payment action at all.

EvalDossier v0.1 fixes economic action to `OUT_OF_SCOPE`. It produces portable evidence and typed conclusions, not payment instructions. A future settlement adapter may consume an obligation verdict under a separately agreed policy, but it should not be able to erase the basis and limitations that produced it.

## Related work and scope boundary

EvalDossier shares foundational boundaries with adjacent work. In particular, cryptographic integrity is not factual truth, and offline verification of a signature does not by itself establish the signer's institutional identity, independence, or authority. This project does not claim those principles as novel. Its specific focus is how they constrain the normalization and downstream use of heterogeneous AI-agent evaluation results.

The [Trust over IP Verifiable Dossiers draft](https://trustoverip.github.io/kswg-dossier-specification/) defines the data model, lifecycle, and verification semantics for cryptographically attested collections of evidence structured as Authentic Chained Data Containers (ACDCs) in the KERI ecosystem. It expressly distinguishes attestation to a dossier's integrity and composition from attestation to the veracity of claims inside the evidence. EvalDossier shares that evidentiary boundary but does not implement the ToIP specification, KERI, ACDC, CESR, key-event logs, dossier revocation, or its curator and issuer roles. EvalDossier instead defines evaluator-specific protocol objects, claim-scoped assessment bases, basis-eligibility rules, obligation aggregation, and portable normalization across heterogeneous evaluators.

South et al. package zero-knowledge computational proofs of model evaluation into *verifiable evaluation attestations* in [“Verifiable evaluations of machine learning models using zkSNARKs”](https://arxiv.org/abs/2402.02675). That work cryptographically proves a defined model computation over bound inputs. EvalDossier's current verifier does not prove evaluator execution. It verifies the integrity and internal semantics of declared evaluation artifacts and keeps replay or a cryptographic proof of execution as a separate evidentiary layer. A future `CRYPTOGRAPHIC_PROOF` basis could describe such a layer without collapsing it into the transport format itself.

[Vouchsafe](https://arxiv.org/abs/2601.02254) constructs a self-contained, offline-verifiable identity and capability graph from signed, content-addressed statements. It addresses identity, delegation, revocation, and capability resolution without online infrastructure. EvalDossier also supports local verification from presented data, but it deliberately leaves signer trust unpinned and does not provide an identity, delegation, or revocation substrate. Its graph binds evaluator requests, evidence, profiles, attestations, and declared semantics rather than resolving authority from a capability graph.

Against that background, EvalDossier's design focus is narrower:

1. assessment basis is mandatory, claim-scoped, and signed;
2. adapters follow evidentiary non-escalation—preserve or weaken, never strengthen without additional evidence;
3. `assessment`, `predicateStatus`, `obligationVerdict`, and economic action remain separate layers whose implications do not run automatically; and
4. heterogeneous evaluator results can be normalized into a portable dossier without erasing their original evidentiary limits.

These are protocol design choices and implementation boundaries, not a claim of academic priority. The cited systems solve adjacent problems and may supply evidence or trust mechanisms that a future integration could reference without being replaced by EvalDossier.

## Protocol consequences

The distinction among proof, judgment, and declaration is not documentation polish. It changes the safe shape of the protocol.

1. Assessment basis must be mandatory, claim-scoped, and covered by the signature.
2. A generic boolean such as `supported` must not be the normalized semantic core.
3. Formal negative results and insufficient evidence must remain distinct.
4. Authentication, identity, independence, and authority must be represented as separate properties or limitations.
5. Mixed pipelines must retain the basis of each atomic result; one verified tool call cannot launder a model synthesis into formal proof. Their aggregate basis is `MIXED` when the criteria actually requested span multiple bases.
6. Confidence must carry its scale and calibration status. Upstream-reported, unverified confidence must say so.
7. Adapters must commit the retained response, native value, mapping path, policy identifier and normalized result, and must never silently increase epistemic strength. This commitment is not proof that a general mapping implementation ran correctly.
8. The profile—not the evaluator alone—must define which bases are eligible to establish each predicate and how predicate statuses aggregate into an obligation verdict.
9. Economic action must remain a separate policy decision.
10. Every dossier must expose limitations in machine-readable form as well as human-readable prose.

The protocol can support additional bases, including `AUTHORITATIVE_OBSERVATION`, `CRYPTOGRAPHIC_PROOF`, and `HEURISTIC`. The same discipline applies. A cryptographic proof verifies a defined relation; it does not guarantee that its private inputs faithfully represent the world. An authoritative observation derives force from a precommitted authority relationship and defined scope, not from an assumption of universal truth. A heuristic may be useful while remaining non-conclusive.

## Conclusion

EvalDossier cannot make weak evidence strong. It can keep a declared basis and its limitations attached to a signed result, making accidental semantic inflation easier to detect. It cannot prevent a malicious evaluator from misdeclaring its method without independent replay or stronger proof.

A formal predicate remains relative to its bound inputs and declared procedure. A model judgment remains a judgment, even when it is useful and confidently expressed. A signed assertion remains an assertion, even when its authenticity is established. An authorized evaluator may legitimately control a later policy without becoming an oracle of objective truth.

Once those types survive normalization, signing, and transport, downstream systems can choose deliberately. They can require formal predicates for machine-checkable obligations, explicitly accept model judgment for qualitative work, appoint an authority where judgment is unavoidable, or decline to automate when evidence is inconclusive.

Without those types, automation does not remove trust. It obscures where trust entered.
