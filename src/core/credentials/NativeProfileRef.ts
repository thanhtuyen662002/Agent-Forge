/**
 * Parsed and validated opaque Native Profile Reference.
 * Represents a pointer to a provider CLI's isolated profile configuration
 * without reading, copying, or containing OAuth token payloads.
 */
export class NativeProfileRef {
  private readonly scheme: string;
  private readonly provider: string;
  private readonly profileId: string;
  private readonly rawUri: string;

  constructor(scheme: string, provider: string, profileId: string, rawUri: string) {
    this.scheme = scheme;
    this.provider = provider;
    this.profileId = profileId;
    this.rawUri = rawUri;
  }

  public getScheme(): string {
    return this.scheme;
  }

  public getProvider(): string {
    return this.provider;
  }

  public getProfileId(): string {
    return this.profileId;
  }

  public toUriString(): string {
    return `${this.scheme}://${this.provider}/${this.profileId}`;
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

  const provider = pathPart.slice(0, slashIndex).trim().toLowerCase();
  const profileId = pathPart.slice(slashIndex + 1).trim();

  if (!provider || provider.length === 0) {
    throw new Error(`[NativeProfileRef] Malformed native profile reference "${trimmed}": provider cannot be empty.`);
  }

  if (!/^[a-z0-9_-]+$/.test(provider)) {
    throw new Error(
      `[NativeProfileRef] Malformed native profile reference "${trimmed}": provider "${provider}" contains invalid characters.`
    );
  }

  if (!profileId || profileId.length === 0) {
    throw new Error(`[NativeProfileRef] Malformed native profile reference "${trimmed}": profileId cannot be empty.`);
  }

  // Reject path traversal
  if (profileId.includes('..')) {
    throw new Error(`[NativeProfileRef] Malformed native profile reference "${trimmed}": path traversal is forbidden.`);
  }

  // Reject nested slashes or backslashes in profileId
  if (profileId.includes('/') || profileId.includes('\\')) {
    throw new Error(
      `[NativeProfileRef] Malformed native profile reference "${trimmed}": profileId cannot contain path separators.`
    );
  }

  // Reject whitespace or control characters
  if (/\s/.test(profileId) || /[\x00-\x1f\x7f]/.test(profileId)) {
    throw new Error(
      `[NativeProfileRef] Malformed native profile reference "${trimmed}": profileId contains invalid whitespace or control characters.`
    );
  }

  // Validate allowed characters: alphanumeric, hyphen, underscore, period
  if (!/^[a-zA-Z0-9_.-]+$/.test(profileId)) {
    throw new Error(
      `[NativeProfileRef] Malformed native profile reference "${trimmed}": profileId "${profileId}" contains invalid characters.`
    );
  }

  return new NativeProfileRef(scheme, provider, profileId, `${scheme}://${provider}/${profileId}`);
}

/**
 * Checks whether a raw string is a valid native profile reference URI.
 */
export function isValidNativeProfileRef(raw: string): boolean {
  try {
    parseNativeProfileRef(raw);
    return true;
  } catch {
    return false;
  }
}
