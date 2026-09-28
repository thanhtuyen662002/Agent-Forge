'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const DEFAULT_LEASE_HOURS = 8;
const SHA = /^[0-9a-f]{40}$/i;
const PENDING_STATUSES = new Set(['queued', 'in_progress', 'requested', 'waiting', 'pending']);
const PASS_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);
const FAILURE_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'action_required',
  'startup_failure',
]);

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function asString(value) {
  return typeof value === 'string' ? value : String(value ?? '');
}

function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function decodeScalar(raw) {
  const value = asString(raw).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const quote = value[0];
    const inner = value.slice(1, -1);
    return quote === '"' ? inner.replace(/\\(["\\])/g, '$1') : inner.replace(/''/g, "'");
  }
  return value;
}

function decodeInlineList(raw) {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  const values = [];
  let token = '';
  let quote = null;
  for (const character of inner) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
      token += character;
      continue;
    }
    if (character === ',' && !quote) {
      values.push(decodeScalar(token));
      token = '';
      continue;
    }
    token += character;
  }
  if (quote) throw new Error('unterminated inline list quote');
  values.push(decodeScalar(token));
  return values;
}

/**
 * Parse only the small, deliberately restricted contract subset needed by the
 * report. This is not a general YAML parser. Invalid or ambiguous blocks are
 * returned as errors so the report never silently treats malformed work as
 * executable.
 */
function parseContractBlock(body, contractName, listFields) {
  const text = typeof body === 'string' ? body.replace(/\r/g, '') : '';
  const markerPresent = new RegExp(`(^|\\n)${contractName}\\s*:`, 'm').test(text);
  if (typeof body !== 'string') {
    return { found: false, markerPresent: false, values: {}, errors: [`${contractName}: body is not a string`] };
  }

  const candidates = [];
  const fenced = /```(?:yaml|yml)[ \t]*\n([\s\S]*?)\n```/gi;
  let match;
  while ((match = fenced.exec(text)) !== null) {
    const lines = match[1].split('\n');
    if ((lines[0] || '').trim() === `${contractName}:`) candidates.push(lines);
  }

  if (candidates.length === 0) {
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim() !== `${contractName}:`) continue;
      const candidate = [lines[index]];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        if (!lines[cursor].trim()) break;
        if (!/^ {2}/.test(lines[cursor])) break;
        candidate.push(lines[cursor]);
      }
      if (candidate.length > 1) candidates.push(candidate);
    }
  }

  if (candidates.length === 0) {
    return {
      found: false,
      markerPresent,
      values: {},
      errors: markerPresent ? [`${contractName}: contract block is malformed`] : [],
    };
  }
  if (candidates.length > 1) {
    return { found: false, markerPresent: true, values: {}, errors: [`${contractName}: duplicate contract blocks`] };
  }

  const values = Object.create(null);
  const errors = [];
  let currentList = null;
  const lines = candidates[0];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    const listItem = /^ {4}-[ \t]*(.*)$/.exec(line);
    if (listItem) {
      if (!currentList || !Array.isArray(values[currentList])) {
        errors.push(`${contractName}: unexpected list item`);
      } else if (!listItem[1].trim()) {
        errors.push(`${contractName}.${currentList}: empty list item`);
      } else {
        values[currentList].push(decodeScalar(listItem[1]));
      }
      continue;
    }
    const field = /^ {2}([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]*(.*))?$/.exec(line);
    if (!field) {
      errors.push(`${contractName}: malformed field indentation`);
      currentList = null;
      continue;
    }
    const key = field[1];
    if (own(values, key)) {
      errors.push(`${contractName}.${key}: duplicate field`);
      currentList = null;
      continue;
    }
    const raw = field[2] ?? '';
    if (listFields.has(key)) {
      if (!raw.trim() || raw.trim() === '[]') {
        values[key] = [];
        currentList = key;
      } else if (raw.trim().startsWith('[') && raw.trim().endsWith(']')) {
        try {
          values[key] = decodeInlineList(raw.trim());
        } catch (error) {
          errors.push(`${contractName}.${key}: ${error instanceof Error ? error.message : String(error)}`);
        }
        currentList = null;
      } else {
        errors.push(`${contractName}.${key}: expected [] or an indented list`);
        currentList = null;
      }
      continue;
    }
    if (!raw.trim()) {
      errors.push(`${contractName}.${key}: value is required`);
      currentList = null;
      continue;
    }
    values[key] = decodeScalar(raw);
    currentList = null;
  }
  return { found: true, markerPresent: true, values, errors };
}

function parseTaskContract(issue) {
  const parsed = parseContractBlock(issue && issue.body, 'AF_TASK_V1', new Set([
    'blocked_by',
    'conflicts_with',
    'paths',
    'forbidden_paths',
  ]));
  const values = parsed.values || {};
  return {
    ...parsed,
    number: Number(issue && issue.number),
    title: asString(issue && issue.title),
    status: values.status || null,
    priority: values.priority || null,
    blockedBy: Array.isArray(values.blocked_by) ? values.blocked_by.map(Number).filter(Number.isSafeInteger) : [],
    paths: Array.isArray(values.paths) ? values.paths.map(String) : [],
  };
}

function parsePullRequestContract(pr) {
  const parsed = parseContractBlock(pr && pr.body, 'AF_PR_V1', new Set(['paths', 'blocked_by']));
  const values = parsed.values || {};
  const closingReferences = [];
  const body = typeof (pr && pr.body) === 'string' ? pr.body : '';
  const closingPattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
  let match;
  while ((match = closingPattern.exec(body)) !== null) closingReferences.push(Number(match[1]));
  const issueValue = /^\d+$/.test(String(values.issue || '')) ? Number(values.issue) : null;
  return {
    ...parsed,
    issueNumber: Number.isSafeInteger(issueValue) && issueValue > 0 ? issueValue : (closingReferences[0] || null),
    phase: values.phase || null,
    paths: Array.isArray(values.paths) ? values.paths.map(String) : [],
    closingReferences,
  };
}

function normalizePath(value) {
  return asString(value).trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function globToRegExp(pattern) {
  const value = normalizePath(pattern);
  let source = '^';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '*' && value[index + 1] === '*') {
      if (value[index + 2] === '/') {
        source += '(?:.*/)?';
        index += 2;
      } else {
        source += '.*';
        index += 1;
      }
    } else if (character === '*') {
      source += '[^/]*';
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function pathMatches(pattern, file) {
  try {
    return globToRegExp(pattern).test(normalizePath(file));
  } catch {
    return false;
  }
}

function checkTimestamp(check) {
  return parseTimestamp(check.completedAt)
    ?? parseTimestamp(check.updatedAt)
    ?? parseTimestamp(check.startedAt)
    ?? parseTimestamp(check.createdAt)
    ?? 0;
}

function normalizeCheck(check, fallbackHeadSha) {
  const status = asString(check && check.status).toLowerCase();
  const state = asString(check && check.state).toLowerCase();
  let conclusion = asString(check && check.conclusion).toLowerCase() || null;
  if (!conclusion && state && state !== 'pending') conclusion = state;
  return {
    id: asString(check && (check.id || check.databaseId || check.externalId || check.name)),
    name: asString(check && (check.name || check.context || 'unnamed check')),
    headSha: asString(check && (check.headSha || check.head_sha || fallbackHeadSha)) || null,
    status: status || (state === 'pending' ? 'pending' : 'completed'),
    state,
    conclusion,
    timestamp: checkTimestamp(check || {}),
    detailsUrl: asString(check && (check.detailsUrl || check.details_url || check.targetUrl)),
  };
}

function classifyCheck(check) {
  if (PENDING_STATUSES.has(check.status) || check.state === 'pending') return 'pending';
  if (check.conclusion === 'cancelled') return 'cancelled';
  if (PASS_CONCLUSIONS.has(check.conclusion)) return 'pass';
  if (FAILURE_CONCLUSIONS.has(check.conclusion)) return 'failure';
  return 'unknown';
}

function summarizeChecks(pr) {
  const headSha = asString(pr && (pr.headRefOid || pr.headSha));
  const source = Array.isArray(pr && pr.checks)
    ? pr.checks
    : (Array.isArray(pr && pr.statusCheckRollup) ? pr.statusCheckRollup : []);
  const normalized = source.map((check) => normalizeCheck(check, null));
  const exact = normalized.filter((check) => Boolean(headSha) && check.headSha === headSha);
  const stale = normalized.filter((check) => check.headSha !== headSha);
  const byName = new Map();
  for (const check of exact) {
    const list = byName.get(check.name) || [];
    list.push(check);
    byName.set(check.name, list);
  }

  const pending = [];
  const failures = [];
  const cancelled = [];
  const supersededCancelled = [];
  const unknown = [];
  const passing = [];
  for (const [name, checks] of byName.entries()) {
    checks.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
    const latest = checks[checks.length - 1];
    const classification = classifyCheck(latest);
    if (classification === 'pending') pending.push(latest);
    else if (classification === 'failure') failures.push(latest);
    else if (classification === 'cancelled') cancelled.push(latest);
    else if (classification === 'unknown') unknown.push(latest);
    else passing.push(latest);

    for (let index = 0; index < checks.length - 1; index += 1) {
      if (classifyCheck(checks[index]) === 'cancelled') supersededCancelled.push({ ...checks[index], name });
    }
  }

  let status = 'NO_CHECKS';
  if (failures.length > 0) status = 'FAIL';
  else if (pending.length > 0) status = 'PENDING';
  else if (unknown.length > 0) status = 'UNKNOWN';
  else if (cancelled.length > 0) status = 'CANCELLED';
  else if (passing.length > 0) status = 'PASS';

  return {
    number: Number(pr && pr.number),
    headSha,
    exactHead: Boolean(headSha) && exact.length > 0,
    status,
    checks: exact.length,
    stale,
    pending,
    failures,
    cancelled,
    supersededCancelled,
    unknown,
    passing,
  };
}

function openIssueSet(issues) {
  return new Set(issues.map((issue) => Number(issue.number)).filter(Number.isSafeInteger));
}

function issueReadiness(issues) {
  const open = openIssueSet(issues);
  const parsed = issues.map(parseTaskContract);
  const ready = parsed.filter((issue) => issue.status === 'READY');
  const executable = ready.filter((issue) => issue.blockedBy.every((dependency) => !open.has(dependency)));
  const malformed = parsed.filter((issue) => issue.markerPresent && (!issue.found || issue.errors.length > 0));
  return { parsed, ready, executable, malformed };
}

function ageHours(value, now) {
  const timestamp = parseTimestamp(value);
  if (timestamp === null) return null;
  return Math.max(0, (now - timestamp) / 3_600_000);
}

function staleDrafts(prs, capturedAt, leaseHours) {
  const now = parseTimestamp(capturedAt);
  if (now === null) throw new Error('WATCHDOG_CAPTURED_AT_INVALID');
  return prs.filter((pr) => pr.isDraft === true).flatMap((pr) => {
    const age = ageHours(pr.updatedAt || pr.createdAt, now);
    if (age === null || age <= leaseHours) return [];
    const checkSummary = summarizeChecks(pr);
    const phase = parsePullRequestContract(pr).phase;
    if (phase === 'WAITING_CI' || phase === 'BLOCKED' || checkSummary.pending.length > 0) return [];
    return [{
      number: Number(pr.number),
      title: asString(pr.title),
      ageHours: Number(age.toFixed(2)),
      headSha: asString(pr.headRefOid || pr.headSha),
      reason: checkSummary.cancelled.length > 0 ? 'old draft has no live CI and only cancelled checks' : 'old draft has no live CI or declared wait',
    }];
  });
}

function prFiles(pr) {
  return (Array.isArray(pr && pr.files) ? pr.files : [])
    .map((file) => typeof file === 'string' ? file : file && file.path)
    .filter(Boolean)
    .map(normalizePath);
}

function pathConflicts(prs) {
  const conflicts = [];
  const unscoped = [];
  const parsed = prs.map((pr) => ({ pr, contract: parsePullRequestContract(pr), files: prFiles(pr) }));
  for (const item of parsed) {
    if (item.contract.paths.length > 0) {
      const outside = item.files.filter((file) => !item.contract.paths.some((pattern) => pathMatches(pattern, file)));
      if (outside.length > 0) unscoped.push({ number: Number(item.pr.number), files: outside });
    }
  }
  for (let left = 0; left < parsed.length; left += 1) {
    for (let right = left + 1; right < parsed.length; right += 1) {
      const a = parsed[left];
      const b = parsed[right];
      const sameFiles = a.files.filter((file) => b.files.includes(file));
      const crossFiles = [
        ...a.files.filter((file) => b.contract.paths.some((pattern) => pathMatches(pattern, file))),
        ...b.files.filter((file) => a.contract.paths.some((pattern) => pathMatches(pattern, file))),
      ].filter((file, index, all) => all.indexOf(file) === index);
      const sameDeclared = a.contract.paths.filter((pattern) => b.contract.paths.includes(pattern));
      if (sameFiles.length > 0 || crossFiles.length > 0 || sameDeclared.length > 0) {
        conflicts.push({
          left: Number(a.pr.number),
          right: Number(b.pr.number),
          files: [...new Set([...sameFiles, ...crossFiles])],
          declaredPaths: sameDeclared,
        });
      }
    }
  }
  return { conflicts, unscoped };
}

function duplicateClaims(prs) {
  const claims = new Map();
  for (const pr of prs) {
    const contract = parsePullRequestContract(pr);
    if (!Number.isSafeInteger(contract.issueNumber) || contract.issueNumber <= 0) continue;
    const list = claims.get(contract.issueNumber) || [];
    list.push(Number(pr.number));
    claims.set(contract.issueNumber, list);
  }
  return [...claims.entries()]
    .filter(([, numbers]) => numbers.length > 1)
    .map(([issueNumber, prsForIssue]) => ({ issueNumber, prs: prsForIssue }));
}

function ciStalls(prs, checkSummaries) {
  const stalls = [];
  prs.forEach((pr, index) => {
    const summary = checkSummaries[index];
    if (!summary.exactHead || summary.checks === 0) {
      stalls.push({ number: Number(pr.number), kind: 'NO_EXACT_HEAD_CHECKS', detail: 'no check run is bound to the current PR head SHA' });
    }
    for (const check of summary.pending) {
      stalls.push({ number: Number(pr.number), kind: 'PENDING', detail: check.name });
    }
    for (const check of summary.cancelled) {
      stalls.push({ number: Number(pr.number), kind: 'CANCELLED', detail: `${check.name} has no newer replacement` });
    }
  });
  return stalls;
}

function buildHealthReport(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('WATCHDOG_SNAPSHOT_INVALID');
  const issues = Array.isArray(snapshot.issues) ? snapshot.issues : [];
  const prs = Array.isArray(snapshot.pullRequests) ? snapshot.pullRequests : [];
  const capturedAt = options.now || snapshot.capturedAt;
  if (parseTimestamp(capturedAt) === null) throw new Error('WATCHDOG_CAPTURED_AT_INVALID');
  const leaseHours = Number(options.leaseHours ?? snapshot.leaseHours ?? DEFAULT_LEASE_HOURS);
  if (!Number.isFinite(leaseHours) || leaseHours <= 0) throw new Error('WATCHDOG_LEASE_HOURS_INVALID');
  const readiness = issueReadiness(issues);
  const checks = prs.map(summarizeChecks);
  const paths = pathConflicts(prs);
  return {
    repository: asString(snapshot.repository || 'unknown'),
    capturedAt,
    leaseHours,
    issueCount: issues.length,
    prCount: prs.length,
    ready: readiness.ready,
    executableReady: readiness.executable,
    malformedTasks: readiness.malformed,
    staleDrafts: staleDrafts(prs, capturedAt, leaseHours),
    checks,
    duplicateClaims: duplicateClaims(prs),
    pathConflicts: paths.conflicts,
    unscopedChanges: paths.unscoped,
    ciStalls: ciStalls(prs, checks),
    truncated: Boolean(snapshot.truncated),
  };
}

function shortTitle(value) {
  return asString(value).replace(/[\r\n]+/g, ' ').trim().slice(0, 160);
}

function checkNames(checks) {
  return checks.map((check) => check.name).join(', ') || 'none';
}

function renderHealthReport(result) {
  const lines = [
    '# Agent Forge watchdog health report',
    '',
    `- Repository: \`${result.repository}\``,
    `- Captured at: \`${result.capturedAt}\``,
    `- Draft lease threshold: \`${result.leaseHours} hours\``,
    '- Mode: read-only; this report never closes, merges, labels, or edits GitHub objects.',
    '',
    '## Queue',
    '',
    `- Open Issues inspected: **${result.issueCount}**`,
    `- READY ` + '`AF_TASK_V1`' + ` Issues: **${result.ready.length}**`,
    `- Executable READY Issues after open ` + '`blocked_by`' + `: **${result.executableReady.length}**`,
  ];
  if (result.ready.length > 0) {
    for (const issue of result.ready) lines.push(`- #${issue.number} ${shortTitle(issue.title)}`.trim());
  }
  if (result.malformedTasks.length > 0) {
    lines.push(`- Malformed ` + '`AF_TASK_V1`' + ` contracts: **${result.malformedTasks.map((item) => `#${item.number}`).join(', ')}**`);
  }

  lines.push('', '## Stale Draft PR lease candidates', '');
  if (result.staleDrafts.length === 0) lines.push('- None.');
  else result.staleDrafts.forEach((item) => lines.push(`- PR #${item.number} (${item.ageHours}h old): ${shortTitle(item.title)} — ${item.reason}.`));

  lines.push('', '## Open PR exact-head checks', '');
  if (result.checks.length === 0) lines.push('- None.');
  else result.checks.forEach((item) => {
    const sha = item.headSha || 'missing-head-sha';
    const suffix = item.status === 'PASS'
      ? `checks: ${checkNames(item.passing)}`
      : `${item.status.toLowerCase()}; pending: ${checkNames(item.pending)}; failures: ${checkNames(item.failures)}`;
    lines.push(`- PR #${item.number} @ \`${sha}\`: **${item.status}** (${suffix}).`);
    if (item.stale.length > 0) lines.push(`  - Ignored stale check records: ${checkNames(item.stale)}.`);
    if (item.supersededCancelled.length > 0) lines.push(`  - Superseded cancelled checks (not failures): ${checkNames(item.supersededCancelled)}.`);
  });

  lines.push('', '## Duplicate Issue claims', '');
  if (result.duplicateClaims.length === 0) lines.push('- None.');
  else result.duplicateClaims.forEach((item) => lines.push(`- Issue #${item.issueNumber} is claimed by PRs ${item.prs.map((number) => `#${number}`).join(', ')}.`));

  lines.push('', '## Path-scope conflicts', '');
  if (result.pathConflicts.length === 0 && result.unscopedChanges.length === 0) lines.push('- None.');
  result.pathConflicts.forEach((item) => lines.push(`- PR #${item.left} ↔ PR #${item.right}: ${item.files.length > 0 ? item.files.join(', ') : item.declaredPaths.join(', ')}.`));
  result.unscopedChanges.forEach((item) => lines.push(`- PR #${item.number} changed files outside its declared paths: ${item.files.join(', ')}.`));

  lines.push('', '## CI stalls', '');
  if (result.ciStalls.length === 0) lines.push('- None.');
  else result.ciStalls.forEach((item) => lines.push(`- PR #${item.number}: **${item.kind}** — ${item.detail}.`));

  lines.push('', '## Cancellation semantics', '', '- A cancelled check is never counted as a failure when a newer exact-head record supersedes it. An unresolved cancellation is reported as a stall so an agent can inspect it.', '');
  if (result.truncated) lines.push('> WARNING: GitHub collection was truncated at the configured API page limit; inspect manually before making lease decisions.', '');
  return `${lines.join('\n')}\n`;
}

function runGhJson(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`WATCHDOG_GH_COMMAND_FAILED:${args.slice(0, 3).join(' ')}`);
  }
  try {
    return JSON.parse(result.stdout || 'null');
  } catch {
    throw new Error(`WATCHDOG_GH_JSON_INVALID:${args.slice(0, 3).join(' ')}`);
  }
}

function collectSnapshot(repository) {
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) throw new Error('WATCHDOG_REPOSITORY_INVALID');
  const issues = runGhJson([
    'issue', 'list', '--repo', repository, '--state', 'open', '--limit', '100',
    '--json', 'number,title,state,body,updatedAt,url',
  ]);
  const pullRequests = runGhJson([
    'pr', 'list', '--repo', repository, '--state', 'open', '--limit', '100',
    '--json', 'number,title,state,isDraft,createdAt,updatedAt,headRefName,headRefOid,baseRefName,baseRefOid,body,url',
  ]);
  if (!Array.isArray(issues) || !Array.isArray(pullRequests)) throw new Error('WATCHDOG_GH_COLLECTION_SHAPE_INVALID');
  const enriched = pullRequests.map((pr) => {
    const details = runGhJson(['pr', 'view', String(pr.number), '--repo', repository, '--json', 'files']);
    const checkRuns = runGhJson(['api', `repos/${repository}/commits/${pr.headRefOid}/check-runs?per_page=100`]);
    const statuses = runGhJson(['api', `repos/${repository}/commits/${pr.headRefOid}/status?per_page=100`]);
    const checks = [
      ...((checkRuns && Array.isArray(checkRuns.check_runs)) ? checkRuns.check_runs.map((check) => ({
        id: `check:${check.id}`,
        name: check.name,
        headSha: check.head_sha,
        status: check.status,
        conclusion: check.conclusion,
        startedAt: check.started_at,
        completedAt: check.completed_at,
        detailsUrl: check.details_url,
      })) : []),
      ...((statuses && Array.isArray(statuses.statuses)) ? statuses.statuses.map((status) => ({
        id: `status:${status.id}`,
        name: status.context,
        headSha: pr.headRefOid,
        status: status.state === 'pending' ? 'pending' : 'completed',
        conclusion: status.state === 'pending' ? null : status.state,
        createdAt: status.created_at,
        updatedAt: status.updated_at,
        detailsUrl: status.target_url,
      })) : []),
    ];
    return {
      ...pr,
      files: Array.isArray(details && details.files) ? details.files.map((file) => file.path).filter(Boolean) : [],
      checks,
    };
  });
  return {
    capturedAt: new Date().toISOString(),
    repository,
    issues,
    pullRequests: enriched,
    truncated: issues.length >= 100 || pullRequests.length >= 100,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--collect') result.collect = true;
    else if (argument === '--repo') result.repository = argv[++index];
    else if (argument === '--input') result.input = argv[++index];
    else if (argument === '--output') result.output = argv[++index];
    else if (argument === '--report') result.report = argv[++index];
    else if (argument === '--now') result.now = argv[++index];
    else if (argument === '--lease-hours') result.leaseHours = Number(argv[++index]);
    else throw new Error(`WATCHDOG_ARGUMENT_UNKNOWN:${argument}`);
  }
  return result;
}

function readJsonInput(inputPath) {
  const source = inputPath ? fs.readFileSync(inputPath, 'utf8') : fs.readFileSync(0, 'utf8');
  try {
    return JSON.parse(source);
  } catch {
    throw new Error('WATCHDOG_INPUT_JSON_INVALID');
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.collect) {
    const snapshot = collectSnapshot(args.repository || process.env.GITHUB_REPOSITORY);
    if (!args.output) throw new Error('WATCHDOG_OUTPUT_REQUIRED');
    fs.writeFileSync(args.output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    process.stdout.write(`WATCHDOG_SNAPSHOT_WRITTEN:${args.output}\n`);
    return;
  }
  const snapshot = readJsonInput(args.input);
  const result = buildHealthReport(snapshot, { now: args.now, leaseHours: args.leaseHours });
  const report = renderHealthReport(result);
  if (args.report) fs.writeFileSync(args.report, report, 'utf8');
  process.stdout.write(report);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`WATCHDOG_HEALTH_ERROR:${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_LEASE_HOURS,
  buildHealthReport,
  collectSnapshot,
  duplicateClaims,
  globToRegExp,
  parseContractBlock,
  parsePullRequestContract,
  parseTaskContract,
  pathConflicts,
  renderHealthReport,
  summarizeChecks,
};
