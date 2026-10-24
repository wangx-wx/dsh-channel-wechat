/**
 * An admission policy that lets every peer through.
 *
 * The rule itself is only interesting in the suites that test it; the other
 * suites are about routing, replies, cards and shutdown, and would otherwise have
 * to name a peer id in every case to get past a gate that is not what they are
 * examining. Kept out of `src/` on purpose: an exported "admit everyone" helper
 * in production code is the kind of thing a caller reaches for when the real
 * policy is inconvenient.
 */

import type { AccessPolicy } from '../../src/channel/access.ts'

/** The policy the non-access suites use. */
export function openAccess(): AccessPolicy {
  return { allows: () => true, admitsAnyone: () => true }
}
