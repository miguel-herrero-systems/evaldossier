/** JSON values accepted by the EvalDossier canonicalization boundary. */
export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface Digest extends JsonObject {
  algorithm: "sha-256";
  value: string;
}

export interface PublicEd25519Jwk extends JsonObject {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
  alg: "EdDSA";
  use: "sig";
}

export interface PrivateEd25519Jwk extends PublicEd25519Jwk {
  d: string;
}

/** Short aliases used by evaluator implementations. */
export type PublicJwk = PublicEd25519Jwk;
export type PrivateJwk = PrivateEd25519Jwk;

export interface SignatureProof extends JsonObject {
  type: "evaldossier.detached-jws/0.1";
  jws: string;
}

export interface SignedProtocolObject extends JsonObject {
  protocolVersion: "evaldossier/0.1";
  schemaVersion: string;
  proof: SignatureProof;
}

export interface SourceArtifact {
  artifactId: string;
  role:
    | "DELIVERABLE"
    | "SCHEMA"
    | "UPSTREAM_REQUEST"
    | "UPSTREAM_RESPONSE"
    | "CAPTURE_METADATA"
    | "REDACTION_MANIFEST"
    | "SUPPORTING_EVIDENCE"
    | "POLICY";
  sourcePath: string;
  dossierPath: string;
  mediaType: string;
}

/** Output shared by native evaluators and offline normalization adapters. */
export interface EvaluationRun {
  manifest: JsonObject;
  profile: JsonObject;
  request: JsonObject;
  evidenceBundle: JsonObject;
  attestation: JsonObject;
  sourceArtifacts: SourceArtifact[];
}

export const PROTOCOL_VERSION = "evaldossier/0.1" as const;

export const PROTOCOL_SCHEMA_VERSIONS = [
  "evaldossier.evaluator-manifest/0.1",
  "evaldossier.profile-definition/0.1",
  "evaldossier.evaluation-request/0.1",
  "evaldossier.evidence-bundle/0.1",
  "evaldossier.evaluation-attestation/0.1",
  "evaldossier.dossier/0.1",
] as const;

export type ProtocolSchemaVersion = (typeof PROTOCOL_SCHEMA_VERSIONS)[number];

export interface SignatureVerification {
  valid: boolean;
  keyId: string;
  schemaVersion: string;
  protectedHeader: {
    alg: "EdDSA";
    kid: string;
    typ: string;
  };
}
