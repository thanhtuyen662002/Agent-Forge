# Security Policy & Execution Governance

## 1. Electron Security Checklist & Acceptance Criteria

Agent-Forge enforces the following non-negotiable security controls in the desktop runtime:

| Control | Configuration | Verification Method |
| :--- | :--- | :--- |
| **Context Isolation** | `contextIsolation: true` | WebPreferences assertion |
| **Node Integration** | `nodeIntegration: false` | WebPreferences assertion |
| **Sandbox** | `sandbox: true` | WebPreferences assertion |
| **Preload Boundary** | Explicit `contextBridge.exposeInMainWorld` | Code review & IPC test |
| **IPC Payload Validation** | Zod schema validation on every handler | Unit & integration tests |
| **No Generic Exec IPC** | Zero arbitrary command endpoints | API audit |
| **Content Security Policy** | Strict CSP header configured | HTTP / HTML meta check |
| **Navigation Restrictions** | Intercept `will-navigate` & `setWindowOpenHandler` | Window lifecycle test |

---

## 2. ProcessRunner Safety Specification

Child processes must never be spawned with arbitrary, unvalidated shell strings.

### Structured Execution Contract
```typescript
interface ProcessExecutionOptions {
  executable: string;                      // e.g. 'npm', 'git', 'pytest'
  args: string[];                          // e.g. ['test', '--', 'auth.test.ts']
  cwd: string;                             // Explicit absolute working directory
  timeoutMs: number;                       // Hard timeout (default: 60,000ms)
  environmentAllowlist?: Record<string, string>; // Filtered env variables
  allowShell?: boolean;                    // Default FALSE
}
```

### Safety Rules
1. **`shell: false` By Default**: Commands are spawned directly with argument vectors, preventing shell expansion, piping, and command chaining (`&&`, `||`, `;`, `|`).
2. **Path Sanitization**: `cwd` must resolve to an allowed subpath inside the project repository.
3. **Emergency Stop Hook**: All spawned processes register their PID in a tracked registry. Emergency Stop invokes process-tree termination.

---

## 3. Policy Matrix

The `PolicyService` evaluates all actions against the following policy rules:

| Action Category | Target Action | Default Policy |
| :--- | :--- | :--- |
| **Filesystem** | Read files within project | `ALLOW` |
| **Filesystem** | Write files within project | `ALLOW` |
| **Filesystem** | Write files outside project | `DENY` |
| **Filesystem** | Access `~/.ssh`, `~/.aws`, `%USERPROFILE%` | `DENY` |
| **Git** | `git status`, `git diff`, `git log` | `ALLOW` |
| **Git** | Create local task branch / worktree | `ALLOW` |
| **Git** | `git push --force` or push to `main` | `DENY` |
| **Git** | Delete repository | `DENY` |
| **Process** | Run configured project test command | `ALLOW` |
| **Process** | Run configured linter / typechecker | `ALLOW` |
| **Process** | Install new dependencies (`npm install <pkg>`) | `REQUIRES_OWNER_APPROVAL` |
| **Process** | Arbitrary shell script execution | `REQUIRES_OWNER_APPROVAL` |
| **Deployment** | Production deploy / Database migration | `OWNER_ONLY` |

---

## 4. Secret Handling & Redaction

Agent-Forge guarantees:
1. Secrets, tokens, and credentials are never stored in SQLite plaintext.
2. The `ProcessRunner` and `EventService` automatically scrub common secret patterns prior to logging or generating review packages:
   - AWS Access Keys (`AKIA[0-9A-Z]{16}`)
   - Bearer Tokens & JWTs (`Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*`)
   - Private Keys (`-----BEGIN (?:RSA )?PRIVATE KEY-----`)
   - Generic API Keys (`[a-zA-Z0-9_-]{32,}`)
