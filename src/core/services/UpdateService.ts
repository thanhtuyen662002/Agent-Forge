import { EventEmitter } from 'events';
import {
  UpdateState,
  UpdateInfo,
  UpdateProgress,
  UpdateStateSummary,
} from '../types/domain';
import { Repository } from '../database/repositories';

export interface UpdateCheckResult {
  updateInfo: {
    version: string;
    releaseDate?: string;
    releaseNotes?: string | any[];
    releaseName?: string;
  };
}

export interface IUpdateAdapter {
  checkForUpdates(): Promise<UpdateCheckResult | null>;
  downloadUpdate(): Promise<any>;
  quitAndInstall(): void;
  on(event: string, listener: (...args: any[]) => void): void;
  off(event: string, listener: (...args: any[]) => void): void;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  isPackaged: boolean;
  isCodeSigned?: boolean;
  adapter?: IUpdateAdapter;
  repository?: Repository;
}

type AdapterListener = {
  event: string;
  listener: (...args: any[]) => void;
};

/**
 * UpdateService manages the installed application update lifecycle.
 * Maintains strict separation from task execution and provider dispatch authority.
 */
export class UpdateService extends EventEmitter {
  private state: UpdateState = 'IDLE';
  private currentVersion: string;
  private isPackaged: boolean;
  private isCodeSigned: boolean;
  private updateInfo: UpdateInfo | null = null;
  private progress: UpdateProgress | null = null;
  private error: string | null = null;
  private lastCheckedAt: string | null = null;
  private adapter: IUpdateAdapter | null = null;
  private adapterGeneration = 0;
  private adapterListeners: AdapterListener[] = [];
  private repository: Repository | null = null;

  constructor(options: UpdateServiceOptions) {
    super();
    this.currentVersion = options.currentVersion;
    this.isPackaged = options.isPackaged;
    this.isCodeSigned = options.isCodeSigned ?? false;
    this.repository = options.repository ?? null;

    if (options.adapter) {
      this.setAdapter(options.adapter);
    } else if (!this.isPackaged) {
      this.state = 'DISABLED';
    }
  }

  public setRepository(repo: Repository): void {
    this.repository = repo;
  }

  public setAdapter(adapter: IUpdateAdapter): void {
    if (this.adapter === adapter) return;
    const replacingAdapter = this.adapter !== null;
    this.detachAdapterListeners();
    this.adapter = adapter;
    const generation = ++this.adapterGeneration;
    this.setupAdapterListeners(adapter, generation);
    if (replacingAdapter) {
      // State from an old provider is not evidence that the replacement has
      // checked or downloaded anything. Clear it so the UI cannot offer a
      // stale install action after an adapter swap.
      this.state = this.isPackaged ? 'IDLE' : 'DISABLED';
      this.updateInfo = null;
      this.progress = null;
      this.error = null;
      this.lastCheckedAt = null;
      this.emitStateChanged();
    }
  }

  private setupAdapterListeners(adapter: IUpdateAdapter, generation: number): void {
    const guarded = (handler: (...args: any[]) => void): ((...args: any[]) => void) => (...args: any[]) => {
      if (this.adapter !== adapter || this.adapterGeneration !== generation) return;
      handler(...args);
    };
    const add = (event: string, handler: (...args: any[]) => void): void => {
      const listener = guarded(handler);
      adapter.on(event, listener);
      this.adapterListeners.push({ event, listener });
    };

    add('checking-for-update', () => {
      this.state = 'CHECKING';
      this.error = null;
      this.emitStateChanged();
    });

    add('update-available', (info: any) => {
      this.state = 'UPDATE_AVAILABLE';
      this.lastCheckedAt = new Date().toISOString();
      this.updateInfo = {
        version: String(info?.version || 'unknown'),
        releaseDate: info?.releaseDate ? String(info.releaseDate) : undefined,
        releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
        releaseName: info?.releaseName ? String(info.releaseName) : undefined,
      };
      this.error = null;
      this.emitStateChanged();
    });

    add('update-not-available', () => {
      this.state = 'NO_UPDATE_AVAILABLE';
      this.lastCheckedAt = new Date().toISOString();
      this.updateInfo = null;
      this.error = null;
      this.emitStateChanged();
    });

    add('download-progress', (progressObj: any) => {
      this.state = 'DOWNLOADING';
      this.progress = {
        percent: Math.min(100, Math.max(0, Math.round(Number(progressObj?.percent || 0)))),
        bytesPerSecond: progressObj?.bytesPerSecond ? Number(progressObj.bytesPerSecond) : undefined,
        transferred: progressObj?.transferred ? Number(progressObj.transferred) : undefined,
        total: progressObj?.total ? Number(progressObj.total) : undefined,
      };
      this.emitStateChanged();
    });

    add('update-downloaded', (info: any) => {
      this.state = 'DOWNLOADED';
      this.progress = { percent: 100 };
      if (info?.version) {
        this.updateInfo = {
          version: String(info.version),
          releaseDate: info.releaseDate ? String(info.releaseDate) : undefined,
          releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
          releaseName: info.releaseName ? String(info.releaseName) : undefined,
        };
      }
      this.emitStateChanged();
    });

    add('error', (err: any) => {
      this.state = 'ERROR';
      this.error = this.sanitizeErrorMessage(err?.message || String(err || 'Unknown updater error'));
      this.emitStateChanged();
    });
  }

  private detachAdapterListeners(): void {
    const adapter = this.adapter;
    if (!adapter) {
      this.adapterListeners = [];
      return;
    }
    for (const { event, listener } of this.adapterListeners) {
      try {
        adapter.off(event, listener);
      } catch {
        // Generation fencing below still makes a non-conforming adapter's
        // stale callbacks harmless. Do not let a cleanup failure prevent a
        // replacement adapter from being installed.
      }
    }
    this.adapterListeners = [];
  }

  public getState(): UpdateStateSummary {
    const safeRestart = this.canSafelyRestart();
    return {
      state: this.state,
      currentVersion: this.currentVersion,
      updateInfo: this.updateInfo,
      progress: this.progress,
      error: this.error,
      isPackaged: this.isPackaged,
      isCodeSigned: this.isCodeSigned,
      canInstall: this.state === 'DOWNLOADED' && safeRestart.safe,
      lastCheckedAt: this.lastCheckedAt,
    };
  }

  public async checkForUpdates(): Promise<UpdateStateSummary> {
    if (!this.isPackaged && !this.adapter) {
      this.state = 'DISABLED';
      this.error = null;
      this.emitStateChanged();
      return this.getState();
    }

    if (this.state === 'CHECKING' || this.state === 'DOWNLOADING' || this.state === 'INSTALLING') {
      return this.getState();
    }

    this.state = 'CHECKING';
    this.error = null;
    this.emitStateChanged();

    const adapter = this.adapter;
    const generation = this.adapterGeneration;
    // The adapter cannot disappear synchronously between the guard above and
    // this capture, but retain the defensive branch for embedders that mutate
    // the service from an event listener.
    if (!adapter) {
      this.state = 'ERROR';
      this.error = 'No update provider adapter configured.';
      this.emitStateChanged();
      return this.getState();
    }

    try {
      const result = await adapter.checkForUpdates();
      if (this.adapter !== adapter || this.adapterGeneration !== generation) return this.getState();
      if (!result || !result.updateInfo) {
        if (this.state === 'CHECKING') {
          this.state = 'NO_UPDATE_AVAILABLE';
          this.lastCheckedAt = new Date().toISOString();
        }
      }
    } catch (err: any) {
      if (this.adapter !== adapter || this.adapterGeneration !== generation) return this.getState();
      this.state = 'ERROR';
      this.error = this.sanitizeErrorMessage(err?.message || 'Failed to check for updates.');
    }

    this.emitStateChanged();
    return this.getState();
  }

  public async downloadUpdate(): Promise<UpdateStateSummary> {
    if (this.state !== 'UPDATE_AVAILABLE' && this.state !== 'ERROR') {
      if (this.state === 'DOWNLOADING' || this.state === 'DOWNLOADED') {
        return this.getState();
      }
      throw new Error(`UPDATE_NOT_AVAILABLE: Cannot download update in state "${this.state}".`);
    }

    if (!this.adapter) {
      this.state = 'ERROR';
      this.error = 'No update provider adapter configured.';
      this.emitStateChanged();
      return this.getState();
    }

    this.state = 'DOWNLOADING';
    this.progress = { percent: 0 };
    this.error = null;
    this.emitStateChanged();

    const adapter = this.adapter;
    const generation = this.adapterGeneration;
    if (!adapter) {
      this.state = 'ERROR';
      this.error = 'No update provider adapter configured.';
      this.emitStateChanged();
      return this.getState();
    }

    try {
      await adapter.downloadUpdate();
    } catch (err: any) {
      if (this.adapter !== adapter || this.adapterGeneration !== generation) return this.getState();
      this.state = 'ERROR';
      this.error = this.sanitizeErrorMessage(err?.message || 'Failed to download update.');
      this.emitStateChanged();
    }

    return this.getState();
  }

  public installAndRestart(): void {
    if (this.state === 'INSTALLING') {
      return; // Debounce repeated clicks
    }

    if (this.state !== 'DOWNLOADED') {
      throw new Error(`UPDATE_NOT_DOWNLOADED: Cannot install update before download completes (current state: "${this.state}").`);
    }

    const safeCheck = this.canSafelyRestart();
    if (!safeCheck.safe) {
      throw new Error(`UPDATE_RESTART_BLOCKED: ${safeCheck.reason || 'Active workflow is running. Cannot restart safely.'}`);
    }

    if (!this.adapter) {
      throw new Error('UPDATE_ADAPTER_UNAVAILABLE: No update adapter available to trigger install.');
    }

    this.state = 'INSTALLING';
    this.emitStateChanged();

    // Call adapter quitAndInstall. Some electron-updater versions throw
    // synchronously when the downloaded artifact is missing or invalid; keep
    // that failure visible and retryable instead of leaving INSTALLING stuck.
    const adapter = this.adapter;
    const generation = this.adapterGeneration;
    try {
      adapter.quitAndInstall();
    } catch (err: any) {
      if (this.adapter !== adapter || this.adapterGeneration !== generation) return;
      this.state = 'ERROR';
      this.error = this.sanitizeErrorMessage(err?.message || 'Failed to install update.');
      this.emitStateChanged();
    }
  }

  public canSafelyRestart(): { safe: boolean; reason?: string } {
    if (!this.repository) {
      return { safe: true };
    }

    try {
      // Check for active projects/tasks in critical execution states
      const projects = this.repository.getAllProjects();
      for (const project of projects) {
        const tasks = this.repository.getTasksByProject(project.id);
        for (const task of tasks) {
          if (task.state === 'CODING' || task.state === 'VALIDATING' || task.state === 'DISPATCHED') {
            return {
              safe: false,
              reason: `Task "${task.title}" (${task.id}) is currently in state ${task.state}. Restarting now may interrupt active execution.`,
            };
          }
        }
      }
    } catch (err: any) {
      // Fail safely if database check fails
      return { safe: false, reason: `Database check error: ${err.message}` };
    }

    return { safe: true };
  }

  private sanitizeErrorMessage(msg: string): string {
    // Strip tokens, bearer auth, and long credential URLs
    return msg
      .replace(/ghp_[a-zA-Z0-9]+/g, '[REDACTED_TOKEN]')
      .replace(/github_pat_[a-zA-Z0-9_]+/g, '[REDACTED_TOKEN]')
      .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]')
      .replace(/https:\/\/[^:]+:[^@]+@/g, 'https://[REDACTED_CREDENTIALS]@')
      .slice(0, 300);
  }

  private emitStateChanged(): void {
    this.emit('state-changed', this.getState());
  }
}
