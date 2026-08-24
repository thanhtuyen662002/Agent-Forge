/**
 * Parsed and validated opaque Credential Reference.
 * Represents a reference pointer to an external secure credential store
 * without containing or resolving any secret payload contents.
 */
export class CredentialRef {
  private readonly scheme: string;
  private readonly target: string;
  private readonly rawUri: string;

  constructor(scheme: string, target: string, rawUri: string) {
    this.scheme = scheme;
    this.target = target;
    this.rawUri = rawUri;
  }

  public getScheme(): string {
    return this.scheme;
  }

  public getTarget(): string {
    return this.target;
  }

  /**
   * Generates a deterministic Windows Credential Manager target name under the AgentForge namespace.
   */
  public getWindowsTargetName(): string {
    // Normalize target path segments into a clean Windows Credential target name: AgentForge:<segment1>:<segment2>
    const normalizedTarget = this.target.replace(/^[/\\]+|[/\\]+$/g, '').replace(/[/\\]+/g, ':');
    if (normalizedTarget.toLowerCase().startsWith('agentforge:')) {
      return 'AgentForge:' + normalizedTarget.slice('agentforge:'.length);
    }
    return `AgentForge:${normalizedTarget}`;
  }

  public toUriString(): string {
    return `${this.scheme}://${this.target}`;
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
 * Validates and parses a raw credential reference URI string.
 * Supported schemes: `wincred://`
 */
export function parseCredentialRef(raw: string): CredentialRef {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error('[CredentialRef] Credential reference must be a non-empty string.');
  }

  const trimmed = raw.trim();
  const match = trimmed.match(/^([a-zA-Z0-9_-]+):\/\/(.*)$/);
  if (!match) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": missing valid "scheme://" prefix.`);
  }

  const scheme = match[1].toLowerCase();
  const target = match[2];

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

  // Reject directory traversal segments (".." or "/../")
  if (/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(target)) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": path traversal is forbidden.`);
  }

  // Reject consecutive slashes or trailing slashes
  if (/[/\\]{2,}/.test(target)) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": consecutive slashes are forbidden.`);
  }
  if (/[/\\]$/.test(target)) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": trailing slashes are forbidden.`);
  }

  // Validate allowed characters: alphanumeric, hyphen, underscore, period, colon, forward slash
  if (!/^[a-zA-Z0-9_\-./:]+$/.test(target)) {
    throw new Error(`[CredentialRef] Malformed credential reference "${trimmed}": target contains invalid characters.`);
  }

  return new CredentialRef(scheme, target, `${scheme}://${target}`);
}

/**
 * Checks whether a raw string is a valid credential reference URI.
 */
export function isValidCredentialRef(raw: string): boolean {
  try {
    parseCredentialRef(raw);
    return true;
  } catch {
    return false;
  }
}
