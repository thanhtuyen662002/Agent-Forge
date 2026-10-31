import fs from 'fs';
import path from 'path';
import type { Repository } from '../database/repositories';
import { validateContextPaths } from '../protocol/planProtocol';

/** At most this many repository files one failure names join the task's context at once (#328). */
export const MAX_CONTEXT_ADDED_PER_FAILURE = 8;
/**
 * A repository-relative source, test, config or documentation file path, as test runners, coders and
 * sync errors print it. Documentation counts (#349): a VidFlow coder blocked on a missing docs/PLAN.md.
 */
const CONTEXT_FILE_PATTERN = /(?<![\w./\\:-])((?:[\w.-]+[\\/])*[\w.-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|yml|yaml|html|css|txt|astro|vue|svelte))(?![\w])/g;

/**
 * A relative module specifier as an import names it, without an extension: "./insurance",
 * "../core/tax" (#372). Phiếu Lương: a coder blocked because salary.ts imports ./insurance,
 * ./money, ./period and ./tax, which its workspace lacked, and none had an extension to match.
 */
const MODULE_SPECIFIER_PATTERN = /(?<![\w./\\:-])(\.{1,2}\/[\w-]+(?:\/[\w-]+)*)(?![\w./-])/g;
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.jsx', '.mjs', '.astro', '/index.ts', '/index.js'];

/** Files an extensionless relative import resolves to from any file or folder already in context. */
function moduleCandidates(root: string, current: readonly string[], specifier: string): string[] {
  const directories = [...new Set(current.flatMap((entry) => {
    const normalized = entry.replace(/\\/g, '/');
    return [path.posix.dirname(normalized), normalized];
  }))];
  const found: string[] = [];
  for (const directory of directories) {
    const base = path.posix.normalize(path.posix.join(directory, specifier));
    if (base.startsWith('..') || base.split('/').some((part) => part === 'node_modules' || part === '.git')) continue;
    const file = MODULE_EXTENSIONS.map((extension) => base + extension)
      .find((entry) => fs.statSync(path.resolve(root, entry), { throwIfNoEntry: false })?.isFile());
    if (file) found.push(file);
  }
  return found;
}

/**
 * A coder sees only its task's context paths (#328). In VidFlow M1 coders spent their
 * revisions on tests and callers they could not see ("test at test\cli-ref.test.ts:28",
 * "the workspace is missing src/migrations.ts", a sync refused for an existing
 * src/migrations.ts). Existing repository files such a failure names are added to the
 * task's context for the next run, bounded and validated like planned context paths.
 * A task without explicit context paths already sees the top-level entries and is left
 * alone. Returns the added paths.
 */
export function widenTaskContext(repo: Repository, projectId: string, taskId: string, texts: readonly string[]): string[] {
  const project = repo.getProjectMetadata(projectId);
  const current = repo.getTaskContextPaths(projectId, taskId);
  if (!project?.repository_path || current.length === 0) return [];
  const root = project.repository_path;
  const known = new Set(current.map((entry) => entry.toLowerCase()));
  const candidates: string[] = [];
  for (const text of texts) {
    for (const match of String(text).matchAll(CONTEXT_FILE_PATTERN)) {
      if (candidates.length >= MAX_CONTEXT_ADDED_PER_FAILURE) break;
      const written = match[1].replace(/\\/g, '/').replace(/^\.\//, '');
      if (written.split('/').some((part) => part === '..' || part === 'node_modules' || part === '.git')) continue;
      // A bare file name ("cli-project.test.ts") is looked up where tests and sources usually live.
      const relative = (written.includes('/') ? [written] : ['', 'test/', 'tests/', 'src/'].map((dir) => dir + written))
        .find((entry) => fs.statSync(path.resolve(root, entry), { throwIfNoEntry: false })?.isFile());
      if (!relative) continue;
      const key = relative.toLowerCase();
      if (known.has(key) || candidates.some((entry) => entry.toLowerCase() === key)) continue;
      candidates.push(relative);
    }
    for (const match of String(text).matchAll(MODULE_SPECIFIER_PATTERN)) {
      for (const relative of moduleCandidates(root, current, match[1])) {
        if (candidates.length >= MAX_CONTEXT_ADDED_PER_FAILURE) break;
        const key = relative.toLowerCase();
        if (known.has(key) || candidates.some((entry) => entry.toLowerCase() === key)) continue;
        candidates.push(relative);
      }
    }
  }
  if (candidates.length === 0) return [];
  // Planned paths the coder has not created yet stay valid (#330); every candidate was found on
  // disk above. Without this, one planned "electron" folder disabled all widening (VidFlow M8.4, #360).
  const check = validateContextPaths(root, [...current, ...candidates], { allowMissing: true });
  if (!check.ok) return [];
  repo.setTaskContextPaths(projectId, taskId, check.paths);
  return candidates;
}
