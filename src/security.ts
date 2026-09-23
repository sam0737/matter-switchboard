import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApiKeyRecord, Scope } from "./model.js";

export function createSecret(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

export function verifier(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function matches(secret: string, expectedVerifier: string): boolean {
  const actual = Buffer.from(verifier(secret), "hex");
  const expected = Buffer.from(expectedVerifier, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function bearer(request: {
  headers: { authorization?: string | undefined };
}): string | undefined {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return undefined;
  return value.slice(7).trim() || undefined;
}

export function findApiKey(records: ApiKeyRecord[], secret: string): ApiKeyRecord | undefined {
  const digest = verifier(secret);
  return records.find(
    (record) => record.revokedAt === null && matchesDigest(digest, record.verifier),
  );
}

function matchesDigest(digest: string, expectedVerifier: string): boolean {
  const actual = Buffer.from(digest, "hex");
  const expected = Buffer.from(expectedVerifier, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function canRead(scope: Scope): boolean {
  return scope === "read" || scope === "control";
}
