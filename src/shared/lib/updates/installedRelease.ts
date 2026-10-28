function hasReleaseField(payload: unknown): payload is { release?: unknown } {
  return !!payload && typeof payload === 'object' && !Array.isArray(payload);
}

/** A release is a non-negative safe integer; every update surface reads releases through this one check. */
export function isReleaseNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * The installed release from a raw Runtime health payload. The vendored Runtime
 * types do not declare `release`, so it is read here as an unknown field.
 * Absent or malformed values are unknown and return undefined.
 */
export function installedReleaseOf(payload: unknown): number | undefined {
  if (!hasReleaseField(payload)) return undefined;
  const { release } = payload;
  return isReleaseNumber(release) ? release : undefined;
}
