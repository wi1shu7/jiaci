import { createHash, timingSafeEqual } from "node:crypto";

/** Both modes are exclusive. Unknown settings fail closed instead of falling back. */
export type AuthMode = "email" | "api_key";

export function getAuthMode(): AuthMode {
  const mode = (process.env.AUTH_MODE ?? "email").trim().toLowerCase();
  if (mode === "email" || mode === "api_key") return mode;
  throw new Error("AUTH_MODE must be email or api_key");
}

/** For API-key mode, the server holds one 256-bit random key as 64 hex chars. */
export function verifyPrivateApiKey(candidate: string): boolean {
  const configured = (process.env.AUTH_API_KEY ?? "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(configured)) {
    throw new Error("AUTH_API_KEY must be a 64-character hexadecimal key in api_key mode");
  }
  // Hash both sides to make the timing-safe buffers an equal, constant length.
  const a = createHash("sha256").update(candidate, "utf8").digest();
  const b = createHash("sha256").update(configured, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** Account identity for study records, NOT an email login or delivery address. */
export function getPrivateUserEmail(): string {
  const email = (process.env.AUTH_PRIVATE_USER ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new Error("AUTH_PRIVATE_USER must be an email-formatted user identifier");
  }
  return email;
}
