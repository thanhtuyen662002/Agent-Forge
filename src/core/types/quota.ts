export type QuotaObservationStatus =
  | 'OK'
  | 'UNAUTHENTICATED'
  | 'UNSUPPORTED'
  | 'UNAVAILABLE'
  | 'ERROR';

export interface QuotaWindowObservation {
  usedPercent: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
  windowMinutes: number | null;
}

/** Usage telemetry only; never evidence of account health or execution authority. */
export interface QuotaObservation extends QuotaWindowObservation {
  accountId: string;
  resourceIds: string[];
  providerId: string;
  status: QuotaObservationStatus;
  /**
   * PROVIDER_REPORTED: read from the provider's official tool (Codex app-server).
   * OBSERVED: derived from what a real run recorded (a limit reached until a reset, a lost sign-in).
   * UNOFFICIAL: read like quota routers do, from the CLI's saved sign-in and its private usage endpoint (#250);
   *   shown on the dashboard only, never stored as resource quota or used for scheduling.
   * UNKNOWN: nothing is known; never guessed.
   */
  source: 'PROVIDER_REPORTED' | 'OBSERVED' | 'UNOFFICIAL' | 'UNKNOWN';
  /** The account's recorded health when the observation was made (single health writer). */
  healthStatus: string | null;
  secondary: QuotaWindowObservation | null;
  /** Per-model buckets (Gemini, #250), tightest first; the primary window is the first one. */
  buckets?: Array<QuotaWindowObservation & { label: string }>;
  planType: string | null;
  observedAt: string;
  message: string | null;
}
