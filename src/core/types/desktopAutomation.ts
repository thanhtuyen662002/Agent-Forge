/**
 * Truthful per-project phase of desktop automation. Every phase is derived
 * from durable state plus the service's own in-flight work; a RUNNING project
 * status alone never implies that a worker is executing.
 */
export type AutomationPhase =
  /** The project is not RUNNING, so automation does not dispatch. */
  | 'PROJECT_NOT_RUNNING'
  /** No task is CODING with valid Manager EXECUTE/FIX_REQUIRED authority. */
  | 'WAITING_FOR_MANAGER'
  /** Approved work exists but only Manual Bridge coders are configured. */
  | 'MANUAL_RELAY_REQUIRED'
  /** Approved work exists but no CLI coder has a usable account and idle slot. */
  | 'WAITING_FOR_CAPACITY'
  /** Approved work and a usable coder exist; dispatch starts on the next pass. */
  | 'QUEUED'
  /** Automation is preparing or running a coder execution. */
  | 'EXECUTING'
  /** The coder execution settled COMPLETED; changes await verification and review. */
  | 'AWAITING_REVIEW'
  /** The latest automated execution for the current revision failed. */
  | 'FAILED';

export interface ProjectAutomationStatus {
  projectId: string;
  phase: AutomationPhase;
  taskId: string | null;
  /** Static, sanitized explanation code for the renderer; never provider output. */
  reasonCode: string | null;
  updatedAt: string;
}

export interface DesktopAutomationStatus {
  /** The background loop is active in this process. */
  active: boolean;
  maxConcurrentExecutions: number;
  inFlight: number;
  projects: ProjectAutomationStatus[];
}
