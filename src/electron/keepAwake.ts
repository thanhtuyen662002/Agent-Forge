import type { DesktopAutomationStatus } from '../core/types/desktopAutomation';

/** The part of Electron's powerSaveBlocker this needs; a fake stands in for tests. */
export interface PowerSaveBlockerLike {
  start(type: 'prevent-app-suspension'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

/**
 * Whether automation has project work to do (#342). Found in VidFlow M2–M9: the PC slept
 * overnight in the middle of a coder run; its account lease expired, and every task after it
 * failed with STALE_LEASE_REQUIRES_RECOVERY until the app restarted.
 */
export function automationNeedsSystemAwake(status: DesktopAutomationStatus | null | undefined): boolean {
  if (!status?.active) return false;
  return status.projects.some((project) => project.phase !== 'PROJECT_NOT_RUNNING' && project.phase !== 'PROJECT_COMPLETED');
}

/**
 * Keeps the system from sleeping while automation runs a project; the display may still
 * turn off. Released as soon as no project needs it, and on quit.
 */
export class KeepAwake {
  private blockerId: number | null = null;

  constructor(private readonly blocker: PowerSaveBlockerLike) {}

  public update(needed: boolean): void {
    if (needed) {
      if (this.blockerId === null || !this.blocker.isStarted(this.blockerId)) this.blockerId = this.blocker.start('prevent-app-suspension');
    } else {
      this.release();
    }
  }

  public release(): void {
    if (this.blockerId !== null && this.blocker.isStarted(this.blockerId)) this.blocker.stop(this.blockerId);
    this.blockerId = null;
  }

  public get active(): boolean {
    return this.blockerId !== null && this.blocker.isStarted(this.blockerId);
  }
}
