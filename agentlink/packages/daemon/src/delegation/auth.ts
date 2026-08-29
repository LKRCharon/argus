import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  DelegationJobRequestSchema,
  type DelegationConfig,
  type DelegationJobRequest,
  type DelegationPrincipal,
  type DelegationProjectPolicy,
} from "./schemas";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MAX_AUTHORIZATION_HEADER_BYTES = 128;

/**
 * A newly issued token can be revealed exactly once. JSON serialization only
 * exposes its digest, so accidentally persisting the issuance object cannot
 * write the bearer credential to disk.
 */
export class IssuedDelegationToken {
  readonly tokenHash: string;
  #plaintext: string | undefined;

  constructor(plaintext: string) {
    this.#plaintext = plaintext;
    this.tokenHash = hashPrincipalToken(plaintext);
  }

  takePlaintext(): string {
    const plaintext = this.#plaintext;
    if (!plaintext) throw new Error("delegation token plaintext is no longer available");
    this.#plaintext = undefined;
    return plaintext;
  }

  toJSON(): { tokenHash: string } {
    return { tokenHash: this.tokenHash };
  }

  toString(): string {
    return "[REDACTED delegation token]";
  }
}

export function generatePrincipalToken(): IssuedDelegationToken {
  return new IssuedDelegationToken(randomBytes(32).toString("base64url"));
}

export function hashPrincipalToken(token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new Error("delegation token has an invalid format");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Authenticates an already-bounded Bearer credential. Every configured digest
 * is compared with timingSafeEqual before a result is selected; callers receive
 * no distinction between an unknown, expired, or revoked credential.
 */
export function authenticateBearer(
  authorization: string | null | undefined,
  principals: readonly DelegationPrincipal[],
  now = Date.now(),
): DelegationPrincipal | undefined {
  const token = parseBearerToken(authorization);
  if (!token) return undefined;

  const suppliedDigest = Buffer.from(hashPrincipalToken(token), "hex");
  let matched: DelegationPrincipal | undefined;
  for (const principal of principals) {
    const expectedDigest = Buffer.from(principal.tokenHash, "hex");
    const equal = expectedDigest.length === suppliedDigest.length
      && timingSafeEqual(expectedDigest, suppliedDigest);
    if (equal) matched = principal;
  }

  if (!matched || matched.revokedAt) return undefined;
  if (matched.expiresAt && Date.parse(matched.expiresAt) <= now) return undefined;
  return structuredClone(matched);
}

export class DelegationAuthorizationError extends Error {
  constructor(readonly code: "project-not-allowed" | "mode-not-allowed" | "domain-not-allowed") {
    super(code);
    this.name = "DelegationAuthorizationError";
  }
}

/** Resolves the fixed project policy after principal, mode, and domain checks. */
export function authorizeDelegationRequest(
  config: DelegationConfig,
  principal: DelegationPrincipal,
  request: DelegationJobRequest,
): DelegationProjectPolicy {
  const parsed = DelegationJobRequestSchema.parse(request);
  if (!principal.projectIds.includes(parsed.projectId)) {
    throw new DelegationAuthorizationError("project-not-allowed");
  }
  const project = config.projects.find((candidate) => candidate.id === parsed.projectId);
  if (!project) throw new DelegationAuthorizationError("project-not-allowed");
  if (!principal.modes.includes(parsed.mode) || !project.allowedModes.includes(parsed.mode)) {
    throw new DelegationAuthorizationError("mode-not-allowed");
  }
  if (parsed.domain && !project.allowedDomains.includes(parsed.domain)) {
    throw new DelegationAuthorizationError("domain-not-allowed");
  }
  return structuredClone(project);
}

function parseBearerToken(authorization: string | null | undefined): string | undefined {
  if (!authorization || Buffer.byteLength(authorization, "utf8") > MAX_AUTHORIZATION_HEADER_BYTES) {
    return undefined;
  }
  const match = /^Bearer[ \t]+([A-Za-z0-9_-]{43})$/i.exec(authorization);
  return match?.[1];
}
