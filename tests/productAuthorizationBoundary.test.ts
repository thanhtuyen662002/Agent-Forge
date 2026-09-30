import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AuthorizeRoutedTaskIpcSchema,
  DispatchAuthorizationIpcSchema,
} from '../src/core/types/ipc';
import { ExecutionAuthorizationService } from '../src/core/services/ExecutionAuthorizationService';
import { MigrationRunner } from '../src/core/database/migrations';
import { Repository } from '../src/core/database/repositories';

let db: Database.Database;
let repo: Repository;

beforeAll(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  MigrationRunner.run(db);
  repo = new Repository(db);
});

afterAll(() => db.close());

describe('Issue #130 product-bound renderer authorization', () => {
  it('rejects an ambiguous legacy authorization payload at the IPC boundary', () => {
    expect(
      AuthorizeRoutedTaskIpcSchema.safeParse({
        projectId: 'project-1',
        taskId: 'task-1',
        routingDecisionId: 'decision-1',
      }).success,
    ).toBe(false);
  });

  it('requires every product binding before accepting automated renderer authorization', () => {
    const base = {
      projectId: 'project-1',
      taskId: 'task-1',
      routingDecisionId: 'decision-1',
      executionMode: 'PRODUCT_BOUND' as const,
    };

    expect(AuthorizeRoutedTaskIpcSchema.safeParse(base).success).toBe(false);
    expect(
      AuthorizeRoutedTaskIpcSchema.safeParse({
        ...base,
        assignmentId: 'assignment-1',
        taskOwnershipEpoch: 4,
        contextManifestId: 'manifest-1',
        executionScope: {
          branch: 'agent/task-1',
          worktree: 'D:/worktrees/task-1',
          allowedPaths: ['src'],
          forbiddenPaths: ['.git'],
        },
      }).success,
    ).toBe(true);
  });

  it('requires explicit dispatch mode and never defaults a renderer request to legacy dispatch', () => {
    expect(DispatchAuthorizationIpcSchema.safeParse({ authorizationId: 'auth-1' }).success).toBe(false);
    expect(
      DispatchAuthorizationIpcSchema.safeParse({
        authorizationId: 'auth-1',
        executionMode: 'MANUAL_BRIDGE',
      }).success,
    ).toBe(true);
    expect(
      DispatchAuthorizationIpcSchema.safeParse({
        authorizationId: 'auth-1',
        executionMode: 'PRODUCT_BOUND',
      }).success,
    ).toBe(true);
  });

  it('fails closed when an in-process caller labels a request product-bound without its binding', async () => {
    const service = new ExecutionAuthorizationService(repo);
    await expect(
      service.createAuthorization({
        projectId: 'project-1',
        taskId: 'task-1',
        routingDecisionId: 'decision-1',
        executionMode: 'PRODUCT_BOUND',
      }),
    ).rejects.toThrow(/PRODUCT_BINDING_INCOMPLETE/);
  });

  it('does not allow Manual Bridge mode to carry automated binding fields', async () => {
    const service = new ExecutionAuthorizationService(repo);
    await expect(
      service.createAuthorization({
        projectId: 'project-1',
        taskId: 'task-1',
        routingDecisionId: 'decision-1',
        executionMode: 'MANUAL_BRIDGE',
        assignmentId: 'assignment-1',
      }),
    ).rejects.toThrow(/MODE_CONFLICT/);

    await expect(
      service.createAuthorization({
        projectId: 'project-1',
        taskId: 'task-1',
        routingDecisionId: 'decision-1',
        executionMode: 'MANUAL_BRIDGE',
        contextManifestId: 'manifest-1',
      }),
    ).rejects.toThrow(/MODE_CONFLICT/);
  });
});
