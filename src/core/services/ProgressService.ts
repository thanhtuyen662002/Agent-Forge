import { Task, TaskState } from '../types/domain';

export interface ProgressBreakdown {
  percent: number;
  breakdown: {
    analysisAndPlanning: number;
    implementation: number;
    targetedTesting: number;
    regressionAndLint: number;
    evidenceGathered: number;
    managerReview: number;
  };
  details: string;
}

export class ProgressService {
  /**
   * Deterministic derived progress calculation.
   * AI models NEVER self-estimate progress.
   */
  public static calculateTaskProgress(
    task: Task,
    options: {
      hasGitDiff?: boolean;
      testsPassed?: boolean;
      lintPassed?: boolean;
      hasEvidence?: boolean;
    } = {}
  ): ProgressBreakdown {
    const weights = {
      analysisAndPlanning: 10,
      implementation: 40,
      targetedTesting: 20,
      regressionAndLint: 15,
      evidenceGathered: 5,
      managerReview: 10,
    };

    let earned = 0;
    const breakdown = {
      analysisAndPlanning: 0,
      implementation: 0,
      targetedTesting: 0,
      regressionAndLint: 0,
      evidenceGathered: 0,
      managerReview: 0,
    };

    // 1. Planning / Criteria definition
    if (task.state !== 'CREATED') {
      breakdown.analysisAndPlanning = weights.analysisAndPlanning;
      earned += weights.analysisAndPlanning;
    }

    // 2. Implementation & Git Changes
    if (['CODING', 'VALIDATING', 'REVIEW_READY', 'REVIEWING', 'DONE'].includes(task.state)) {
      if (options.hasGitDiff || task.current_sha !== null || task.state !== 'CODING') {
        breakdown.implementation = weights.implementation;
        earned += weights.implementation;
      } else {
        // In coding phase without git diff yet
        breakdown.implementation = 15; // In-progress weight
        earned += 15;
      }
    }

    // 3. Targeted Testing
    if (['VALIDATING', 'REVIEW_READY', 'REVIEWING', 'DONE'].includes(task.state)) {
      if (options.testsPassed || task.state === 'DONE') {
        breakdown.targetedTesting = weights.targetedTesting;
        earned += weights.targetedTesting;
      }
    }

    // 4. Regression & Lint
    if (['REVIEW_READY', 'REVIEWING', 'DONE'].includes(task.state)) {
      if (options.lintPassed || task.state === 'DONE') {
        breakdown.regressionAndLint = weights.regressionAndLint;
        earned += weights.regressionAndLint;
      }
    }

    // 5. Evidence Package Collected
    if (['REVIEW_READY', 'REVIEWING', 'DONE'].includes(task.state) || options.hasEvidence) {
      breakdown.evidenceGathered = weights.evidenceGathered;
      earned += weights.evidenceGathered;
    }

    // 6. Manager Review Verdict PASS
    if (task.state === 'DONE') {
      breakdown.managerReview = weights.managerReview;
      earned += weights.managerReview;
    }

    const percent = Math.min(100, Math.max(0, earned));
    return {
      percent,
      breakdown,
      details: `${percent}% derived from verified lifecycle gates and test executions.`,
    };
  }

  public static calculateProjectProgress(tasks: Task[]): number {
    if (tasks.length === 0) return 0;
    const total = tasks.reduce((sum, t) => sum + (t.progress_cache_percent || 0), 0);
    return Math.round(total / tasks.length);
  }
}
