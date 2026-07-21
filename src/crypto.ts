import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  timingSafeEqual,
  verify as ed25519Verify,
  type JsonWebKey as NodeJsonWebKey,
} from "node:crypto";

import { canonicalBytes, canonicalString, withoutProof } from "./canonical.js";
import { parseJsonStrict } from "./json.js";
import type {
  JsonObject,
  PrivateEd25519Jwk,
  PublicEd25519Jwk,
  SignatureProof,
  SignatureVerification,
} from "./types.js";

export const PROOF_TYPE = "evaldossier.detached-jws/0.1" as const;
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export class SignatureError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SignatureError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new SignatureError(
      "UNEXPECTED_MEMBERS",
      `${label} must contain exactly ${wanted.join(", ")}`,
    );
  }
}

function decodeBase64urlStrict(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
    throw new SignatureError("INVALID_BASE64URL", `${label} is not unpadded base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new SignatureError("NON_CANONICAL_BASE64URL", `${label} is not canonically encoded`);
  }
  return decoded;
}

function minimalPublicJwk(
  key: Pick<PublicEd25519Jwk, "kty" | "crv" | "x">,
): NodeJsonWebKey {
  return { kty: key.kty, crv: key.crv, x: key.x };
}

function minimalPrivateJwk(key: PrivateEd25519Jwk): NodeJsonWebKey {
  return { kty: key.kty, crv: key.crv, x: key.x, d: key.d };
}

function assertPublicJwk(value: unknown): asserts value is PublicEd25519Jwk {
  if (!isRecord(value)) {
    throw new SignatureError("INVALID_KEY", "public key must be a JSON object");
  }
  assertExactKeys(value, ["alg", "crv", "kid", "kty", "use", "x"], "public JWK");
  if (
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    value.alg !== "EdDSA" ||
    value.use !== "sig" ||
    typeof value.x !== "string" ||
    typeof value.kid !== "string" ||
    !BASE64URL_32_BYTES.test(value.x) ||
    !BASE64URL_32_BYTES.test(value.kid)
  ) {
    throw new SignatureError("INVALID_KEY", "JWK must be an Ed25519 signing key with canonical x and kid");
  }
  if (decodeBase64urlStrict(value.x, "JWK x").byteLength !== 32) {
    throw new SignatureError("INVALID_KEY", "Ed25519 JWK x must encode 32 bytes");
  }
  const thumbprint = jwkThumbprintUnchecked(value as unknown as PublicEd25519Jwk);
  if (value.kid !== thumbprint) {
    throw new SignatureError("KID_THUMBPRINT_MISMATCH", "JWK kid is not its RFC 7638 thumbprint");
  }
}

function assertPrivateJwk(value: unknown): asserts value is PrivateEd25519Jwk {
  if (!isRecord(value)) {
    throw new SignatureError("INVALID_KEY", "private key must be a JSON object");
  }
  assertExactKeys(value, ["alg", "crv", "d", "kid", "kty", "use", "x"], "private JWK");
  if (typeof value.d !== "string" || !BASE64URL_32_BYTES.test(value.d)) {
    throw new SignatureError("INVALID_KEY", "Ed25519 JWK d must be canonical unpadded base64url");
  }
  if (decodeBase64urlStrict(value.d, "JWK d").byteLength !== 32) {
    throw new SignatureError("INVALID_KEY", "Ed25519 JWK d must encode 32 bytes");
  }

  const publicPart: PublicEd25519Jwk = {
    kty: value.kty as "OKP",
    crv: value.crv as "Ed25519",
    x: value.x as string,
    kid: value.kid as string,
    alg: value.alg as "EdDSA",
    use: value.use as "sig",
  };
  assertPublicJwk(publicPart);

  let derivedX: string | undefined;
  try {
    const privateKey = createPrivateKey({
      key: minimalPrivateJwk(value as unknown as PrivateEd25519Jwk),
      format: "jwk",
    });
    const exported = createPublicKey(privateKey).export({ format: "jwk" });
    derivedX = exported.x;
  } catch (error) {
    throw new SignatureError(
      "INVALID_KEY",
      `private JWK cannot be imported (${error instanceof Error ? error.message : "unknown error"})`,
    );
  }
  if (derivedX !== value.x) {
    throw new SignatureError("PRIVATE_PUBLIC_MISMATCH", "private JWK d does not correspond to x");
  }
}

function jwkThumbprintUnchecked(jwk: Pick<PublicEd25519Jwk, "crv" | "kty" | "x">): string {
  const members = { crv: jwk.crv, kty: jwk.kty, x: jwk.x };
  return createHash("sha256").update(canonicalBytes(members)).digest("base64url");
}

/** RFC 7638 SHA-256 thumbprint of an Ed25519 public JWK. */
export function jwkThumbprint(
  jwk: Pick<PublicEd25519Jwk, "crv" | "kty" | "x">,
): string {
  if (
    jwk.kty !== "OKP" ||
    jwk.crv !== "Ed25519" ||
    typeof jwk.x !== "string" ||
    !BASE64URL_32_BYTES.test(jwk.x) ||
    decodeBase64urlStrict(jwk.x, "JWK x").byteLength !== 32
  ) {
    throw new SignatureError("INVALID_KEY", "thumbprint input must be an Ed25519 public JWK");
  }
  return jwkThumbprintUnchecked(jwk);
}

export function publicJwkFromPrivate(privateJwk: PrivateEd25519Jwk): PublicEd25519Jwk {
  assertPrivateJwk(privateJwk);
  return {
    kty: "OKP",
    crv: "Ed25519",
    x: privateJwk.x,
    kid: privateJwk.kid,
    alg: "EdDSA",
    use: "sig",
  };
}

function payloadKeyIds(payload: JsonObject): string[] {
  const ids: string[] = [];
  if (typeof payload.signingKeyId === "string") {
    ids.push(payload.signingKeyId);
  }
  const evaluator = payload.evaluator;
  if (isRecord(evaluator) && typeof evaluator.keyId === "string") {
    ids.push(evaluator.keyId);
  }
  for (const memberName of ["requester", "collector", "publisher", "exporter"] as const) {
    const signer = payload[memberName];
    if (isRecord(signer) && isRecord(signer.key) && typeof signer.key.kid === "string") {
      ids.push(signer.key.kid);
    }
  }
  return [...new Set(ids)];
}

function assertPayloadBinding(payload: JsonObject, kid: string): string {
  if (payload.protocolVersion !== "evaldossier/0.1") {
    throw new SignatureError("INVALID_PROTOCOL_VERSION", "signed payload has an unsupported protocolVersion");
  }
  if (typeof payload.schemaVersion !== "string" || payload.schemaVersion.length === 0) {
    throw new SignatureError("MISSING_SCHEMA_VERSION", "signed payload must declare schemaVersion");
  }
  const keyIds = payloadKeyIds(payload);
  if (keyIds.length === 0) {
    throw new SignatureError("MISSING_KEY_BINDING", "signed payload does not bind a signing key ID");
  }
  if (keyIds.some((payloadKid) => payloadKid !== kid)) {
    throw new SignatureError(
      "KEY_BINDING_MISMATCH",
      `payload key binding does not match JWK thumbprint ${kid}`,
    );
  }
  return payload.schemaVersion;
}

function protectedHeader(schemaVersion: string, kid: string): {
  alg: "EdDSA";
  kid: string;
  typ: string;
} {
  return { alg: "EdDSA", kid, typ: schemaVersion };
}

function attachProof<T extends JsonObject>(payload: T, proof: SignatureProof): T & { proof: SignatureProof } {
  return { ...payload, proof };
}

/** Sign a protocol object with detached compact JWS over its JCS payload. */
export function signObject<T extends JsonObject>(
  payload: T,
  privateJwk: PrivateEd25519Jwk,
): T & { proof: SignatureProof } {
  if (Object.hasOwn(payload, "proof")) {
    throw new SignatureError("PROOF_ALREADY_PRESENT", "refusing to replace an existing proof");
  }
  assertPrivateJwk(privateJwk);
  const schemaVersion = assertPayloadBinding(payload, privateJwk.kid);
  const header = protectedHeader(schemaVersion, privateJwk.kid);
  const encodedHeader = canonicalBytes(header).toString("base64url");
  const encodedPayload = canonicalBytes(payload).toString("base64url");
  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");

  let signature: Buffer;
  try {
    const key = createPrivateKey({ key: minimalPrivateJwk(privateJwk), format: "jwk" });
    signature = ed25519Sign(null, signingInput, key);
  } catch (error) {
    throw new SignatureError(
      "SIGNING_FAILED",
      error instanceof Error ? error.message : "Ed25519 signing failed",
    );
  }
  if (signature.byteLength !== 64) {
    throw new SignatureError("SIGNING_FAILED", "Ed25519 signature was not 64 bytes");
  }
  return attachProof(payload, {
    type: PROOF_TYPE,
    jws: `${encodedHeader}..${signature.toString("base64url")}`,
  });
}

function signedPayload(value: unknown): { payload: JsonObject; proof: SignatureProof } {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new SignatureError("INVALID_PAYLOAD", "signed protocol object must be a JSON object");
  }
  const proof = value.proof;
  if (!isRecord(proof)) {
    throw new SignatureError("MISSING_PROOF", "signed protocol object has no proof object");
  }
  assertExactKeys(proof, ["jws", "type"], "proof");
  if (proof.type !== PROOF_TYPE || typeof proof.jws !== "string") {
    throw new SignatureError("INVALID_PROOF", `proof must use ${PROOF_TYPE}`);
  }
  if (proof.jws.length > 1024) {
    throw new SignatureError("INVALID_PROOF", "proof JWS exceeds the 1024-character protocol limit");
  }
  return {
    payload: withoutProof(value as JsonObject),
    proof: proof as unknown as SignatureProof,
  };
}

/**
 * Verify an object using only the explicitly supplied public key. No key URL or
 * other network resolution mechanism is supported.
 */
export function verifyObjectSignature(
  value: unknown,
  publicJwk: PublicEd25519Jwk,
): SignatureVerification {
  assertPublicJwk(publicJwk);
  const { payload, proof } = signedPayload(value);
  const schemaVersion = assertPayloadBinding(payload, publicJwk.kid);
  const parts = proof.jws.split(".");
  if (parts.length !== 3 || parts[1] !== "" || parts[0] === undefined || parts[2] === undefined) {
    throw new SignatureError("INVALID_COMPACT_JWS", "proof JWS must use detached compact serialization");
  }

  const headerBytes = decodeBase64urlStrict(parts[0], "JWS protected header");
  const parsedHeader = parseJsonStrict(headerBytes, "JWS protected header");
  if (!isRecord(parsedHeader)) {
    throw new SignatureError("INVALID_PROTECTED_HEADER", "protected header must be a JSON object");
  }
  assertExactKeys(parsedHeader, ["alg", "kid", "typ"], "JWS protected header");
  if (
    parsedHeader.alg !== "EdDSA" ||
    parsedHeader.kid !== publicJwk.kid ||
    parsedHeader.typ !== schemaVersion
  ) {
    throw new SignatureError(
      "PROTECTED_HEADER_MISMATCH",
      "protected header must bind EdDSA, the JWK thumbprint and payload schemaVersion",
    );
  }

  const expectedHeader = protectedHeader(schemaVersion, publicJwk.kid);
  const canonicalHeaderBytes = canonicalBytes(expectedHeader);
  if (
    headerBytes.byteLength !== canonicalHeaderBytes.byteLength ||
    !timingSafeEqual(headerBytes, canonicalHeaderBytes)
  ) {
    throw new SignatureError("NON_CANONICAL_HEADER", "protected header JSON is not canonical JCS");
  }

  if (!BASE64URL_SIGNATURE.test(parts[2])) {
    throw new SignatureError("INVALID_SIGNATURE_ENCODING", "Ed25519 signature must be canonical base64url");
  }
  const signature = decodeBase64urlStrict(parts[2], "JWS signature");
  if (signature.byteLength !== 64) {
    throw new SignatureError("INVALID_SIGNATURE_ENCODING", "Ed25519 signature must encode 64 bytes");
  }

  const encodedPayload = canonicalBytes(payload).toString("base64url");
  const signingInput = Buffer.from(`${parts[0]}.${encodedPayload}`, "ascii");
  let valid: boolean;
  try {
    const key = createPublicKey({ key: minimalPublicJwk(publicJwk), format: "jwk" });
    valid = ed25519Verify(null, signingInput, key, signature);
  } catch (error) {
    throw new SignatureError(
      "VERIFICATION_FAILED",
      error instanceof Error ? error.message : "Ed25519 verification failed",
    );
  }

  return {
    valid,
    keyId: publicJwk.kid,
    schemaVersion,
    protectedHeader: expectedHeader,
  };
}

/** Compatibility aliases for early evaluator code. */
export const signProtocolObject = signObject;
export const verifyDetachedJws = verifyObjectSignature;
