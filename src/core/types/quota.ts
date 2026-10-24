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
  source: 'PROVIDER_REPORTED' | 'UNKNOWN';
  secondary: QuotaWindowObservation | null;
  planType: string | null;
  observedAt: string;
  message: string | null;
}
