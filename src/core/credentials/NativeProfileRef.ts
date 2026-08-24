/**
 * Validates and canonicalizes a native profile reference URI.
 *
 * AgentForge is Windows-first and profile directories reside on case-insensitive filesystems.
 * Therefore, AgentForge enforces canonical lowercase transformation for provider and profile identifiers
 * to prevent aliasing attacks where different case variants point to the same filesystem directory.
 *
 * Format: `native-profile://<provider>/<profileId>` (all lowercase)
 */
function validateAndCanonicalizeNativeProfileUri(raw: string): {
  scheme: string;
  provider: string;
  profileId: string;
  rawUri: string;
} {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('[NativeProfileRef] Native profile reference must be a non-empty string.');
  }

  const trimmed = raw.trim();
  const match = trimmed.match(/^([a-zA-Z0-9_-]+):\/\/(.*)$/);
  if (!match) {
    throw new Error(`[NativeProfileRef] Malformed native profile reference "${trimmed}": missing valid "scheme://" prefix.`);
  }

  const scheme = match[1].toLowerCase();
  const pathPart = match[2];

  if (scheme !== 'native-profile') {
    throw new Error(`[NativeProfileRef] Unsupported profile scheme "${scheme}". Supported scheme: "native-profile".`);
  }

  const slashIndex = pathPart.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(
      `[NativeProfileRef] Malformed native profile reference "${trimmed}": expected format "native-profile://<provider>/<profileId>".`
    );
  }

  const rawProvider = pathPart.slice(0, slashIndex).trim();
  const rawProfileId = pathPart.slice(slashIndex + 1).trim();

  if (!rawProvider || rawProvider.length === 0) {
    throw new Error(`[NativeProfileRef] Malformed native profile reference "${trimmed}": provider cannot be empty.`);
  }

  const canonicalProvider = rawProvider.toLowerCase();
  if (!/^[a-z0-9_-]+$/.test(canonicalProvider)) {
    throw new Error(
      `[NativeProfileRef] Malformed native profile reference "${trimmed}": provider "${rawProvider}" contains invalid characters.`
    );
  }

  if (!rawProfileId || rawProfileId.length === 0) {
    throw new Error(`[NativeProfileRef] Malformed native profile reference "${trimmed}": profileId cannot be empty.`);
  }

  // Reject path traversal
  if (rawProfileId.includes('..')) {
    throw new Error(`[NativeProfileRef] Malformed native profile reference "${trimmed}": path traversal is forbidden.`);
  }

  // Reject nested slashes or backslashes in profileId
  if (rawProfileId.includes('/') || rawProfileId.includes('\\')) {
    throw new Error(
      `[NativeProfileRef] Malformed native profile reference "${trimmed}": profileId cannot contain path separators.`
    );
  }

  // Reject whitespace or control characters
  if (/\s/.test(rawProfileId) || /[\x00-\x1f\x7f]/.test(rawProfileId)) {
    throw new Error(
      `[NativeProfileRef] Malformed native profile reference "${trimmed}": profileId contains invalid whitespace or control characters.`
    );
  }

  // Validate allowed characters: alphanumeric, hyphen, underscore, period
  if (!/^[a-zA-Z0-9_.-]+$/.test(rawProfileId)) {
    throw new Error(
      `[NativeProfileRef] Malformed native profile reference "${trimmed}": profileId "${rawProfileId}" contains invalid characters.`
    );
  }

  const canonicalProfileId = rawProfileId.toLowerCase();
  const canonicalUri = `native-profile://${canonicalProvider}/${canonicalProfileId}`;

  return {
    scheme,
    provider: canonicalProvider,
    profileId: canonicalProfileId,
    rawUri: canonicalUri,
  };
}

/**
 * Parsed and validated opaque Native Profile Reference.
 * Represents a pointer to a provider CLI's isolated profile configuration
 * without reading, copying, or containing OAuth token payloads.
 *
 * Canonical URI form: `native-profile://<provider>/<profileId>`
 *
 * All constructor paths validate and canonicalize input directly.
 * Public unchecked constructor bypass is removed.
 */
export class NativeProfileRef {
  readonly #scheme: string;
  readonly #provider: string;
  readonly #profileId: string;
  readonly #rawUri: string;

  /**
   * Constructs a validated NativeProfileRef from a URI string.
   * Validates and canonicalizes the input fail-closed.
   */
  constructor(rawUri: string) {
    const validated = validateAndCanonicalizeNativeProfileUri(rawUri);
    this.#scheme = validated.scheme;
    this.#provider = validated.provider;
    this.#profileId = validated.profileId;
    this.#rawUri = validated.rawUri;
  }

  public static parse(raw: string): NativeProfileRef {
    return new NativeProfileRef(raw);
  }

  public static isValid(raw: string): boolean {
    return isValidNativeProfileRef(raw);
  }

  public getScheme(): string {
    return this.#scheme;
  }

  public getProvider(): string {
    return this.#provider;
  }

  public getProfileId(): string {
    return this.#profileId;
  }

  public toUriString(): string {
    return this.#rawUri;
  }

  public toString(): string {
    return this.toUriString();
  }

  public toSafeString(): string {
    return this.toUriString();
  }

  public toJSON(): string {
    return this.toUriString();
  }
}

/**
 * Validates and parses a raw native profile reference URI string.
 * Format: `native-profile://<provider>/<profileId>`
 */
export function parseNativeProfileRef(raw: string): NativeProfileRef {
  return new NativeProfileRef(raw);
}

/**
 * Checks whether a raw string is a valid native profile reference URI.
 */
export function isValidNativeProfileRef(raw: string): boolean {
  try {
    new NativeProfileRef(raw);
    return true;
  } catch {
    return false;
  }
}
