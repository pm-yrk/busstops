/**
 * Deterministic internal identity.
 *
 * Every entity needs a stable internal UUID that survives re-ingestion: the same ATCO code must
 * always produce the same stop UUID, or every daily rebuild would orphan favourites, artifacts
 * and crosswalks. This derives a UUIDv5-shaped identifier from a namespace and a natural key
 * using a pure hash, so it is reproducible across processes without any shared state.
 */

/** FNV-1a 64-bit, expressed with BigInt for a wider spread than the 32-bit variant. */
function fnv1a64(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < value.length; i++) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash;
}

export type IdentityNamespace =
  | "stop"
  | "locality"
  | "operator"
  | "service"
  | "pattern"
  | "journey"
  | "segment"
  | "incident"
  | "vehicle";

/**
 * Stable UUID for a natural key within a namespace. Format-compatible with UUIDv5 (version
 * nibble 5, RFC 4122 variant) so it validates anywhere a UUID is expected.
 */
export function deterministicUuid(namespace: IdentityNamespace, naturalKey: string): string {
  const seed = `${namespace}:${naturalKey}`;
  const high = fnv1a64(seed);
  const low = fnv1a64(`${seed}:${high.toString(16)}`);

  const hex = (high.toString(16).padStart(16, "0") + low.toString(16).padStart(16, "0")).slice(
    0,
    32,
  );
  const bytes = hex.split("");

  // Version 5 and RFC 4122 variant bits.
  bytes[12] = "5";
  const variantNibble = parseInt(bytes[16]!, 16);
  bytes[16] = ((variantNibble & 0x3) | 0x8).toString(16);

  const s = bytes.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

/**
 * Opaque public vehicle reference. Source vehicle identifiers can persist for months, which
 * would let anyone follow one vehicle across days; hashing with a rotating salt keeps live
 * tracking working within a session without creating a durable tracking identifier
 * (docs/14_SECURITY.md "Privacy").
 */
export function opaqueVehicleRef(sourceVehicleId: string, rotationSalt: string): string {
  return fnv1a64(`${rotationSalt}:${sourceVehicleId}`).toString(36);
}

/** Salt that rotates daily, so vehicle references cannot be correlated across service days. */
export function dailyRotationSalt(serviceDate: string, secret: string): string {
  return fnv1a64(`${secret}:${serviceDate}`).toString(36);
}
