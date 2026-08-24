/**
 * Parsed and validated opaque Credential Reference.
 * Represents a reference pointer to an external secure credential store
 * without containing or resolving any secret payload contents.
 *
 * Canonical URI form: `wincred://agentforge/<namespace>/<credential-id...>`
 * Maps deterministically to Windows Credential Manager target `AgentForge:<namespace>:<credential-id>`.
 */
export class CredentialRef {
  readonly #scheme: string;
  readonly #target: string;
  readonly #rawUri: string;
  readonly #windowsTarget: string;

  private constructor(scheme: string, target: string, rawUri: string, windowsTarget: string) {
    this.#scheme = scheme;
    this.#target = target;
    this.#rawUri = rawUri;
    this.#windowsTarget = windowsTarget;
  }

  public static parse(raw: string): CredentialRef {
    return parseCredentialRef(raw);
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

  /**
   * Internal constructor helper for validated factory/parser.
   * @internal
   */
  public static _createInternal(scheme: string, target: string, rawUri: string, windowsTarget: string): CredentialRef {
    return new CredentialRef(scheme, target, rawUri, windowsTarget);
  }
}

/**
 * Validates and parses a raw credential reference URI string into a canonical CredentialRef.
 * Canonical format: `wincred://agentforge/<namespace>/<credential-id...>`
 */
export function parseCredentialRef(raw: string): CredentialRef {
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
  const target = schemeMatch[2];

  if (scheme !== 'wincred') {
    throw new Error(`[CredentialRef] Unsupported credential scheme "${scheme}". Supported schemes: "wincred".`);
  }

  if (!target || target.trim().length === 0) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": target path cannot be empty.`);
  }

  // Reject whitespace
  if (/\s/.test(target)) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": target contains whitespace.`);
  }

  // Reject backslashes
  if (target.includes('\\')) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": backslashes are forbidden.`);
  }

  // Reject colons (prevents aliasing Windows target separator)
  if (target.includes(':')) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": colons are forbidden in target path.`);
  }

  // Enforce mandatory "agentforge/" namespace prefix
  if (!target.toLowerCase().startsWith('agentforge/')) {
    throw new Error(
      `[CredentialRef] Malformed credential reference "${trimmed}": target must start with canonical namespace "agentforge/".`
    );
  }

  // Extract path segments after "agentforge/"
  const afterNamespace = target.slice('agentforge/'.length);
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

  const segments = afterNamespace.split('/');
  for (const seg of segments) {
    if (!seg || seg.length === 0) {
      throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": empty path segment.`);
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(seg)) {
      throw new Error(
        `[CredentialRef] Malformed credential reference "${trimmed}": segment "${seg}" contains invalid characters.`
      );
    }
  }

  const canonicalTarget = `agentforge/${segments.join('/')}`;
  const canonicalUri = `wincred://${canonicalTarget}`;
  const windowsTarget = `AgentForge:${segments.join(':')}`;

  return CredentialRef._createInternal(scheme, canonicalTarget, canonicalUri, windowsTarget);
}

/**
 * Checks whether a raw string is a valid canonical credential reference URI.
 */
export function isValidCredentialRef(raw: string): boolean {
  try {
    parseCredentialRef(raw);
    return true;
  } catch {
    return false;
  }
}
