import { describe, expect, it } from 'vitest';
import { automationNeedsSystemAwake, KeepAwake, type PowerSaveBlockerLike } from '../src/electron/keepAwake';
import type { AutomationPhase, DesktopAutomationStatus } from '../src/core/types/desktopAutomation';

/** #342: the PC stays awake while automation runs a project. */
describe('keep awake while automation runs', () => {
  const status = (active: boolean, ...phases: AutomationPhase[]): DesktopAutomationStatus => ({
    active, maxConcurrentExecutions: 10, inFlight: 0,
    projects: phases.map((phase, index) => ({ projectId: `P${index}`, phase, taskId: null, reasonCode: null, updatedAt: '' })),
  });

  it('is needed only while automation is active with a project to work on', () => {
    expect(automationNeedsSystemAwake(status(true, 'EXECUTING'))).toBe(true);
    expect(automationNeedsSystemAwake(status(true, 'PROJECT_COMPLETED', 'AWAITING_REVIEW'))).toBe(true);
    expect(automationNeedsSystemAwake(status(true, 'PROJECT_NOT_RUNNING', 'PROJECT_COMPLETED'))).toBe(false);
    expect(automationNeedsSystemAwake(status(false, 'EXECUTING'))).toBe(false);
    expect(automationNeedsSystemAwake(null)).toBe(false);
  });

  it('starts one system blocker, keeps it while needed, and releases it', () => {
    const started = new Set<number>();
    let next = 1;
    const calls: string[] = [];
    const blocker: PowerSaveBlockerLike = {
      start: (type) => { calls.push(type); started.add(next); return next++; },
      stop: (id) => { started.delete(id); },
      isStarted: (id) => started.has(id),
    };
    const keepAwake = new KeepAwake(blocker);
    keepAwake.update(true);
    keepAwake.update(true);
    expect(calls).toEqual(['prevent-app-suspension']);
    expect(keepAwake.active).toBe(true);
    keepAwake.update(false);
    expect(keepAwake.active).toBe(false);
    expect(started.size).toBe(0);
    keepAwake.update(true);
    keepAwake.release();
    expect(started.size).toBe(0);
  });
});
