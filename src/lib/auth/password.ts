import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id password hashing (PRD FR-A1).
 *
 * Defaults from @node-rs/argon2 are argon2id with OWASP-aligned parameters.
 * Verification is constant-time inside the native binding.
 */
export function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain);
  } catch {
    // A malformed stored hash must read as "wrong password", never as a crash
    // that leaks which accounts exist.
    return false;
  }
}
