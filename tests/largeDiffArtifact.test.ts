import { describe, it, expect } from 'vitest';
import { PackageGenerator } from '../src/core/protocol/packageGenerator';
import { Project, Task, Evidence } from '../src/core/types/domain';

describe('Review Package Artifact Metadata for Large Diffs', () => {
  it('should include durable artifact metadata (Evidence ID, SHA-256, Byte Size, Storage Type) when diff exceeds 32KB', () => {
    const project: Project = {
      id: 'PROJ-DIFF-1',
      name: 'Diff Test Project',
      description: null,
      repository_path: 'd:/test',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };

    const task: Task = {
      id: 'TSK-LARGE-DIFF',
      project_id: project.id,
      milestone_id: null,
      title: 'Large Diff Task',
      description: null,
      state: 'REVIEWING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: 'abc1234',
      current_sha: 'def5678',
      progress_cache_percent: 80,
      progress_computed_at: new Date().toISOString(),
      acceptance_criteria: ['Large diff handled cleanly'],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // Generate large diff string > 32KB
    const largeDiff = '+ line of changed code\n'.repeat(2000); // ~46KB

    const diffEvidence: Evidence = {
      id: 'ev-large-diff-999',
      project_id: project.id,
      task_id: task.id,
      attempt_id: null,
      evidence_type: 'GIT_DIFF',
      storage_type: 'FILE',
      file_path: 'd:/test/artifacts/diff.txt',
      hash: 'sha256-abcdef0123456789',
      byte_size: largeDiff.length,
      content_type: 'text/x-diff',
      summary: 'Large Diff: 2000 lines changed',
      raw_payload: null,
      created_at: new Date().toISOString(),
    };

    const reviewPackage = PackageGenerator.generateReviewPackage(
      project,
      task,
      null,
      '2000 lines changed',
      largeDiff,
      null,
      [],
      diffEvidence
    );

    expect(reviewPackage).toContain('... [TRUNCATED: Diff is');
    expect(reviewPackage).toContain('**Evidence ID**: `ev-large-diff-999`');
    expect(reviewPackage).toContain('**SHA-256 Checksum**: `sha256-abcdef0123456789`');
    expect(reviewPackage).toContain(`**Byte Size**: \`${largeDiff.length} bytes\``);
    expect(reviewPackage).toContain('**Storage Type**: `FILE`');
  });

  it('should fail closed and reject package generation when large diff lacks durable evidence metadata', () => {
    const project: Project = {
      id: 'PROJ-DIFF-2',
      name: 'Diff Test Project 2',
      description: null,
      repository_path: 'd:/test2',
      default_branch: 'main',
      status: 'RUNNING',
      contract: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };

    const task: Task = {
      id: 'TSK-LARGE-DIFF-NO-EV',
      project_id: project.id,
      milestone_id: null,
      title: 'Large Diff Missing Evidence',
      description: null,
      state: 'REVIEWING',
      paused_from_state: null,
      priority: 'HIGH',
      risk: 'MEDIUM',
      assigned_agent_id: null,
      revision_count: 0,
      max_revisions: 3,
      base_sha: 'abc1234',
      current_sha: 'def5678',
      progress_cache_percent: 80,
      progress_computed_at: new Date().toISOString(),
      acceptance_criteria: ['Large diff handled cleanly'],
      constraints: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const largeDiff = '+ line of changed code\n'.repeat(2000); // ~46KB

    expect(() => {
      PackageGenerator.generateReviewPackage(
        project,
        task,
        null,
        '2000 lines changed',
        largeDiff,
        null,
        [],
        undefined // Missing durable evidence!
      );
    }).toThrowError(/AUTHORITATIVE_DIFF_EVIDENCE_MISSING/);
  });
});
