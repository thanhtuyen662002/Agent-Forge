/**
 * Keep one-time MCP credentials out of Vitest's own process output.
 *
 * Tests that need to assert the complete admin response temporarily replace
 * process.stdout.write/process.stderr.write and therefore still receive the
 * original, unsanitized value. Only writes that reach the real test runner
 * streams are redacted.
 */

const installedMarker = Symbol.for('agentforge.vitest.outputSanitizer');
const outputWithMarker = process.stdout as NodeJS.WriteStream & {
  [installedMarker]?: boolean;
};

export const redactCredentialLabels = (text: string): string =>
  text.replace(
    /((?:Plaintext Token|plaintext_token)\s*["']?\s*[:=]\s*["']?)[A-Za-z0-9_-]+(?=["'\s,}]|$)/gi,
    '$1[REDACTED]'
  );

if (!outputWithMarker[installedMarker]) {
  const wrapWrite = <T extends NodeJS.WriteStream>(stream: T): void => {
    const streamWithMarker = stream as T & { [installedMarker]?: boolean };
    if (streamWithMarker[installedMarker]) return;

    const originalWrite = stream.write.bind(stream);
    stream.write = ((chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
        if (typeof encodingOrCallback === 'function' && callback === undefined) {
          return originalWrite(chunk as never, encodingOrCallback);
        }
        return originalWrite(chunk as never, encodingOrCallback as never, callback);
      }

      const text = Buffer.isBuffer(chunk) ? chunk.toString() : chunk;
      const redacted = redactCredentialLabels(text);
      const output = redacted === text ? chunk : redacted;
      if (typeof encodingOrCallback === 'function' && callback === undefined) {
        return originalWrite(output as never, encodingOrCallback);
      }
      return originalWrite(output as never, encodingOrCallback as never, callback);
    }) as T['write'];

    streamWithMarker[installedMarker] = true;
  };

  wrapWrite(process.stdout);
  wrapWrite(process.stderr);
}
