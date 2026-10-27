import * as crypto from 'crypto';

// UUIDv7 (RFC 9562 §5.7) — 48-bit big-endian Unix epoch ms, then version, then randomness.
// The layout is what makes these ids sort by creation time, which every LDS list query relies on.
//
//   0                   1                   2                   3
//   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//  |                          unix_ts_ms                           |
//  |          unix_ts_ms           |  ver  |       counter         |
//  |var|                     rand_b (62 bits)                      |
//  |                           rand_b                              |
//  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_NIBBLE_INDEX = 12; // hex[12] is the high nibble of byte 6 = the version field
const MAX_COUNTER = 0xfff;       // 12 bits of rand_a used as a monotonic sub-millisecond counter

// Monotonic state. RFC 9562 §6.2 "fixed-length dedicated counter": ids minted inside the same
// millisecond still sort in creation order, which matters when a migration writes 130 rows in a
// tight loop and every one of them lands in the same tick.
let lastMs = 0;
let counter = 0;

/**
 * Generate a UUIDv7.
 *
 * Deliberately takes NO timestamp argument. The id's embedded time means "when this row entered
 * LDS", and forging it to a business date (e.g. a document's 발급일) would make the meaning of
 * `createdOn` vary per row — roughly half of the legacy documents have no issue date at all, so
 * those rows would silently fall back to "now". Business dates live in their own fields.
 */
export function generateUuidV7(): string {
  const now = Date.now();
  if (now > lastMs) {
    lastMs = now;
    counter = 0;
  } else {
    // Same millisecond, or a clock that stepped backwards. Either way, never go back.
    counter += 1;
    if (counter > MAX_COUNTER) {
      lastMs += 1;
      counter = 0;
    }
  }
  const ms = lastMs;

  const bytes = new Uint8Array(16);
  // 48-bit big-endian timestamp. Math.floor rather than >>> because ms exceeds 32 bits.
  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  const rnd = new Uint8Array(8);
  crypto.getRandomValues(rnd);

  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f); // version 7 + counter high nibble
  bytes[7] = counter & 0xff;                  // counter low byte
  bytes[8] = 0x80 | (rnd[0]! & 0x3f);         // variant 10xx + 6 random bits
  for (let i = 9; i < 16; i++) bytes[i] = rnd[i - 8]!;

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Extract the creation timestamp from a UUIDv7 string, or null if the input is not one.
 *
 * The version check is not decoration. `crypto.randomUUID()` returns a v4, whose first 48 bits are
 * random — parsing those as an epoch yields a plausible-looking Date somewhere in the next few
 * hundred thousand years, and every downstream comparison then fails in a way that looks like a
 * query bug rather than an id bug.
 */
export function extractUuidV7Timestamp(uuidString: string): Date | null {
  if (typeof uuidString !== 'string' || !UUID_SHAPE.test(uuidString)) return null;
  const hex = uuidString.replace(/-/g, '');
  if (hex[VERSION_NIBBLE_INDEX] !== '7') return null;
  const epochMs = parseInt(hex.slice(0, 12), 16);
  if (!Number.isFinite(epochMs)) return null;
  return new Date(epochMs);
}

/**
 * Convert a timestamp (epoch ms) to a UUIDv7 boundary. Useful for querying UUID v7 items by
 * timestamp: the two boundaries bracket every id minted within that millisecond.
 */
export function timestampToUuidV7Boundary(timestamp : Date, startOrEnd : "start" | "end") {
  const tsHex = timestamp.getTime().toString(16).padStart(12, '0');
  const tsPart1 = tsHex.slice(0, 8);
  const tsPart2 = tsHex.slice(8, 12);
  return startOrEnd === "start" ? `${tsPart1}-${tsPart2}-7000-8000-000000000000` : `${tsPart1}-${tsPart2}-7fff-bfff-ffffffffffff`;
}