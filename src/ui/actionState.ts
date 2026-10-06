export type UiActionName = 'createProject' | 'createTask' | 'importContract' | 'projectTransition';
export type UiActionFailure = 'DESKTOP_REQUIRED' | 'NO_PROJECT' | 'IPC_REJECTED' | 'IPC_FAILED' | 'INVALID_RESPONSE' | 'ACTION_PENDING';
export type UiActionResult<T = void> = { readonly success: true; readonly data: T } | { readonly success: false; readonly code: UiActionFailure };

export function uiActionFailure(code: UiActionFailure): UiActionResult<never> {
  return { success: false, code };
}

export function uiActionFailureKey(code: UiActionFailure) {
  const keys = {
    DESKTOP_REQUIRED: 'actions.desktopRequired', NO_PROJECT: 'actions.noProject',
    IPC_REJECTED: 'actions.requestRejected', IPC_FAILED: 'actions.failed',
    INVALID_RESPONSE: 'actions.invalidResponse', ACTION_PENDING: 'actions.alreadyPending',
  } as const;
  return keys[code];
}

/** An acknowledgement must explicitly report success; entity replies also need their payload. */
export function normalizeUiActionReply<T = void>(reply: unknown, payloadField?: 'project' | 'task'): UiActionResult<T> {
  try {
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return uiActionFailure('INVALID_RESPONSE');
  const response = reply as Record<string, unknown>;
  if (response.success === false) return uiActionFailure('IPC_FAILED');
  if (response.success !== true) return uiActionFailure('INVALID_RESPONSE');
  const payload = payloadField ? response[payloadField] : undefined;
  if (payloadField) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return uiActionFailure('INVALID_RESPONSE');
    const entity = payload as Record<string, unknown>;
    const label = entity[payloadField === 'project' ? 'name' : 'title'];
    if (typeof entity.id !== 'string' || !entity.id || typeof label !== 'string' || !label.trim()) return uiActionFailure('INVALID_RESPONSE');
  }
  return { success: true, data: payload as T };
  } catch {
    return uiActionFailure('INVALID_RESPONSE');
  }
}

/** Synchronous locks protect the gap before React renders disabled controls. */
export class UiActionRunner {
  private readonly pending = new Set<UiActionName>();
  constructor(private readonly desktopAvailable: boolean, private readonly onPending: (actions: UiActionName[]) => void) {}

  public async run<T = void>(name: UiActionName, invoke: () => Promise<unknown>, payloadField?: 'project' | 'task', afterSuccess?: (data: T) => Promise<void>): Promise<UiActionResult<T>> {
    if (!this.desktopAvailable) return uiActionFailure('DESKTOP_REQUIRED');
    if (this.pending.has(name)) return uiActionFailure('ACTION_PENDING');
    this.pending.add(name);
    try {
      this.onPending([...this.pending]);
      const result = normalizeUiActionReply<T>(await invoke(), payloadField);
      if (result.success && afterSuccess) {
        // A read-model refresh cannot undo a confirmed durable mutation.
        try { await afterSuccess(result.data); } catch { /* refresh errors have their own UI channel */ }
      }
      return result;
    } catch {
      // Do not echo renderer/provider-controlled exceptions into another sink.
      return uiActionFailure('IPC_REJECTED');
    } finally {
      this.pending.delete(name);
      this.onPending([...this.pending]);
    }
  }
}
