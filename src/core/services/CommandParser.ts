export interface ParsedCommand {
  executable: string;
  args: string[];
}

export class CommandParser {
  /**
   * Parses a single-line command string into structured executable and args without invoking a shell.
   *
   * Grammar & Semantics:
   * 1. Whitespace (' ' or '\t') separates tokens outside quotes.
   * 2. Quoting:
   *    - A token starting with '"' is double-quoted until a matching '"'.
   *    - A token starting with "'" is single-quoted until a matching "'".
   *    - Inside quotes, whitespace is preserved and all backslashes ('\') are literal.
   * 3. Literal Apostrophes / Quotes in Unquoted Tokens:
   *    - Unquoted tokens (e.g. O'Reilly's.js, param='val') preserve all characters literally.
   *    - Quote characters mid-token are never silently stripped or deleted.
   * 4. Native Windows backslash path separators ('\') and UNC paths ('\\server\share') are literal and preserved.
   * 5. Returns null for empty or whitespace-only input.
   * 6. Throws an Error on unterminated quotation marks or control characters.
   */
  public static parse(rawInput: string): ParsedCommand | null {
    const trimmed = rawInput.trim();
    if (!trimmed) {
      return null;
    }

    // Reject control characters (0x00 - 0x1F, except standard spaces/tabs)
    if (/[\x00-\x08\x0A-\x1F]/.test(trimmed)) {
      throw new Error('Command contains invalid control characters.');
    }

    const tokens: string[] = [];
    let i = 0;
    const len = trimmed.length;

    while (i < len) {
      // Skip whitespace outside quotes
      while (i < len && (trimmed[i] === ' ' || trimmed[i] === '\t')) {
        i++;
      }
      if (i >= len) break;

      const firstChar = trimmed[i];

      if (firstChar === '"') {
        // Double-quoted token
        i++; // skip opening quote
        let token = '';
        let closed = false;
        while (i < len) {
          if (trimmed[i] === '"') {
            closed = true;
            i++; // skip closing quote
            break;
          }
          token += trimmed[i];
          i++;
        }
        if (!closed) {
          throw new Error('Command contains unterminated quotation mark.');
        }
        tokens.push(token);
      } else if (firstChar === "'") {
        // Single-quoted token
        i++; // skip opening quote
        let token = '';
        let closed = false;
        while (i < len) {
          if (trimmed[i] === "'") {
            closed = true;
            i++; // skip closing quote
            break;
          }
          token += trimmed[i];
          i++;
        }
        if (!closed) {
          throw new Error('Command contains unterminated quotation mark.');
        }
        tokens.push(token);
      } else {
        // Unquoted token: read until whitespace
        let token = '';
        while (i < len && trimmed[i] !== ' ' && trimmed[i] !== '\t') {
          token += trimmed[i];
          i++;
        }
        tokens.push(token);
      }
    }

    if (tokens.length === 0) {
      return null;
    }

    const executable = tokens[0];
    const args = tokens.slice(1);

    if (!executable || executable.trim().length === 0) {
      throw new Error('Command must have a non-empty executable.');
    }

    return { executable, args };
  }

  /**
   * Serializes a structured command into a canonical single-line Owner-editable command string.
   * Quotes tokens containing whitespace or empty tokens.
   * Preserves literal apostrophes and Windows path separators.
   * Guarantees that parse(format(cmd)) deeply equals cmd for all supported commands.
   */
  public static format(cmd?: { executable?: string | null; args?: string[] | null } | null): string {
    if (!cmd || !cmd.executable || cmd.executable.trim().length === 0) {
      return '';
    }

    const formatToken = (token: string): string => {
      if (token.length === 0) {
        return '""';
      }

      const hasWhitespace = /\s/.test(token);
      const hasDoubleQuote = token.includes('"');
      const hasSingleQuote = token.includes("'");

      if (hasWhitespace) {
        if (hasDoubleQuote && hasSingleQuote) {
          throw new Error(
            `Token containing whitespace, single quotes, and double quotes cannot be safely serialized: "${token}"`
          );
        }
        if (hasDoubleQuote) {
          return `'${token}'`;
        }
        return `"${token}"`;
      }

      // If token starts with quote character, wrap to preserve exact token boundary
      if (token.startsWith('"') || token.startsWith("'")) {
        if (hasDoubleQuote && hasSingleQuote) {
          throw new Error(`Ambiguous token starting with quote character: "${token}"`);
        }
        if (hasDoubleQuote) {
          return `'${token}'`;
        }
        return `"${token}"`;
      }

      return token;
    };

    const parts: string[] = [formatToken(cmd.executable)];

    if (cmd.args && Array.isArray(cmd.args)) {
      for (const arg of cmd.args) {
        parts.push(formatToken(arg));
      }
    }

    return parts.join(' ');
  }
}
