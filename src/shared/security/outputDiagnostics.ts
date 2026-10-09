import { OutputSanitizationError, type OutputSanitizationErrorCode, redactSensitiveText } from './secretRedaction';

export function isOutputSanitizationErrorCode(value: unknown): value is OutputSanitizationErrorCode {
  return value === 'OUTPUT_TYPE_INVALID' || value === 'OUTPUT_SIZE_EXCEEDED' || value === 'OUTPUT_REDACTION_UNSAFE';
}

/** Reconstruct fixed errors rather than forwarding a foreign message/stack. */
export function outputSanitizationFailure(error: unknown): OutputSanitizationError {
  try {
    const code = error instanceof OutputSanitizationError ? error.code : undefined;
    return new OutputSanitizationError(isOutputSanitizationErrorCode(code) ? code : 'OUTPUT_REDACTION_UNSAFE');
  } catch {
    return new OutputSanitizationError('OUTPUT_REDACTION_UNSAFE');
  }
}

/** Diagnostic fallback is safe for a path that has already failed. */
export function safeDiagnosticText(value: unknown): string {
  try { return redactSensitiveText(value); }
  catch (error) { return outputSanitizationFailure(error).message; }
}

/** Read only own data fields: no getter, toString or foreign Error prototype. */
export function sanitizeErrorDiagnostics(value: unknown, fallback = 'Operation failed.'): { message: string; stack?: string } {
  try {
    if (typeof value === 'string') return { message: redactSensitiveText(value) };
    if (!value || typeof value !== 'object') return { message: redactSensitiveText(fallback) };
    const message = Object.getOwnPropertyDescriptor(value, 'message');
    if (message && !('value' in message)) {
      throw new OutputSanitizationError('OUTPUT_REDACTION_UNSAFE');
    }
    const safeMessage = redactSensitiveText(message?.value === undefined ? fallback : message.value);
    const stack = Object.getOwnPropertyDescriptor(value, 'stack');
    // Stack is optional. Omit an accessor rather than evaluating it or losing
    // an independently safe ordinary failure message.
    return {
      message: safeMessage,
      ...(!stack || !('value' in stack) || stack.value === undefined ? {} : { stack: redactSensitiveText(stack.value) }),
    };
  } catch (error) { return { message: outputSanitizationFailure(error).message }; }
}

export function sanitizedDiagnosticError(value: unknown, fallback?: string): Error {
  const diagnostic = sanitizeErrorDiagnostics(value, fallback);
  const error = new Error(diagnostic.message);
  if (diagnostic.stack !== undefined) error.stack = diagnostic.stack;
  return error;
}
