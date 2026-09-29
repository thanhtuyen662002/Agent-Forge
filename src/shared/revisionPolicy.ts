/**
 * Project-level retry/revision policy shared by the renderer and the trusted
 * persistence/task-creation boundaries. Keeping the bounds in one module
 * prevents the UI and IPC layers from accepting values the domain cannot
 * safely apply.
 */
export const DEFAULT_MAX_REVISIONS = 3;
export const MIN_MAX_REVISIONS = 1;
export const MAX_MAX_REVISIONS = 10;

export function isValidMaxRevisions(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= MIN_MAX_REVISIONS &&
    value <= MAX_MAX_REVISIONS
  );
}

export function parseMaxRevisions(value: unknown): number | null {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return isValidMaxRevisions(parsed) ? parsed : null;
  }
  return isValidMaxRevisions(value) ? value : null;
}
