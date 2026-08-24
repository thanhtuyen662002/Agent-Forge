/**
 * Validates and canonicalizes a credential reference URI.
 *
 * Microsoft Windows Credential Manager TargetName is case-insensitive.
 * Therefore, AgentForge enforces canonical lowercase transformation for credential paths.
 *
 * Format: `wincred://agentforge/<namespace>/<credential-id...>`
 * Target: `agentforge/<namespace>/<credential-id...>` (all lowercase)
 * Windows Target: `AgentForge:<namespace>:<credential-id...>` (AgentForge prefix with lowercase segments)
 */
function validateAndCanonicalizeCredentialUri(raw: string): {
  scheme: string;
  target: string;
  rawUri: string;
  windowsTarget: string;
} {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('[CredentialRef] Credential reference must be a non-empty string.');
  }

  const trimmed = raw.trim();

  // Validate scheme prefix
  const schemeMatch = trimmed.match(/^([a-zA-Z0-9_-]+):\/\/(.*)$/);
  if (!schemeMatch) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": missing valid "scheme://" prefix.`);
  }

  const scheme = schemeMatch[1].toLowerCase();
  const rawTarget = schemeMatch[2];

  if (scheme !== 'wincred') {
    throw new Error(`[CredentialRef] Unsupported credential scheme "${scheme}". Supported schemes: "wincred".`);
  }

  if (!rawTarget || rawTarget.trim().length === 0) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": target path cannot be empty.`);
  }

  // Reject whitespace
  if (/\s/.test(rawTarget)) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": target contains whitespace.`);
  }

  // Reject backslashes
  if (rawTarget.includes('\\')) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": backslashes are forbidden.`);
  }

  // Reject colons (prevents aliasing Windows target separator)
  if (rawTarget.includes(':')) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": colons are forbidden in target path.`);
  }

  // Enforce mandatory "agentforge/" namespace prefix (case-insensitive input normalized to lowercase)
  if (!rawTarget.toLowerCase().startsWith('agentforge/')) {
    throw new Error(
      `[CredentialRef] Malformed credential reference "${trimmed}": target must start with canonical namespace "agentforge/".`
    );
  }

  // Extract path segments after "agentforge/"
  const afterNamespace = rawTarget.slice('agentforge/'.length);
  if (!afterNamespace || afterNamespace.length === 0) {
    throw new Error(
      `[CredentialRef] Malformed credential reference "${trimmed}": missing credential path under "agentforge/".`
    );
  }

  // Reject directory traversal
  if (/(?:^|\/)\.\.(?:\/|$)/.test(afterNamespace)) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": path traversal is forbidden.`);
  }

  // Reject consecutive slashes or trailing slashes
  if (/\/{2,}/.test(afterNamespace)) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": consecutive slashes are forbidden.`);
  }
  if (afterNamespace.endsWith('/')) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": trailing slashes are forbidden.`);
  }

  const rawSegments = afterNamespace.split('/');
  const canonicalSegments: string[] = [];

  for (const seg of rawSegments) {
    if (!seg || seg.length === 0) {
      throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": empty path segment.`);
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(seg)) {
      throw new Error(
        `[CredentialRef] Malformed credential reference "${trimmed}": segment "${seg}" contains invalid characters.`
      );
    }
    canonicalSegments.push(seg.toLowerCase());
  }

  const canonicalTarget = `agentforge/${canonicalSegments.join('/')}`;
  const canonicalUri = `wincred://${canonicalTarget}`;
  const windowsTarget = `AgentForge:${canonicalSegments.join(':')}`;

  return {
    scheme,
    target: canonicalTarget,
    rawUri: canonicalUri,
    windowsTarget,
  };
}

/**
 * Parsed and validated opaque Credential Reference.
 * Represents a reference pointer to an external secure credential store
 * without containing or resolving any secret payload contents.
 *
 * Canonical URI form: `wincred://agentforge/<namespace>/<credential-id...>`
 * Maps deterministically to Windows Credential Manager target `AgentForge:<namespace>:<credential-id>`.
 *
 * All constructor paths validate and canonicalize input directly.
 * Public unchecked constructor bypass is removed.
 */
export class CredentialRef {
  readonly #scheme: string;
  readonly #target: string;
  readonly #rawUri: string;
  readonly #windowsTarget: string;

  /**
   * Constructs a validated CredentialRef from a URI string.
   * Validates and canonicalizes the input fail-closed.
   */
  constructor(rawUri: string) {
    const validated = validateAndCanonicalizeCredentialUri(rawUri);
    this.#scheme = validated.scheme;
    this.#target = validated.target;
    this.#rawUri = validated.rawUri;
    this.#windowsTarget = validated.windowsTarget;
  }

  public static parse(raw: string): CredentialRef {
    return new CredentialRef(raw);
  }

  public static isValid(raw: string): boolean {
    return isValidCredentialRef(raw);
  }

  public getScheme(): string {
    return this.#scheme;
  }

  public getTarget(): string {
    return this.#target;
  }

  /**
   * Generates the deterministic Windows Credential Manager target name under the AgentForge namespace.
   * Format: `AgentForge:<segment1>:<segment2>...`
   */
  public getWindowsTargetName(): string {
    return this.#windowsTarget;
  }

  public toUriString(): string {
    return this.#rawUri;
  }

  public toString(): string {
    return this.toUriString();
  }

  /**
   * Diagnostic-safe string representation. Guaranteed to contain only pointer metadata.
   */
  public toSafeString(): string {
    return this.toUriString();
  }

  public toJSON(): string {
    return this.toUriString();
  }
}

/**
 * Validates and parses a raw credential reference URI string into a canonical CredentialRef.
 * Canonical format: `wincred://agentforge/<namespace>/<credential-id...>`
 */
export function parseCredentialRef(raw: string): CredentialRef {
  return new CredentialRef(raw);
}

/**
 * Checks whether a raw string is a valid canonical credential reference URI.
 */
export function isValidCredentialRef(raw: string): boolean {
  try {
    new CredentialRef(raw);
    return true;
  } catch {
    return false;
  }
}
