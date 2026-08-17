import { Task } from '../types/domain';

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
  applicableDenominator: number;
  details: string;
}

export class ProgressService {
  /**
   * Deterministic derived progress calculation from measurable evidence gates.
   * AI models NEVER self-estimate progress.
   * Unconfigured optional gates (e.g. Lint) can be dynamically excluded from the denominator.
   */
  public static calculateTaskProgress(
    task: Task,
    options: {
      hasGitDiff?: boolean;
      testsPassed?: boolean;
      lintPassed?: boolean;
      hasEvidence?: boolean;
      excludeUnconfiguredLint?: boolean;
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

    // 1. Planning / Criteria definition: awarded if task is planned/structured
    if (task.state !== 'CREATED') {
      breakdown.analysisAndPlanning = weights.analysisAndPlanning;
      earned += weights.analysisAndPlanning;
    }

    // 2. Implementation: awarded ONLY if measurable Git diff or bound current SHA exists
    if (options.hasGitDiff || task.current_sha !== null) {
      breakdown.implementation = weights.implementation;
      earned += weights.implementation;
    } else if (['CODING', 'VALIDATING', 'REVIEW_READY', 'REVIEWING'].includes(task.state)) {
      // In-flight coding without verified diff evidence yet
      breakdown.implementation = 10;
      earned += 10;
    }

    // 3. Targeted Testing: awarded ONLY if real TestRun exit_code == 0
    if (options.testsPassed === true) {
      breakdown.targetedTesting = weights.targetedTesting;
      earned += weights.targetedTesting;
    }

    // 4. Regression & Lint: awarded ONLY if actually verified passed
    if (options.lintPassed === true) {
      breakdown.regressionAndLint = weights.regressionAndLint;
      earned += weights.regressionAndLint;
    }

    // 5. Evidence Package Collected: awarded ONLY if durable evidence exists
    if (options.hasEvidence === true) {
      breakdown.evidenceGathered = weights.evidenceGathered;
      earned += weights.evidenceGathered;
    }

    // 6. Manager Review Verdict PASS: awarded when task reaches verified DONE
    if (task.state === 'DONE') {
      breakdown.managerReview = weights.managerReview;
      earned += weights.managerReview;
    }

    let denominator = 100;
    if (options.excludeUnconfiguredLint && !options.lintPassed) {
      denominator = 85;
    }

    const percent = Math.min(100, Math.round((earned / denominator) * 100));

    return {
      percent,
      breakdown,
      applicableDenominator: denominator,
      details: `${percent}% derived from verified lifecycle evidence and test executions (${earned}/${denominator} applicable points).`,
    };
  }

  public static calculateProjectProgress(tasks: Task[]): number {
    if (!tasks || tasks.length === 0) return 0;
    const total = tasks.reduce((sum, t) => sum + (t.progress_cache_percent || 0), 0);
    return Math.round(total / tasks.length);
  }
}
