import crypto from 'crypto';
import path from 'path';
import { Repository } from '../database/repositories';
import {
  ContextSnapshot,
  ContextSnapshotPurpose,
  ContextItem,
  ContextItemType,
  ContextManifest,
} from '../types/domain';

export interface BuildContextOptions {
  projectId: string;
  taskId: string;
  attemptId?: string | null;
  assignmentId?: string | null;
  sessionId?: string | null;
  purpose?: ContextSnapshotPurpose;
  builderVersion?: string;
  includeProjectContract?: boolean;
  includeProjectMemory?: boolean;
  includeTaskCore?: boolean;
  includeTaskMemory?: boolean;
  includeLatestCheckpoint?: boolean;
  includeLatestHandoff?: boolean;
  checkpointId?: string | null;
  handoffId?: string | null;
  contextFiles?: string[];
  customItems?: Array<{
    itemType?: ContextItemType;
    sourceType: string;
    sourceRef?: string | null;
    content: Record<string, unknown> | unknown[];
    tokenEstimate?: number | null;
  }>;
}

export interface BuildContextResult {
  snapshot: ContextSnapshot;
  items: ContextItem[];
  manifest: ContextManifest;
}

/**
 * Deterministically stringifies an object by sorting its keys alphabetically.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => canonicalJsonStringify(item)).join(',') + ']';
  }

  const keys = Object.keys(obj as Record<string, unknown>).sort();
  const pairs = keys.map((key) => {
    const val = (obj as Record<string, unknown>)[key];
    return JSON.stringify(key) + ':' + canonicalJsonStringify(val);
  });
  return '{' + pairs.join(',') + '}';
}

/**
 * Computes SHA-256 hash of a string.
 */
export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Sanitizes and validates context file paths to prevent traversal outside repository.
 */
export function sanitizeContextFiles(
  contextFiles: string[] | undefined,
  repositoryPath: string
): { validFiles: string[]; error?: string } {
  if (!contextFiles || contextFiles.length === 0) {
    return { validFiles: [] };
  }

  const normalizedRepo = path.resolve(repositoryPath);
  const validSet = new Set<string>();

  for (const rawFile of contextFiles) {
    if (!rawFile || typeof rawFile !== 'string' || rawFile.trim() === '') {
      continue;
    }
    const trimmed = rawFile.trim();

    // Check for explicit path traversal
    if (trimmed.includes('..') || trimmed.startsWith('/') || trimmed.startsWith('\\') || /^[a-zA-Z]:/.test(trimmed)) {
      const resolved = path.resolve(normalizedRepo, trimmed);
      if (!resolved.startsWith(normalizedRepo + path.sep) && resolved !== normalizedRepo) {
        return {
          validFiles: [],
          error: `[ContextBuilderService] Invalid context file path "${trimmed}": path escapes repository root "${repositoryPath}".`,
        };
      }
      const relative = path.relative(normalizedRepo, resolved).replace(/\\/g, '/');
      if (relative && !relative.startsWith('..')) {
        validSet.add(relative);
      }
    } else {
      const normalized = path.normalize(trimmed).replace(/\\/g, '/');
      if (normalized.startsWith('..')) {
        return {
          validFiles: [],
          error: `[ContextBuilderService] Invalid context file path "${trimmed}": path escapes repository root.`,
        };
      }
      validSet.add(normalized);
    }
  }

  const sortedFiles = Array.from(validSet).sort();
  return { validFiles: sortedFiles };
}

export class ContextBuilderService {
  constructor(private repo: Repository) {}

  /**
   * Provider-neutral durable context builder.
   * Collects structured memory, task facts, and contract truth deterministically,
   * generates immutable ContextSnapshot, ordered ContextItems, and a reproducible ContextManifest.
   */
  public buildContextSnapshot(options: BuildContextOptions): BuildContextResult {
    const {
      projectId,
      taskId,
      attemptId = null,
      assignmentId = null,
      sessionId = null,
      purpose = 'EXECUTION',
      builderVersion = 'r5b-v1.1',
      includeProjectContract = true,
      includeProjectMemory = true,
      includeTaskCore = true,
      includeTaskMemory = true,
      includeLatestCheckpoint = true,
      includeLatestHandoff = true,
      checkpointId = null,
      handoffId = null,
      contextFiles = [],
      customItems = [],
    } = options;

    // 1. Ownership & Entity Validation (Fail-Closed)
    const project = this.repo.getProject(projectId);
    if (!project) {
      throw new Error(`[ContextBuilderService] Project "${projectId}" not found.`);
    }

    const task = this.repo.getTask(taskId);
    if (!task) {
      throw new Error(`[ContextBuilderService] Task "${taskId}" not found.`);
    }
    if (task.project_id !== projectId) {
      throw new Error(`[ContextBuilderService] Task "${taskId}" belongs to project "${task.project_id}", expected "${projectId}".`);
    }

    if (attemptId) {
      const attempt = this.repo.getTaskAttempt(attemptId);
      if (!attempt) {
        throw new Error(`[ContextBuilderService] TaskAttempt "${attemptId}" not found.`);
      }
      if (attempt.task_id !== taskId) {
        throw new Error(`[ContextBuilderService] TaskAttempt "${attemptId}" belongs to task "${attempt.task_id}", expected "${taskId}".`);
      }
    }

    if (assignmentId) {
      const assignment = this.repo.getAgentAssignment(assignmentId);
      if (!assignment) {
        throw new Error(`[ContextBuilderService] AgentAssignment "${assignmentId}" not found.`);
      }
      if (assignment.task_id !== taskId || assignment.project_id !== projectId) {
        throw new Error(`[ContextBuilderService] AgentAssignment "${assignmentId}" does not match project "${projectId}" or task "${taskId}".`);
      }
    }

    if (sessionId) {
      const session = this.repo.getAgentSession(sessionId);
      if (!session) {
        throw new Error(`[ContextBuilderService] AgentSession "${sessionId}" not found.`);
      }
      if (session.task_id !== taskId || session.project_id !== projectId) {
        throw new Error(`[ContextBuilderService] AgentSession "${sessionId}" does not match project "${projectId}" or task "${taskId}".`);
      }
    }

    const snapshotId = `ctx-snap-${crypto.randomUUID()}`;
    const manifestId = `ctx-man-${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const rawItems: Array<{
      itemType: ContextItemType;
      sourceType: string;
      sourceRef: string | null;
      content: Record<string, unknown> | unknown[];
      tokenEstimate: number | null;
    }> = [];

    // Category 1: PROJECT_CONTRACT
    if (includeProjectContract && project.contract) {
      rawItems.push({
        itemType: 'PROJECT_CONTRACT',
        sourceType: 'PROJECT_CONTRACT',
        sourceRef: project.id,
        content: {
          projectId: project.id,
          projectName: project.name,
          description: project.description,
          defaultBranch: project.default_branch,
          contract: project.contract,
        },
        tokenEstimate: null,
      });
    }

    // Category 2: PROJECT_MEMORY (Sorted deterministically by memory_type ASC, key ASC)
    if (includeProjectMemory) {
      const activeProjectMemories = this.repo.getActiveProjectMemories(projectId);
      const sortedMemories = [...activeProjectMemories].sort((a, b) => {
        if (a.memory_type !== b.memory_type) {
          return a.memory_type.localeCompare(b.memory_type);
        }
        return a.key.localeCompare(b.key);
      });

      for (const mem of sortedMemories) {
        let parsedVal: unknown;
        try {
          parsedVal = JSON.parse(mem.value_json);
        } catch {
          parsedVal = mem.value_json;
        }

        rawItems.push({
          itemType: 'PROJECT_MEMORY',
          sourceType: mem.source_type,
          sourceRef: mem.id,
          content: {
            memoryType: mem.memory_type,
            key: mem.key,
            value: parsedVal,
            revision: mem.revision,
          },
          tokenEstimate: null,
        });
      }
    }

    // Category 3: TASK_CORE
    if (includeTaskCore) {
      rawItems.push({
        itemType: 'TASK_CORE',
        sourceType: 'TASK_CORE',
        sourceRef: task.id,
        content: {
          taskId: task.id,
          projectId: task.project_id,
          title: task.title,
          description: task.description,
          state: task.state,
          priority: task.priority,
          risk: task.risk,
          revisionCount: task.revision_count,
          maxRevisions: task.max_revisions,
          baseSha: task.base_sha,
          currentSha: task.current_sha,
          acceptanceCriteria: task.acceptance_criteria ?? [],
          constraints: task.constraints ?? [],
        },
        tokenEstimate: null,
      });
    }

    // Category 4: TASK_MEMORY (Sorted deterministically by memory_type ASC, key ASC)
    if (includeTaskMemory) {
      const activeTaskMemories = this.repo.getActiveTaskMemories(taskId);
      const sortedMemories = [...activeTaskMemories].sort((a, b) => {
        if (a.memory_type !== b.memory_type) {
          return a.memory_type.localeCompare(b.memory_type);
        }
        return a.key.localeCompare(b.key);
      });

      for (const mem of sortedMemories) {
        let parsedVal: unknown;
        try {
          parsedVal = JSON.parse(mem.value_json);
        } catch {
          parsedVal = mem.value_json;
        }

        rawItems.push({
          itemType: 'TASK_MEMORY',
          sourceType: mem.source_type,
          sourceRef: mem.id,
          content: {
            memoryType: mem.memory_type,
            key: mem.key,
            value: parsedVal,
            revision: mem.revision,
          },
          tokenEstimate: null,
        });
      }
    }

    // Category 5: CHECKPOINT
    if (checkpointId) {
      const cp = this.repo.getCheckpointsByTask(taskId).find((c) => c.id === checkpointId);
      if (cp) {
        rawItems.push({
          itemType: 'CHECKPOINT',
          sourceType: 'CHECKPOINT',
          sourceRef: cp.id,
          content: {
            id: cp.id,
            sha: cp.sha,
            completedSteps: cp.completed_steps,
            remainingSteps: cp.remaining_steps,
            testsPassing: cp.tests_passing,
            testsFailing: cp.tests_failing,
            knownIssues: cp.known_issues,
            recommendedNextAction: cp.recommended_next_action,
          },
          tokenEstimate: null,
        });
      }
    } else if (includeLatestCheckpoint) {
      const checkpoints = this.repo.getCheckpointsByTask(taskId);
      if (checkpoints.length > 0) {
        const latestCp = checkpoints[0];
        rawItems.push({
          itemType: 'CHECKPOINT',
          sourceType: 'CHECKPOINT',
          sourceRef: latestCp.id,
          content: {
            id: latestCp.id,
            sha: latestCp.sha,
            completedSteps: latestCp.completed_steps,
            remainingSteps: latestCp.remaining_steps,
            testsPassing: latestCp.tests_passing,
            testsFailing: latestCp.tests_failing,
            knownIssues: latestCp.known_issues,
            recommendedNextAction: latestCp.recommended_next_action,
          },
          tokenEstimate: null,
        });
      }
    }

    // Category 6: HANDOFF
    if (handoffId) {
      const ho = this.repo.getHandoffContext(handoffId);
      if (ho && ho.task_id === taskId) {
        rawItems.push({
          itemType: 'HANDOFF',
          sourceType: 'HANDOFF_CONTEXT',
          sourceRef: ho.id,
          content: {
            id: ho.id,
            fromAssignmentId: ho.from_assignment_id,
            toAssignmentId: ho.to_assignment_id,
            reason: ho.reason,
            status: ho.status,
          },
          tokenEstimate: null,
        });
      }
    } else if (includeLatestHandoff) {
      const handoffs = this.repo.getHandoffContextsByTask(taskId);
      if (handoffs.length > 0) {
        const latestHo = handoffs[0];
        rawItems.push({
          itemType: 'HANDOFF',
          sourceType: 'HANDOFF_CONTEXT',
          sourceRef: latestHo.id,
          content: {
            id: latestHo.id,
            fromAssignmentId: latestHo.from_assignment_id,
            toAssignmentId: latestHo.to_assignment_id,
            reason: latestHo.reason,
            status: latestHo.status,
          },
          tokenEstimate: null,
        });
      }
    }

    // Category 7: CONTEXT_FILE_REFERENCE (Sanitized and sorted deterministically)
    if (contextFiles && contextFiles.length > 0) {
      const sanitizeResult = sanitizeContextFiles(contextFiles, project.repository_path);
      if (sanitizeResult.error) {
        throw new Error(sanitizeResult.error);
      }
      for (const filePath of sanitizeResult.validFiles) {
        rawItems.push({
          itemType: 'CONTEXT_FILE_REFERENCE',
          sourceType: 'REPOSITORY_FILE',
          sourceRef: filePath,
          content: {
            filePath,
          },
          tokenEstimate: null,
        });
      }
    }

    // Category 8: CUSTOM (Sorted deterministically by sourceType ASC, sourceRef ASC)
    if (customItems && customItems.length > 0) {
      const sortedCustom = [...customItems].sort((a, b) => {
        if (a.sourceType !== b.sourceType) {
          return a.sourceType.localeCompare(b.sourceType);
        }
        return (a.sourceRef || '').localeCompare(b.sourceRef || '');
      });

      for (const custom of sortedCustom) {
        rawItems.push({
          itemType: custom.itemType || 'CUSTOM',
          sourceType: custom.sourceType,
          sourceRef: custom.sourceRef ?? null,
          content: custom.content,
          tokenEstimate: custom.tokenEstimate ?? null,
        });
      }
    }

    // Convert rawItems into ContextItem entities with deterministic ordinals & hashes
    const contextItems: ContextItem[] = rawItems.map((raw, idx) => {
      const contentJson = canonicalJsonStringify(raw.content);
      const contentHash = computeSha256(contentJson);
      const itemId = `ctx-item-${crypto.randomUUID()}`;

      return {
        id: itemId,
        snapshot_id: snapshotId,
        ordinal: idx,
        item_type: raw.itemType,
        source_type: raw.sourceType,
        source_ref: raw.sourceRef,
        content_json: contentJson,
        content_hash: contentHash,
        token_estimate: raw.tokenEstimate,
        created_at: now,
      };
    });

    // Compute ContextSnapshot content_hash
    const snapshotSummary = {
      projectId,
      taskId,
      attemptId,
      assignmentId,
      purpose,
      builderVersion,
      items: contextItems.map((i) => ({
        ordinal: i.ordinal,
        itemType: i.item_type,
        sourceType: i.source_type,
        sourceRef: i.source_ref,
        contentHash: i.content_hash,
      })),
    };
    const snapshotContentHash = computeSha256(canonicalJsonStringify(snapshotSummary));

    const snapshot: ContextSnapshot = {
      id: snapshotId,
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      assignment_id: assignmentId,
      session_id: sessionId,
      purpose,
      snapshot_version: 1,
      builder_version: builderVersion,
      content_hash: snapshotContentHash,
      created_at: now,
    };

    // Compute ContextManifest
    const manifestData = {
      manifest_version: '1.0.0',
      project_id: projectId,
      task_id: taskId,
      attempt_id: attemptId,
      assignment_id: assignmentId,
      purpose,
      builder_version: builderVersion,
      item_count: contextItems.length,
      items: contextItems.map((i) => ({
        ordinal: i.ordinal,
        item_type: i.item_type,
        source_type: i.source_type,
        source_ref: i.source_ref,
        content_hash: i.content_hash,
        token_estimate: i.token_estimate,
      })),
    };
    const manifestJson = canonicalJsonStringify(manifestData);
    const manifestHash = computeSha256(manifestJson);

    const manifest: ContextManifest = {
      id: manifestId,
      snapshot_id: snapshotId,
      manifest_version: '1.0.0',
      item_count: contextItems.length,
      manifest_json: manifestJson,
      manifest_hash: manifestHash,
      created_at: now,
    };

    // Transactionally persist all entities
    this.repo.runInTransaction(() => {
      this.repo.createContextSnapshot(snapshot);
      for (const item of contextItems) {
        this.repo.createContextItem(item);
      }
      this.repo.createContextManifest(manifest);
    });

    return {
      snapshot,
      items: contextItems,
      manifest,
    };
  }
}
