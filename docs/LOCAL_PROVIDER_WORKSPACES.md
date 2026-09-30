# Local provider execution workspaces

Local CLI providers execute from a short-lived, per-execution workspace. The
workspace is created below the operating system temporary directory and is
owned by the Agent Forge process. It contains only the regular files named by
the durable execution context manifest; the project repository is never used
as the provider's current working directory.

## Boundary and data flow

Before spawning a provider, `LocalCliAdapterBase` canonicalizes the project
root and every context path. Absolute paths, traversal, sensitive names
(`.env*`, `.git`, credentials, private keys, and similar names), symlinks, and
Windows junction/reparse points are rejected. A directory context is walked
with the same policy for every child; denied children are omitted, while an
explicitly denied path fails the execution. Reads are descriptor based and
bounded to 4 MiB per file, 256 files, and 16 MiB per workspace. Directory
enumeration is bounded to 128 manifest paths, 512 traversed entries, and 128
directory levels before any workspace file is materialized.

Each execution receives a random workspace directory and a sibling marker that
contains the execution ID, owner token, ownership digest, creation time, state,
and the workspace identity (filesystem key plus canonical path). Marker names
are bound to their filenames before recovery targets are resolved, and a
replacement workspace with a different identity is retained for manual
recovery. The provider sees this directory as its `cwd`; it does not receive
the source repository path through the prompt or environment. Version probes
also run from a disposable temporary directory. Workspace parents are created
as real directories and the workspace identity is fenced throughout cleanup.

Only an existing, authorized context file can be synchronized back. A valid
`coder.v1` protocol is required before synchronization. All source and
workspace entries are preflighted before the first write; the source file's
identity and SHA-256 hash are checked again, the replacement is written through
a flushed temporary file, and the parent directory and target identity are
revalidated before an atomic rename. If a later entry conflicts after an
earlier entry was written, earlier writes are rolled back in reverse order only
while their identity and provider-result hash still match. A concurrent
replacement is never overwritten during rollback and is reported as a rollback
failure. Provider failures, invalid protocols, or conflicts therefore never
silently become task success. Windows alternate data stream paths are rejected
as context paths.

Cleanup verifies the marker owner, ownership digest, and workspace identity
before removing the directory. A cleanup failure leaves a typed
`CLEANUP_FAILED` marker and causes the execution to fail. On the next
preparation, markers older than the six-hour stale threshold are recovered only
when they are well formed and point at a real directory. Active executions are
never recovered by another process in the same runtime.

## Platform limitations

This mechanism is a sanitized working-directory boundary, not a kernel-level
sandbox. The provider process still runs as the Agent Forge user and could
attempt an absolute path, inspect unrelated temporary files, or leave a
detached child process. Windows does not expose a portable Node.js
`O_NOFOLLOW` equivalent, so Windows relies on `lstat`/realpath identity checks
and reparse-point rejection; a hostile process with the same user privileges
can still race filesystem operations. POSIX systems require `O_NOFOLLOW` for
descriptor reads, and platforms that cannot provide it fail closed.

Deployments that execute an intentionally hostile or multi-tenant provider
must add an OS/container sandbox with filesystem, process, and network policy.
The local workspace remains the application-level least-privilege boundary and
the durable evidence/cleanup fence even when such a stronger sandbox is used.
