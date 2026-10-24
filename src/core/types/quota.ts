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
   * UNKNOWN: nothing is known; never guessed.
   */
  source: 'PROVIDER_REPORTED' | 'OBSERVED' | 'UNKNOWN';
  /** The account's recorded health when the observation was made (single health writer). */
  healthStatus: string | null;
  secondary: QuotaWindowObservation | null;
  planType: string | null;
  observedAt: string;
  message: string | null;
}
