export interface ParsedCommand {
  executable: string;
  args: string[];
}

export class CommandParser {
  /**
   * Parses a single-line command string into structured executable and args without invoking a shell.
   * Preserves quoted arguments (both single and double quotes).
   * Native Windows backslash path separators ('\') and UNC paths ('\\server\share') are literal and preserved.
   * Returns null for empty or whitespace-only input.
   * Throws an Error on malformed/unclosed quotes or control characters.
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

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];

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

    if (currentToken.length > 0) {
      tokens.push(currentToken);
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
   * Quotes tokens containing whitespace or empty tokens with double quotes.
   * Guarantees that parse(format(cmd)) deeply equals cmd for all valid structured commands.
   */
  public static format(cmd: { executable: string; args?: string[] | null }): string {
    if (!cmd.executable || cmd.executable.trim().length === 0) {
      return '';
    }

    const formatToken = (token: string): string => {
      if (token.length === 0 || /\s/.test(token)) {
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
