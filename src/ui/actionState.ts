import type { TestRun } from '../core/types/domain';

export type UiActionName = 'createProject' | 'createTask' | 'importContract' | 'projectTransition' | 'updateQuota' | 'runVerification' | 'emergencyStop';
export type UiActionFailure = 'DESKTOP_REQUIRED' | 'NO_PROJECT' | 'IPC_REJECTED' | 'IPC_FAILED' | 'INVALID_RESPONSE' | 'ACTION_PENDING' | 'STALE_CONTEXT' | 'TASK_UNAVAILABLE' | 'VERIFICATION_REJECTED';
export type UiActionResult<T = void> = { readonly success: true; readonly data: T } | { readonly success: false; readonly code: UiActionFailure };

export function uiActionFailure(code: UiActionFailure): UiActionResult<never> {
  return { success: false, code };
}

export function uiActionFailureKey(code: UiActionFailure) {
  const keys = {
    DESKTOP_REQUIRED: 'actions.desktopRequired', NO_PROJECT: 'actions.noProject',
    IPC_REJECTED: 'actions.requestRejected', IPC_FAILED: 'actions.failed',
    INVALID_RESPONSE: 'actions.invalidResponse', ACTION_PENDING: 'actions.alreadyPending',
    STALE_CONTEXT: 'actions.selectionChanged', TASK_UNAVAILABLE: 'actions.taskUnavailable',
    VERIFICATION_REJECTED: 'actions.verificationRejected',
  } as const;
  return keys[code];
}

export interface UiVerificationObservation {
  projectId: string;
  taskId: string;
  executionId: string;
  verificationPassed: boolean;
  testRun: Pick<TestRun, 'id' | 'task_id' | 'passed_count' | 'failed_count' | 'skipped_count' | 'duration_ms' | 'exit_code' | 'created_at'>;
}

export interface UiEmergencyObservation {
  processesTerminated: number;
  tasksPaused: number;
  projectsPaused: number;
  timestamp: string;
  unprovenProcesses: number;
  allTerminatedProven: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isTimestamp = (value: unknown): value is string => typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const isExecutionId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);

function observedTestRun(value: unknown, taskId: string): UiVerificationObservation['testRun'] | null {
  if (!isRecord(value) || !isId(value.id) || value.task_id !== taskId ||
      ![value.passed_count, value.failed_count, value.skipped_count].every(isCount) ||
      typeof value.duration_ms !== 'number' || !Number.isFinite(value.duration_ms) || value.duration_ms < 0 ||
      !Number.isSafeInteger(value.exit_code) || !isTimestamp(value.created_at)) return null;
  // Only the bounded display projection crosses this boundary. Commands,
  // provider diagnostics and pending evidence never become action feedback.
  return { id: value.id, task_id: taskId, passed_count: value.passed_count as number,
    failed_count: value.failed_count as number, skipped_count: value.skipped_count as number,
    duration_ms: value.duration_ms, exit_code: value.exit_code as number, created_at: value.created_at };
}

/** ValidationFlowResult, bound to the exact renderer request; failed tests remain observations. */
export function normalizeVerificationReply(reply: unknown, projectId: string, taskId: string, executionId: string): UiActionResult<UiVerificationObservation> {
  try {
    if (!isRecord(reply)) return uiActionFailure('INVALID_RESPONSE');
    if (reply.stale === true || reply.error === 'STALE_VALIDATION_RESULT') return uiActionFailure('STALE_CONTEXT');
    if (reply.success === false && (reply.error === 'COMMAND_POLICY_REJECTED' || reply.errorCode === 'COMMAND_POLICY_REJECTED')) return uiActionFailure('VERIFICATION_REJECTED');
    if (typeof reply.success !== 'boolean') return uiActionFailure('INVALID_RESPONSE');
    if (reply.taskId !== taskId || reply.executionId !== executionId || !isId(projectId) || !isExecutionId(executionId)) return uiActionFailure('INVALID_RESPONSE');
    const testRun = observedTestRun(reply.testRun, taskId);
    if (!testRun) return uiActionFailure('INVALID_RESPONSE');
    if (reply.success && (testRun.exit_code !== 0 || testRun.failed_count !== 0)) return uiActionFailure('INVALID_RESPONSE');
    return { success: true, data: { projectId, taskId, executionId, verificationPassed: reply.success, testRun } };
  } catch { return uiActionFailure('INVALID_RESPONSE'); }
}

export function isVerificationObservation(value: unknown, projectId: string, taskId: string): value is UiVerificationObservation {
  try {
    return isRecord(value) && value.projectId === projectId && value.taskId === taskId &&
      isExecutionId(value.executionId) && typeof value.verificationPassed === 'boolean' &&
      !!observedTestRun(value.testRun, taskId) && (!value.verificationPassed ||
        ((value.testRun as UiVerificationObservation['testRun']).exit_code === 0 && (value.testRun as UiVerificationObservation['testRun']).failed_count === 0));
  } catch { return false; }
}

export function isEmergencyObservation(value: unknown): value is UiEmergencyObservation {
  try {
    return isRecord(value) && [value.processesTerminated, value.tasksPaused, value.projectsPaused, value.unprovenProcesses].every(isCount) &&
      isTimestamp(value.timestamp) && typeof value.allTerminatedProven === 'boolean' && (!value.allTerminatedProven || value.unprovenProcesses === 0);
  } catch { return false; }
}

export function normalizeEmergencyReply(reply: unknown): UiActionResult<UiEmergencyObservation> {
  try {
    if (!isRecord(reply)) return uiActionFailure('INVALID_RESPONSE');
    if (reply.success === false) return uiActionFailure('IPC_FAILED');
    const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 10_000 && value.every(isId) && new Set(value).size === value.length;
    if (!validIds(reply.tasksPaused) || !validIds(reply.projectsPaused)) return uiActionFailure('INVALID_RESPONSE');
    const data = { processesTerminated: reply.processesTerminated, tasksPaused: reply.tasksPaused.length,
      projectsPaused: reply.projectsPaused.length, timestamp: reply.timestamp,
      unprovenProcesses: reply.unprovenProcesses, allTerminatedProven: reply.allTerminatedProven };
    return isEmergencyObservation(data) ? { success: true, data } : uiActionFailure('INVALID_RESPONSE');
  } catch { return uiActionFailure('INVALID_RESPONSE'); }
}

/** Callers validate the typed envelope too, so a broken bridge cannot turn truthiness into success. */
export function normalizeObservationResult<T>(reply: unknown, valid: (value: unknown) => value is T): UiActionResult<T> {
  try {
    if (!isRecord(reply)) return uiActionFailure('INVALID_RESPONSE');
    if (reply.success === false && typeof reply.code === 'string' && Object.hasOwn({ DESKTOP_REQUIRED: 1, NO_PROJECT: 1,
      IPC_REJECTED: 1, IPC_FAILED: 1, INVALID_RESPONSE: 1, ACTION_PENDING: 1, STALE_CONTEXT: 1, TASK_UNAVAILABLE: 1, VERIFICATION_REJECTED: 1 }, reply.code)) {
      return uiActionFailure(reply.code as UiActionFailure);
    }
    return reply.success === true && valid(reply.data) ? { success: true, data: reply.data } : uiActionFailure('INVALID_RESPONSE');
  } catch { return uiActionFailure('INVALID_RESPONSE'); }
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
    return this.runObserved<T>(name, invoke, reply => normalizeUiActionReply<T>(reply, payloadField), afterSuccess);
  }

  public async runObserved<T>(name: UiActionName, invoke: () => Promise<unknown>, normalize: (reply: unknown) => UiActionResult<T>, afterSuccess?: (data: T) => Promise<void>): Promise<UiActionResult<T>> {
    if (!this.desktopAvailable) return uiActionFailure('DESKTOP_REQUIRED');
    if (this.pending.has(name)) return uiActionFailure('ACTION_PENDING');
    this.pending.add(name);
    try {
      this.onPending([...this.pending]);
      const result = normalize(await invoke());
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
