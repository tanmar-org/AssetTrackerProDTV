import { createHash, timingSafeEqual } from "node:crypto";

// Compare fixed-size digests so an untrusted header cannot change comparison
// timing or trigger timingSafeEqual's unequal-length exception. No secret fallback.
export function matchesSecret(actual: string | null, expected: string | undefined) {
  return Boolean(expected && actual && timingSafeEqual(
    createHash("sha256").update(actual).digest(),
    createHash("sha256").update(expected).digest(),
  ));
}
