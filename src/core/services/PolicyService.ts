import fs from 'fs';
import path from 'path';

export type PolicyDecision = 'ALLOW' | 'DENY' | 'REQUIRES_OWNER_APPROVAL';

export interface PolicyEvaluationResult {
  allowed: boolean;
  decision: PolicyDecision;
  reason: string;
}

export type VerificationCandidateReason =
  | 'INVALID_CANDIDATE'
  | 'CANDIDATE_LIMIT_EXCEEDED'
  | 'SHELL_OR_ENV_INDIRECTION'
  | 'PACKAGE_MANAGER_INDIRECTION'
  | 'SCRIPT_HOST_INDIRECTION'
  | 'INLINE_EVALUATION'
  | 'RUNTIME_HOOK'
  | 'SHELL_SYNTAX'
  | 'PATH_TRAVERSAL'
  | 'NETWORK_EXECUTABLE'
  | 'INTERPRETER_IDENTITY_REQUIRED'
  | 'CANONICAL_IDENTITY_REQUIRED';

export interface VerificationCandidateClassification {
  readonly decision: 'DENY' | 'CAPABILITY_REQUIRED';
  readonly reasonCode: VerificationCandidateReason;
}

const VERIFICATION_SHELL_STEMS = new Set(['bash', 'sh', 'dash', 'ash', 'zsh', 'ksh', 'csh', 'tcsh', 'fish', 'cmd', 'command', 'powershell', 'pwsh', 'env', 'busybox']);
const VERIFICATION_PACKAGE_STEMS = new Set(['npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'corepack', 'bunx', 'pip', 'pip3', 'pipx', 'uv', 'composer', 'gem']);
const VERIFICATION_SCRIPT_HOST_STEMS = new Set(['mshta', 'wscript', 'cscript', 'rundll32', 'regsvr32']);
const VERIFICATION_INTERPRETER_STEMS = /^(?:node|nodejs|python(?:w|\d+(?:\.\d+)*)?|py|pypy(?:\d+)?|bun|deno|perl|ruby|jruby|lua(?:\d+(?:\.\d+)*)?|php|java|dotnet|mono)$/;

const VERIFICATION_CANDIDATE_MAX_EXECUTABLE = 4096;
const VERIFICATION_CANDIDATE_MAX_ARGUMENTS = 128;
const VERIFICATION_CANDIDATE_MAX_ARGUMENT = 4096;
const VERIFICATION_CANDIDATE_MAX_TOTAL_ARGUMENTS = 16384;

export class PolicyService {
  /**
   * Pure preparation for the verification capability boundary. This classifier
   * never authorizes execution and does not alter general process policy.
   * Filesystem identity, owner approval and pre-spawn fencing are separate gates.
   */
  public static classifyVerificationCommandCandidate(
    executable: unknown,
    args: unknown,
    allowShell: unknown = false,
  ): VerificationCandidateClassification {
    const deny = (reasonCode: VerificationCandidateReason): VerificationCandidateClassification =>
      Object.freeze({ decision: 'DENY', reasonCode });
    const requireCapability = (reasonCode: VerificationCandidateReason): VerificationCandidateClassification =>
      Object.freeze({ decision: 'CAPABILITY_REQUIRED', reasonCode });
    try {
      if (typeof executable !== 'string' || executable.length === 0 || executable !== executable.trim() ||
          !Array.isArray(args) || typeof allowShell !== 'boolean') return deny('INVALID_CANDIDATE');
      const count = args.length;
      if (!Number.isSafeInteger(count) || count < 0) return deny('INVALID_CANDIDATE');
      if (executable.length > VERIFICATION_CANDIDATE_MAX_EXECUTABLE || count > VERIFICATION_CANDIDATE_MAX_ARGUMENTS) {
        return deny('CANDIDATE_LIMIT_EXCEEDED');
      }
      const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
      const shellSyntax = /[;&|<>`$]/;
      if (controls.test(executable)) return deny('INVALID_CANDIDATE');
      if (allowShell) return deny('SHELL_OR_ENV_INDIRECTION');
      if (shellSyntax.test(executable) || /["'*?]/.test(executable)) return deny('SHELL_SYNTAX');
      if (/^(?:\\\\|\/\/)/.test(executable)) return deny('NETWORK_EXECUTABLE');
      const portable = executable.replace(/\\/g, '/');
      if (portable.split('/').includes('..')) return deny('PATH_TRAVERSAL');
      const basename = portable.split('/').pop()!.toLowerCase();
      if (!basename || basename === '.') return deny('INVALID_CANDIDATE');
      // Repeated Windows suffixes cannot hide a known host behind e.g. npm.cmd.exe.
      const stem = basename.replace(/(?:\.(?:exe|cmd|bat|com))+$/, '');
      let total = 0;
      const normalizedArguments: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const argument = args[index];
        if (typeof argument !== 'string' || controls.test(argument)) return deny('INVALID_CANDIDATE');
        total += argument.length;
        if (argument.length > VERIFICATION_CANDIDATE_MAX_ARGUMENT || total > VERIFICATION_CANDIDATE_MAX_TOTAL_ARGUMENTS) {
          return deny('CANDIDATE_LIMIT_EXCEEDED');
        }
        if (shellSyntax.test(argument)) return deny('SHELL_SYNTAX');
        normalizedArguments.push(argument.toLowerCase());
      }
      if (VERIFICATION_SHELL_STEMS.has(stem)) return deny('SHELL_OR_ENV_INDIRECTION');
      if (VERIFICATION_PACKAGE_STEMS.has(stem)) return deny('PACKAGE_MANAGER_INDIRECTION');
      if (VERIFICATION_SCRIPT_HOST_STEMS.has(stem) || /\.(?:ps1|vbs|vbe|wsf|wsh|hta)$/.test(basename)) {
        return deny('SCRIPT_HOST_INDIRECTION');
      }
      if (VERIFICATION_INTERPRETER_STEMS.test(stem)) {
        if (normalizedArguments.some((argument) => /^-[ecp]|^--(?:eval|print)(?:=|$)/.test(argument) ||
            (stem === 'deno' && argument === 'eval'))) return deny('INLINE_EVALUATION');
        if (normalizedArguments.some((argument) => /^-r|^--(?:require|import|loader|experimental-loader)(?:=|$)/.test(argument))) {
          return deny('RUNTIME_HOOK');
        }
        return requireCapability('INTERPRETER_IDENTITY_REQUIRED');
      }
      return requireCapability('CANONICAL_IDENTITY_REQUIRED');
    } catch {
      // Getter/proxy failures are untrusted input, not diagnostic authority.
      return deny('INVALID_CANDIDATE');
    }
  }

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

  private static SENSITIVE_FILE_NAMES = new Set([
    '.npmrc',
    '.pypirc',
    '.netrc',
    '.dockerconfigjson',
    'credentials',
    'credentials.json',
    'credential.json',
    'secrets',
    'secrets.json',
    'secret.json',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
  ]);

  private static isSensitivePathPart(part: string): boolean {
    const lower = part.toLowerCase();
    if (this.SENSITIVE_DIRS.includes(lower) || this.SENSITIVE_FILE_NAMES.has(lower)) {
      return true;
    }
    // Environment files commonly use suffixes such as .local, .production,
    // and .development; matching only the literal `.env` is insufficient.
    if (/^\.env(?:$|[._-])/.test(lower)) return true;
    // Treat credential-bearing file extensions and conventional secret names as
    // sensitive even when they are nested under an otherwise ordinary folder.
    if (/(?:^|[._-])(secret|secrets|credential|credentials|password|passwd|token|api[_-]?key)(?:[._-]|$)/.test(lower)) {
      return true;
    }
    if (/\.(?:pem|key|p12|pfx|kdbx|jks)$/i.test(lower)) return true;
    return false;
  }

  private static findExistingAncestor(targetPath: string): string {
    let current = targetPath;
    while (true) {
      try {
        fs.lstatSync(current);
        return current;
      } catch {
        const parent = path.dirname(current);
        if (parent === current) return current;
        current = parent;
      }
    }
  }

  private static isMissingPathError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
  }

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
    const canonicalTarget = path.normalize(path.resolve(targetPath));
    const canonicalRoot = path.normalize(path.resolve(repositoryRoot));

    // 1. Strict path containment using path.relative() to avoid prefix confusion
    // (for example, repo vs repo-evil). Containment is checked before file-name
    // classification so an outside path is reported as an outside path even if
    // its basename happens to look secret-bearing.
    const normalizedLower = canonicalTarget.toLowerCase();
    const relPath = path.relative(canonicalRoot, canonicalTarget);
    if (
      relPath === '..' ||
      relPath.startsWith('..' + path.sep) ||
      relPath.startsWith('../') ||
      relPath.startsWith('..\\') ||
      path.isAbsolute(relPath)
    ) {
      const sensitivePart = normalizedLower.split(/[\\/]/).find((part) => this.isSensitivePathPart(part));
      return {
        allowed: false,
        decision: 'DENY',
        reason: sensitivePart
          ? `Target path "${targetPath}" is outside the authorized project root "${repositoryRoot}"; sensitive credential path element "${sensitivePart}" is also blocked.`
          : `Target path "${targetPath}" is outside the authorized project root "${repositoryRoot}".`,
      };
    }

    // 2. Sensitive credential/file check within repository root
    const pathParts = relPath.toLowerCase().split(path.sep);

    for (const part of pathParts) {
      if (this.isSensitivePathPart(part)) {
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

  /**
   * Evaluate a path after resolving every existing component through the OS.
   * The lexical check above is still required because context manifests may
   * contain a not-yet-created file, but the realpath check prevents an
   * existing symlink or junction from escaping the real repository root.
   */
  public static evaluateRealPathAccess(
    targetPath: string,
    repositoryRoot: string,
    isWrite: boolean = false,
  ): PolicyEvaluationResult {
    const lexical = this.evaluatePathAccess(targetPath, repositoryRoot, isWrite);
    if (!lexical.allowed) return lexical;

    const canonicalRoot = path.normalize(path.resolve(repositoryRoot));
    const canonicalTarget = path.normalize(path.resolve(targetPath));

    // Context manifests may be built from a virtual or not-yet-created
    // repository root (for example, durable metadata tests). There is no
    // filesystem identity to resolve in that case, so retain the lexical
    // containment and sensitive-name decision. Once the root exists, every
    // existing component still goes through the realpath checks below; a
    // broken symlink/junction or any other resolution error remains fail
    // closed.
    try {
      fs.lstatSync(canonicalRoot);
    } catch (error: unknown) {
      if (this.isMissingPathError(error)) return lexical;
      return {
        allowed: false,
        decision: 'DENY',
        reason: `Unable to inspect repository root for "${repositoryRoot}" safely.`,
      };
    }

    try {
      const realRoot = path.normalize(fs.realpathSync.native(canonicalRoot));
      const existingAncestor = this.findExistingAncestor(canonicalTarget);
      const realAncestor = path.normalize(fs.realpathSync.native(existingAncestor));
      const ancestorRelative = path.relative(realRoot, realAncestor);
      if (
        ancestorRelative === '..' ||
        ancestorRelative.startsWith('..' + path.sep) ||
        ancestorRelative.startsWith('../') ||
        ancestorRelative.startsWith('..\\') ||
        path.isAbsolute(ancestorRelative)
      ) {
        return {
          allowed: false,
          decision: 'DENY',
          reason: `Resolved path component for "${targetPath}" is outside the authorized project root.`,
        };
      }

      // If the requested path itself exists, resolve it too. This catches a
      // final symlink whose parent remains inside the repository.
      let realTarget = realAncestor;
      try {
        fs.lstatSync(canonicalTarget);
        realTarget = path.normalize(fs.realpathSync.native(canonicalTarget));
      } catch (err: unknown) {
        // A missing final file is allowed for manifest metadata, but a broken
        // symlink is not an admissible context target.
        try {
          if (fs.lstatSync(canonicalTarget).isSymbolicLink()) {
            return {
              allowed: false,
              decision: 'DENY',
              reason: `Context path "${targetPath}" is a broken symbolic link.`,
            };
          }
        } catch {
          // The path genuinely does not exist; retain the ancestor check.
        }
      }

      const targetRelative = path.relative(realRoot, realTarget);
      if (
        targetRelative === '..' ||
        targetRelative.startsWith('..' + path.sep) ||
        targetRelative.startsWith('../') ||
        targetRelative.startsWith('..\\') ||
        path.isAbsolute(targetRelative)
      ) {
        return {
          allowed: false,
          decision: 'DENY',
          reason: `Resolved path "${targetPath}" is outside the authorized project root.`,
        };
      }

      return this.evaluatePathAccess(realTarget, realRoot, isWrite);
    } catch {
      return {
        allowed: false,
        decision: 'DENY',
        reason: `Unable to resolve real path for "${targetPath}" safely.`,
      };
    }
  }

  public static evaluateGitCommand(args: string[]): PolicyEvaluationResult {
    const lowerArgs = args.map((a) => a.toLowerCase());

    // Deny destructive git push operations
    if (
      lowerArgs.includes('--force') ||
      lowerArgs.includes('-f') ||
      lowerArgs.includes('--force-with-lease') ||
      lowerArgs.some((a) => a.startsWith('-f='))
    ) {
      return {
        allowed: false,
        decision: 'DENY',
        reason: 'Force-pushing or force operations on Git branches are prohibited by security policy.',
      };
    }

    // Deny destructive reset/clean operations
    if (lowerArgs.includes('reset') && lowerArgs.includes('--hard')) {
      return {
        allowed: false,
        decision: 'DENY',
        reason: 'Destructive git reset --hard operations require manual owner intervention.',
      };
    }

    if (lowerArgs.includes('clean') && lowerArgs.some((a) => a.includes('-f') || a.includes('-fdx'))) {
      return {
        allowed: false,
        decision: 'DENY',
        reason: 'Destructive git clean operations require manual owner intervention.',
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

    // 3. Automatic Git policy delegation
    if (execBase === 'git' || execBase === 'git.exe') {
      const gitPolicy = this.evaluateGitCommand(args);
      if (!gitPolicy.allowed) {
        return gitPolicy;
      }
    }

    const lowerArgs = args.map((a) => a.toLowerCase());

    // 4. Block inline code-eval modes across runtimes
    // Node.js: -e, --eval, -p, --print
    if (['node', 'node.exe'].includes(execBase)) {
      if (
        lowerArgs.some(
          (a) =>
            a === '-e' ||
            a === '--eval' ||
            a === '-p' ||
            a === '--print' ||
            a.startsWith('-e=') ||
            a.startsWith('--eval=')
        )
      ) {
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

    // 5. External dependency installation requires owner approval
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
