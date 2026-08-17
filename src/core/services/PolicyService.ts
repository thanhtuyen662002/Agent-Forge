import path from 'path';

export type PolicyDecision = 'ALLOW' | 'DENY' | 'REQUIRES_OWNER_APPROVAL';

export interface PolicyEvaluationResult {
  allowed: boolean;
  decision: PolicyDecision;
  reason: string;
}

export class PolicyService {
  private static SENSITIVE_DIRS = [
    '.git',
    '.ssh',
    '.gnupg',
    '.aws',
    '.env',
    '.config',
    'windows',
    'system32',
    'etc',
    'var',
  ];

  private static PROHIBITED_SHELLS = new Set([
    'bash',
    'bash.exe',
    'sh',
    'sh.exe',
    'zsh',
    'zsh.exe',
    'cmd',
    'cmd.exe',
    'powershell',
    'powershell.exe',
    'pwsh',
    'pwsh.exe',
  ]);

  private static PROHIBITED_DOWNLOAD_TOOLS = new Set([
    'curl',
    'curl.exe',
    'wget',
    'wget.exe',
  ]);

  public static evaluatePathAccess(
    targetPath: string,
    repositoryRoot: string,
    isWrite: boolean = false
  ): PolicyEvaluationResult {
    const normalizedTarget = path.normalize(path.resolve(targetPath)).toLowerCase();
    const normalizedRoot = path.normalize(path.resolve(repositoryRoot)).toLowerCase();

    // 1. Sensitive credential directory check across full path
    for (const part of normalizedTarget.split(/[\\/]/)) {
      if (['.ssh', '.aws', '.gnupg', '.env'].includes(part)) {
        return {
          allowed: false,
          decision: 'DENY',
          reason: `Access to sensitive credential path element "${part}" is blocked by security policy.`,
        };
      }
    }

    // 2. Boundary check: must stay within repo root
    if (!normalizedTarget.startsWith(normalizedRoot)) {
      return {
        allowed: false,
        decision: 'DENY',
        reason: `Target path "${targetPath}" is outside the authorized project root "${repositoryRoot}".`,
      };
    }

    // 3. Sensitive directory check within repository root
    const relPath = path.relative(normalizedRoot, normalizedTarget).toLowerCase();
    const pathParts = relPath.split(path.sep);

    for (const part of pathParts) {
      if (this.SENSITIVE_DIRS.includes(part)) {
        // Allow read on .git for internal git operations, but deny arbitrary direct file write
        if (part === '.git' && !isWrite) {
          continue;
        }
        return {
          allowed: false,
          decision: 'DENY',
          reason: `Access to sensitive path element "${part}" is blocked by security policy.`,
        };
      }
    }

    return {
      allowed: true,
      decision: 'ALLOW',
      reason: 'Path access conforms to security policy.',
    };
  }

  public static evaluateGitCommand(args: string[]): PolicyEvaluationResult {
    const lowerArgs = args.map((a) => a.toLowerCase());
    if (lowerArgs.includes('--force') || lowerArgs.includes('-f') || lowerArgs.includes('--force-with-lease')) {
      return {
        allowed: false,
        decision: 'DENY',
        reason: 'Force-pushing or force operations on Git branches are prohibited by security policy.',
      };
    }
    return {
      allowed: true,
      decision: 'ALLOW',
      reason: 'Git operation approved by policy.',
    };
  }

  public static evaluateProcessExecution(
    executable: string,
    args: string[],
    allowShell: boolean = false
  ): PolicyEvaluationResult {
    const execBase = path.basename(executable).toLowerCase();

    // 1. Direct shell execution or explicit allowShell is prohibited without owner approval
    if (allowShell || this.PROHIBITED_SHELLS.has(execBase)) {
      return {
        allowed: false,
        decision: 'REQUIRES_OWNER_APPROVAL',
        reason: `Direct shell execution (${execBase}) requires explicit human owner approval.`,
      };
    }

    // 2. Arbitrary network download tools
    if (this.PROHIBITED_DOWNLOAD_TOOLS.has(execBase)) {
      return {
        allowed: false,
        decision: 'REQUIRES_OWNER_APPROVAL',
        reason: `Invoking network download utility (${execBase}) requires explicit human owner approval.`,
      };
    }

    const lowerArgs = args.map((a) => a.toLowerCase());

    // 3. Block inline code-eval modes across runtimes
    // Node.js: -e, --eval, -p, --print
    if (['node', 'node.exe'].includes(execBase)) {
      if (lowerArgs.some((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print' || a.startsWith('-e=') || a.startsWith('--eval='))) {
        return {
          allowed: false,
          decision: 'REQUIRES_OWNER_APPROVAL',
          reason: 'Executing inline code via Node.js evaluation flags (-e / --eval / -p) requires owner approval.',
        };
      }
    }

    // Python: -c
    if (['python', 'python.exe', 'python3', 'python3.exe', 'py', 'py.exe'].includes(execBase)) {
      if (lowerArgs.some((a) => a === '-c' || a.startsWith('-c='))) {
        return {
          allowed: false,
          decision: 'REQUIRES_OWNER_APPROVAL',
          reason: 'Executing inline code via Python evaluation flag (-c) requires owner approval.',
        };
      }
    }

    // Ruby / Perl: -e
    if (['ruby', 'ruby.exe', 'perl', 'perl.exe'].includes(execBase)) {
      if (lowerArgs.some((a) => a === '-e')) {
        return {
          allowed: false,
          decision: 'REQUIRES_OWNER_APPROVAL',
          reason: `Executing inline code via ${execBase} evaluation flag (-e) requires owner approval.`,
        };
      }
    }

    // PHP: -r
    if (['php', 'php.exe'].includes(execBase)) {
      if (lowerArgs.some((a) => a === '-r')) {
        return {
          allowed: false,
          decision: 'REQUIRES_OWNER_APPROVAL',
          reason: 'Executing inline code via PHP evaluation flag (-r) requires owner approval.',
        };
      }
    }

    // Bun: -e, --eval
    if (['bun', 'bun.exe'].includes(execBase)) {
      if (lowerArgs.some((a) => a === '-e' || a === '--eval')) {
        return {
          allowed: false,
          decision: 'REQUIRES_OWNER_APPROVAL',
          reason: 'Executing inline code via Bun evaluation flag (-e / --eval) requires owner approval.',
        };
      }
    }

    // Deno: eval
    if (['deno', 'deno.exe'].includes(execBase)) {
      if (lowerArgs.includes('eval')) {
        return {
          allowed: false,
          decision: 'REQUIRES_OWNER_APPROVAL',
          reason: 'Executing inline code via Deno eval requires owner approval.',
        };
      }
    }

    // 4. External dependency installation requires owner approval
    if (['npm', 'npm.cmd', 'pnpm', 'pnpm.cmd', 'yarn', 'yarn.cmd'].includes(execBase)) {
      const isInstallCmd = lowerArgs.some((a) => a === 'install' || a === 'i' || a === 'add');
      const hasSpecificPackage = lowerArgs.some(
        (a) => !a.startsWith('-') && a !== 'install' && a !== 'i' && a !== 'add' && a !== 'run' && a !== 'test'
      );
      if (isInstallCmd && hasSpecificPackage) {
        return {
          allowed: false,
          decision: 'REQUIRES_OWNER_APPROVAL',
          reason: 'Installing new external packages requires human owner approval.',
        };
      }
    }

    return {
      allowed: true,
      decision: 'ALLOW',
      reason: 'Structured process execution approved by policy.',
    };
  }
}
