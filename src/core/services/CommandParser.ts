export interface ParsedCommand {
  executable: string;
  args: string[];
}

export class CommandParser {
  /**
   * Parses a single-line command string into structured executable and args without invoking a shell.
   * Preserves quoted arguments (both single and double quotes).
   * Returns null for empty or whitespace-only input.
   * Throws an Error on malformed quotes or control characters.
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
    let currentToken = '';
    let inDoubleQuote = false;
    let inSingleQuote = false;
    let escapeNext = false;

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];

      if (escapeNext) {
        currentToken += char;
        escapeNext = false;
        continue;
      }

      if (char === '\\' && !inSingleQuote) {
        escapeNext = true;
        continue;
      }

      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        continue;
      }

      if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        continue;
      }

      if ((char === ' ' || char === '\t') && !inDoubleQuote && !inSingleQuote) {
        if (currentToken.length > 0) {
          tokens.push(currentToken);
          currentToken = '';
        }
        continue;
      }

      currentToken += char;
    }

    if (inDoubleQuote || inSingleQuote) {
      throw new Error('Command contains unterminated quotation mark.');
    }

    if (escapeNext) {
      currentToken += '\\';
    }

    if (currentToken.length > 0) {
      tokens.push(currentToken);
    }

    if (tokens.length === 0) {
      return null;
    }

    const executable = tokens[0];
    const args = tokens.slice(1);

    return { executable, args };
  }
}
