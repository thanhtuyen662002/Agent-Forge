import crypto from 'crypto';

/**
 * Explicit secret-bearing container.
 * Encapsulates sensitive credentials in memory using true runtime-private
 * `#secret` storage to guarantee that standard property reflection,
 * object spreading, JSON serialization, and Node.js inspection hooks
 * always redact the secret payload to `[REDACTED_SECRET]`.
 */
export class SecretValue {
  #secret: string;

  constructor(secret: string) {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error('[SecretValue] Secret must be a non-empty string.');
    }
    this.#secret = secret;
  }

  /**
   * Explicit intentional accessor for the raw secret payload.
   * Must only be called at the direct point of provider authorization/dispatch.
   */
  public exposeSecret(): string {
    return this.#secret;
  }

  /**
   * Returns length of secret without revealing contents.
   */
  public get length(): number {
    return this.#secret.length;
  }

  /**
   * Redacted string representation.
   */
  public toString(): string {
    return '[REDACTED_SECRET]';
  }

  /**
   * Redacted JSON serialization.
   */
  public toJSON(): string {
    return '[REDACTED_SECRET]';
  }

  /**
   * Node.js custom inspection hook.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return '[REDACTED_SECRET]';
  }

  /**
   * Constant-time equality comparison between two SecretValues.
   */
  public equals(other: SecretValue): boolean {
    if (!other || !(other instanceof SecretValue)) {
      return false;
    }
    const bufA = Buffer.from(this.#secret, 'utf8');
    const bufB = Buffer.from(other.exposeSecret(), 'utf8');
    if (bufA.length !== bufB.length) {
      return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
  }
}

/**
 * Redacts known secret substrings from a given text message.
 */
export function redactSecretString(text: string, secretToRedact: string | SecretValue): string {
  if (!text) return text;
  const rawSecret = secretToRedact instanceof SecretValue ? secretToRedact.exposeSecret() : secretToRedact;
  if (!rawSecret || rawSecret.length === 0) return text;
  return text.split(rawSecret).join('[REDACTED_SECRET]');
}

/**
 * Sanitizes an arbitrary object or error message by ensuring no SecretValue instances
 * or raw secret strings leak.
 */
export function safeFormatDiagnostic(errorOrMessage: unknown, knownSecrets: Array<string | SecretValue> = []): string {
  let result = '';
  if (errorOrMessage instanceof Error) {
    result = errorOrMessage.message;
  } else if (typeof errorOrMessage === 'string') {
    result = errorOrMessage;
  } else {
    try {
      result = JSON.stringify(errorOrMessage);
    } catch {
      result = String(errorOrMessage);
    }
  }

  for (const secret of knownSecrets) {
    result = redactSecretString(result, secret);
  }

  return result;
}
