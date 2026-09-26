const { execFileSync } = require('node:child_process');

const SHA = /^[0-9a-f]{40}$/i;

function requiresPackage(paths) {
  if (paths.length === 0) return true;
  return paths.some((file) => file.split('/').some((segment) => !segment || segment === '.' || segment === '..') || !(
    file === 'README.md' ||
    file === 'AGENTS.md' ||
    file === '.github/PULL_REQUEST_TEMPLATE.md' ||
    /^\.github\/ISSUE_TEMPLATE\/[^/]+$/.test(file) ||
    /^docs\/[^/]+(?:\/[^/]+)*$/.test(file)
  ));
}

function classifyPullRequest(baseSha, headSha, cwd = process.cwd()) {
  if (!SHA.test(baseSha) || !SHA.test(headSha)) throw new Error('CI_SCOPE_INVALID_SHA');
  // No rename detection: a move from runtime into docs must include the deleted source path.
  const diff = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${baseSha}...${headSha}`], {
    cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  return requiresPackage(diff.split('\0').filter(Boolean));
}

if (require.main === module) {
  try {
    const required = process.env.GITHUB_EVENT_NAME === 'pull_request'
      ? classifyPullRequest(process.argv[2], process.argv[3])
      : true;
    process.stdout.write(`package_required=${required}\n`);
  } catch (error) {
    process.stderr.write(`CI_SCOPE_CLASSIFICATION_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = { requiresPackage, classifyPullRequest };
