import path from 'path';
import os from 'os';
import { PolicyDecision } from '../types/domain';

export interface PolicyEvaluationResult {
  allowed: boolean;
  decision: PolicyDecision;
  reason: string;
}

export class PolicyService {
  private static SENSITIVE_PATHS = [
    '.ssh',
    '.aws',
    '.gnupg',
    '.config/gcloud',
    '.azure',
    'id_rsa',
    'id_ed25519',
    '.bash_history',
    '.zsh_history',
  ];

  public static evaluatePathAccess(targetPath: string, projectRoot: string, isWrite: boolean = false): PolicyEvaluationResult {
    const normalizedTarget = path.resolve(targetPath);
    const normalizedProjectRoot = path.resolve(projectRoot);
    const userHome = os.homedir();

    // 1. Check sensitive credential paths
    for (const sens of this.SENSITIVE_PATHS) {
      if (normalizedTarget.includes(path.sep + sens) || normalizedTarget.endsWith(sens)) {
        return {
          allowed: false,
          decision: 'DENY',
          reason: `Access to sensitive credential path "${sens}" is strictly prohibited.`,
        };
      }
    }

    // 2. Check if write is outside project root
    if (isWrite && !normalizedTarget.startsWith(normalizedProjectRoot)) {
      return {
        allowed: false,
        decision: 'DENY',
        reason: `Write operation outside project directory ("${normalizedTarget}") is strictly denied.`,
      };
    }

    return {
      allowed: true,
      decision: 'ALLOW',
      reason: 'Path access conforms to project security policy.',
    };
  }

  public static evaluateGitCommand(args: string[]): PolicyEvaluationResult {
    const commandStr = args.join(' ').toLowerCase();

    // Check destructive operations
    if (commandStr.includes('--force') || commandStr.includes('-f') || commandStr.includes('push -f')) {
      return {
        allowed: false,
        decision: 'DENY',
        reason: 'Force-pushing Git branches is strictly denied by security policy.',
      };
    }

    if (commandStr.includes('push') && (commandStr.includes('main') || commandStr.includes('master'))) {
      return {
        allowed: false,
        decision: 'DENY',
        reason: 'Direct pushes to main/master branch are prohibited. Use task branches and pull requests.',
      };
    }

    return {
      allowed: true,
      decision: 'ALLOW',
      reason: 'Git operation permitted.',
    };
  }

  public static evaluateProcessExecution(
    executable: string,
    args: string[],
    allowShell: boolean = false
  ): PolicyEvaluationResult {
    const execLower = executable.toLowerCase();

    // Direct shell interpreters without approval are prohibited
    if (allowShell || ['bash', 'sh', 'cmd', 'cmd.exe', 'powershell', 'pwsh'].includes(execLower)) {
      return {
        allowed: false,
        decision: 'REQUIRES_OWNER_APPROVAL',
        reason: 'Raw shell execution requires explicit human owner authorization.',
      };
    }

    // Dependency installation requires owner approval
    if (execLower === 'npm' && (args.includes('install') || args.includes('i')) && args.some((a) => !a.startsWith('-') && a !== 'install' && a !== 'i')) {
      return {
        allowed: false,
        decision: 'REQUIRES_OWNER_APPROVAL',
        reason: 'Installing new external packages requires human owner approval.',
      };
    }

    return {
      allowed: true,
      decision: 'ALLOW',
      reason: 'Structured process execution approved.',
    };
  }
}
