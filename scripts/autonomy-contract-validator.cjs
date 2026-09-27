'use strict';

const fs = require('node:fs');

// The web-first contract became authoritative when bootstrap commit 4fd7b58
// reached main. PRs and Issues created before this instant are explicitly
// grandfathered when they do not contain a contract marker.
const CONTRACT_EFFECTIVE_AT = '2026-09-26T05:10:04Z';
const CONTRACT_EFFECTIVE_SHA = '4fd7b58a45e074439e33ab396a9d2fd9234261d9';
const SHA = /^[0-9a-f]{40}$/i;

const TASK_FIELDS = new Set([
  'priority', 'status', 'area', 'type', 'execution', 'base_mode',
  'blocked_by', 'conflicts_with', 'paths', 'forbidden_paths', 'risk',
]);
const PR_FIELDS = new Set([
  'issue', 'phase', 'base_sha', 'base_mode', 'paths', 'blocked_by', 'risk',
]);
const PR_OPTIONAL_FIELDS = new Set(['reviewed_head_sha']);
const TASK_LIST_FIELDS = new Set(['blocked_by', 'conflicts_with', 'paths', 'forbidden_paths']);
const PR_LIST_FIELDS = new Set(['paths', 'blocked_by']);

const TASK_REQUIRED_SECTIONS = [
  'Problem',
  'Why this matters',
  'Scope',
  'Acceptance criteria',
  'Required tests',
  'Non-goals',
  'Safety / invariants',
  'Dependencies',
];

const TASK_ENUMS = {
  priority: new Set(['P0', 'P1', 'P2', 'P3']),
  status: new Set(['READY', 'BLOCKED', 'EXTERNAL', 'DONE']),
  execution: new Set(['WEB', 'EXTERNAL']),
  base_mode: new Set(['MAIN', 'STACKED']),
  risk: new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
};

const PR_ENUMS = {
  phase: new Set(['IMPLEMENTING', 'WAITING_CI', 'REVIEWING', 'BLOCKED', 'READY_TO_MERGE']),
  base_mode: new Set(['MAIN', 'STACKED']),
  risk: new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
};

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isHistorical(createdAt) {
  if (typeof createdAt !== 'string') return false;
  const timestamp = Date.parse(createdAt);
  return Number.isFinite(timestamp) && timestamp < Date.parse(CONTRACT_EFFECTIVE_AT);
}

function decodeScalar(raw, field) {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error(`${field}: value is required`);
  if ((value.startsWith('"') && !value.endsWith('"')) || (value.startsWith("'") && !value.endsWith("'"))) {
    throw new Error(`${field}: unterminated quoted scalar`);
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    const quote = value[0];
    const inner = value.slice(1, -1);
    if (quote === '"') return inner.replace(/\\(["\\])/g, '$1');
    return inner.replace(/''/g, "'");
  }
  return value;
}

function decodeInlineList(raw, field) {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let token = '';
  let quote = null;
  for (const character of inner) {
    if ((character === '"' || character === "'") && (!quote || quote === character)) {
      quote = quote ? null : character;
      token += character;
      continue;
    }
    if (character === ',' && !quote) {
      if (!token.trim()) throw new Error(`${field}: empty inline list item`);
      items.push(decodeScalar(token, field));
      token = '';
      continue;
    }
    token += character;
  }
  if (quote) throw new Error(`${field}: unterminated inline list quote`);
  if (!token.trim()) throw new Error(`${field}: empty inline list item`);
  items.push(decodeScalar(token, field));
  return items;
}

function parseRestrictedYaml(lines, contractName, listFields) {
  const values = Object.create(null);
  const errors = [];
  let currentListKey = null;

  lines.forEach((rawLine, offset) => {
    const lineNumber = offset + 2;
    const line = rawLine.replace(/\r$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    if (line.includes('\t')) {
      errors.push(`${contractName}: line ${lineNumber}: tabs are not allowed`);
      return;
    }

    const listMatch = /^ {4}-[ \t]*(.*)$/.exec(line);
    if (listMatch) {
      if (!currentListKey || !Array.isArray(values[currentListKey])) {
        errors.push(`${contractName}: line ${lineNumber}: unexpected list item`);
        return;
      }
      if (!listMatch[1]) {
        errors.push(`${contractName}.${currentListKey}: line ${lineNumber}: list item is empty`);
        return;
      }
      try {
        values[currentListKey].push(decodeScalar(listMatch[1], `${contractName}.${currentListKey}`));
      } catch (error) {
        errors.push(`${contractName}.${currentListKey}: line ${lineNumber}: ${error.message}`);
      }
      return;
    }

    currentListKey = null;
    const fieldMatch = /^ {2}([A-Za-z_][A-Za-z0-9_]*):(?:[ \t]*(.*))?$/.exec(line);
    if (!fieldMatch) {
      errors.push(`${contractName}: line ${lineNumber}: expected two-space field indentation`);
      return;
    }

    const field = fieldMatch[1];
    if (own(values, field)) {
      errors.push(`${contractName}.${field}: duplicate field`);
      return;
    }

    const rawValue = fieldMatch[2] ?? '';
    if (listFields.has(field)) {
      if (!rawValue || rawValue === '[]') {
        values[field] = [];
        currentListKey = field;
        return;
      }
      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        try {
          values[field] = decodeInlineList(rawValue, `${contractName}.${field}`);
        } catch (error) {
          errors.push(`${contractName}.${field}: ${error.message}`);
        }
        return;
      }
      errors.push(`${contractName}.${field}: expected [] or indented list items`);
      return;
    }

    if (!rawValue) {
      errors.push(`${contractName}.${field}: value is required`);
      return;
    }
    try {
      values[field] = decodeScalar(rawValue, `${contractName}.${field}`);
    } catch (error) {
      errors.push(`${contractName}.${field}: ${error.message}`);
    }
  });

  return { values, errors };
}

function extractContractBlock(body, contractName, listFields) {
  const markerPattern = new RegExp(`(^|\\n)${escapeRegex(contractName)}\\s*:`, 'm');
  const markerPresent = typeof body === 'string' && markerPattern.test(body);
  if (typeof body !== 'string') {
    return { found: false, markerPresent: false, errors: [`${contractName}: body is required`] };
  }

  const matches = [];
  const fence = /```(?:yaml|yml)[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;
  let match;
  while ((match = fence.exec(body)) !== null) {
    const lines = match[1].replace(/\r/g, '').split('\n');
    if ((lines[0] || '').trim() === `${contractName}:`) matches.push(lines);
  }

  // GitHub's PR editor sometimes receives a contract body without the
  // template's code fence (for example, when an agent submits YAML directly).
  // Accept that equivalent top-level form, but only when every contract line
  // remains indented and the block terminates before ordinary Markdown text.
  if (matches.length === 0) {
    const lines = body.replace(/\r/g, '').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim() !== `${contractName}:`) continue;
      const candidate = [lines[index]];
      let sawField = false;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        if (!line.trim()) break;
        if (!/^ {2}/.test(line)) break;
        candidate.push(line);
        sawField = true;
      }
      if (sawField) matches.push(candidate);
    }
  }

  if (matches.length === 0) {
    return {
      found: false,
      markerPresent,
      errors: markerPresent ? [`${contractName}: expected exactly one YAML contract block`] : [],
    };
  }
  if (matches.length > 1) {
    return { found: false, markerPresent: true, errors: [`${contractName}: duplicate fenced yaml blocks`] };
  }

  const parsed = parseRestrictedYaml(matches[0].slice(1), contractName, listFields);
  return { found: true, markerPresent: true, values: parsed.values, errors: parsed.errors };
}

function validateShape(values, contractName, requiredFields, optionalFields = new Set()) {
  const errors = [];
  for (const field of requiredFields) {
    if (!own(values, field)) errors.push(`${contractName}.${field}: required field is missing`);
  }
  for (const field of Object.keys(values)) {
    if (!requiredFields.has(field) && !optionalFields.has(field)) errors.push(`${contractName}.${field}: unknown field`);
  }
  return errors;
}

function validateEnums(values, contractName, enums) {
  const errors = [];
  for (const [field, allowed] of Object.entries(enums)) {
    if (own(values, field) && !allowed.has(values[field])) {
      errors.push(`${contractName}.${field}: invalid value (expected one of ${[...allowed].join(', ')})`);
    }
  }
  return errors;
}

function validateIssueNumberList(value, field, contractName) {
  const errors = [];
  if (!Array.isArray(value)) return [`${contractName}.${field}: expected a list`];
  const seen = new Set();
  value.forEach((entry, index) => {
    if (!/^\d+$/.test(entry) || Number(entry) <= 0 || !Number.isSafeInteger(Number(entry))) {
      errors.push(`${contractName}.${field}[${index}]: expected a positive Issue number`);
      return;
    }
    if (seen.has(entry)) errors.push(`${contractName}.${field}[${index}]: duplicate Issue number`);
    seen.add(entry);
  });
  return errors;
}

function validatePathList(value, field, contractName, required) {
  const errors = [];
  if (!Array.isArray(value)) return [`${contractName}.${field}: expected a list`];
  if (required && value.length === 0) errors.push(`${contractName}.${field}: at least one path is required`);
  const seen = new Set();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      errors.push(`${contractName}.${field}[${index}]: path must be a non-empty string`);
      return;
    }
    const normalized = entry.trim();
    if (normalized.includes('\\') || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
      errors.push(`${contractName}.${field}[${index}]: path must be repository-relative with '/' separators`);
    }
    if (normalized.split('/').some(segment => segment === '..' || segment === '')) {
      errors.push(`${contractName}.${field}[${index}]: path contains an unsafe segment`);
    }
    if (seen.has(normalized)) errors.push(`${contractName}.${field}[${index}]: duplicate path`);
    seen.add(normalized);
  });
  return errors;
}

function hasHeading(body, heading) {
  const escaped = escapeRegex(heading);
  return new RegExp(`^#{2,6}[ \\t]+${escaped}[ \\t]*$`, 'mi').test(body);
}

function grandfathered(contractName, body, createdAt, block) {
  if (!block.markerPresent && isHistorical(createdAt)) {
    return { ok: true, status: 'GRANDFATHERED', errors: [], warnings: [`${contractName}: pre-contract item accepted under ${CONTRACT_EFFECTIVE_SHA}`] };
  }
  const errors = block.errors.length > 0 ? block.errors : [`${contractName}: fenced contract block is required`];
  return { ok: false, status: 'INVALID', errors, warnings: [] };
}

function validateTaskContract(body, context = {}) {
  const block = extractContractBlock(body, 'AF_TASK_V1', TASK_LIST_FIELDS);
  if (!block.found) return grandfathered('AF_TASK_V1', body, context.createdAt, block);

  const errors = [...block.errors, ...validateShape(block.values, 'AF_TASK_V1', TASK_FIELDS)];
  errors.push(...validateEnums(block.values, 'AF_TASK_V1', TASK_ENUMS));
  for (const field of ['area', 'type']) {
    if (own(block.values, field) && !String(block.values[field]).trim()) errors.push(`AF_TASK_V1.${field}: must be non-empty`);
  }
  if (own(block.values, 'blocked_by')) errors.push(...validateIssueNumberList(block.values.blocked_by, 'blocked_by', 'AF_TASK_V1'));
  if (own(block.values, 'conflicts_with')) errors.push(...validateIssueNumberList(block.values.conflicts_with, 'conflicts_with', 'AF_TASK_V1'));
  if (own(block.values, 'paths')) errors.push(...validatePathList(block.values.paths, 'paths', 'AF_TASK_V1', true));
  if (own(block.values, 'forbidden_paths')) errors.push(...validatePathList(block.values.forbidden_paths, 'forbidden_paths', 'AF_TASK_V1', false));
  if (typeof body === 'string') {
    for (const heading of TASK_REQUIRED_SECTIONS) {
      if (!hasHeading(body, heading)) errors.push(`Issue section '${heading}': heading is required`);
    }
  }

  return { ok: errors.length === 0, status: errors.length === 0 ? 'VALID' : 'INVALID', errors, warnings: [] };
}

function closingIssueNumbers(body) {
  if (typeof body !== 'string') return [];
  const refs = [];
  const pattern = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi;
  let match;
  while ((match = pattern.exec(body)) !== null) refs.push(Number(match[1]));
  return refs;
}

function validatePullRequestContract(body, context = {}) {
  const block = extractContractBlock(body, 'AF_PR_V1', PR_LIST_FIELDS);
  if (!block.found) return grandfathered('AF_PR_V1', body, context.createdAt, block);

  const errors = [...block.errors, ...validateShape(block.values, 'AF_PR_V1', PR_FIELDS, PR_OPTIONAL_FIELDS)];
  errors.push(...validateEnums(block.values, 'AF_PR_V1', PR_ENUMS));

  let issueNumber = null;
  if (own(block.values, 'issue')) {
    if (!/^\d+$/.test(block.values.issue) || Number(block.values.issue) <= 0 || !Number.isSafeInteger(Number(block.values.issue))) {
      errors.push('AF_PR_V1.issue: expected a positive Issue number');
    } else {
      issueNumber = Number(block.values.issue);
    }
  }
  if (own(block.values, 'base_sha') && !SHA.test(block.values.base_sha)) {
    errors.push('AF_PR_V1.base_sha: expected a 40-character hexadecimal SHA');
  }
  if (own(block.values, 'reviewed_head_sha') && !SHA.test(block.values.reviewed_head_sha)) {
    errors.push('AF_PR_V1.reviewed_head_sha: expected a 40-character hexadecimal SHA');
  }
  if (own(block.values, 'reviewed_head_sha') && context.headSha && block.values.reviewed_head_sha !== context.headSha) {
    errors.push(`AF_PR_V1.reviewed_head_sha: must match event head SHA ${context.headSha}`);
  }
  if (issueNumber !== null) {
    const refs = closingIssueNumbers(body);
    if (!refs.includes(issueNumber)) errors.push(`Closes #${issueNumber}: matching closing reference is required`);
    if (context.baseSha && block.values.base_sha !== context.baseSha) {
      errors.push(`AF_PR_V1.base_sha: must match event base SHA ${context.baseSha}`);
    }
    if (block.values.base_mode === 'MAIN' && context.baseRef && context.baseRef !== 'main') {
      errors.push(`AF_PR_V1.base_mode: MAIN requires base branch 'main'`);
    }
    if (context.relatedIssue && context.relatedIssue.number !== issueNumber) {
      errors.push(`linked Issue: expected #${issueNumber}`);
    }
    if (context.relatedIssue && context.relatedIssue.pull_request) {
      errors.push(`linked Issue #${issueNumber}: closing reference points to a pull request`);
    }
    if (context.relatedIssue && !context.relatedIssue.pull_request) {
      const task = validateTaskContract(context.relatedIssue.body, { createdAt: context.relatedIssue.created_at });
      if (!task.ok) errors.push(...task.errors.map(error => `linked Issue #${issueNumber}: ${error}`));
    }
  }
  if (own(block.values, 'paths')) errors.push(...validatePathList(block.values.paths, 'paths', 'AF_PR_V1', true));
  if (own(block.values, 'blocked_by')) errors.push(...validateIssueNumberList(block.values.blocked_by, 'blocked_by', 'AF_PR_V1'));

  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? 'VALID' : 'INVALID',
    errors,
    warnings: [],
    issueNumber,
  };
}

async function fetchLinkedIssue(repo, issueNumber, token, fetchImpl = globalThis.fetch) {
  if (!repo || !token) throw new Error('linked Issue lookup requires GITHUB_REPOSITORY and GITHUB_TOKEN');
  if (typeof fetchImpl !== 'function') throw new Error('linked Issue lookup requires a fetch implementation');
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/issues/${issueNumber}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) throw new Error(`GitHub linked Issue lookup returned HTTP ${response.status}`);
  return response.json();
}

async function validateEvent(event, options = {}) {
  const eventName = options.eventName || process.env.GITHUB_EVENT_NAME || '';
  if (eventName === 'issues') {
    return validateTaskContract(event && event.issue && event.issue.body, {
      createdAt: event && event.issue && event.issue.created_at,
    });
  }
  if (eventName === 'pull_request_target' || eventName === 'pull_request') {
    const pullRequest = event && event.pull_request;
    if (!pullRequest) return { ok: false, status: 'INVALID', errors: ['pull_request event payload is missing'], warnings: [] };
    const body = pullRequest.body;
    const block = extractContractBlock(body, 'AF_PR_V1', PR_LIST_FIELDS);
    let relatedIssue;
    let issueNumber = null;
    if (block.found && block.values && /^\d+$/.test(block.values.issue)) issueNumber = Number(block.values.issue);
    if (issueNumber !== null) {
      relatedIssue = await (options.fetchLinkedIssue || fetchLinkedIssue)(
        options.repository || process.env.GITHUB_REPOSITORY,
        issueNumber,
        options.token || process.env.GITHUB_TOKEN,
        options.fetchImpl,
      );
    }
    return validatePullRequestContract(body, {
      createdAt: pullRequest.created_at,
      headSha: pullRequest.head && pullRequest.head.sha,
      baseSha: pullRequest.base && pullRequest.base.sha,
      baseRef: pullRequest.base && pullRequest.base.ref,
      relatedIssue,
    });
  }
  return { ok: true, status: 'SKIPPED', errors: [], warnings: [`unsupported event '${eventName}'`] };
}

async function main() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
  const result = await validateEvent(event);
  if (result.ok) {
    console.log(`CONTRACT_VALIDATION_PASS: ${result.status}`);
    for (const warning of result.warnings || []) console.log(`CONTRACT_VALIDATION_NOTE: ${warning}`);
    return;
  }
  console.error('CONTRACT_VALIDATION_FAIL');
  for (const error of result.errors) console.error(`- ${error}`);
  process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`CONTRACT_VALIDATION_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  CONTRACT_EFFECTIVE_AT,
  CONTRACT_EFFECTIVE_SHA,
  closingIssueNumbers,
  extractContractBlock,
  fetchLinkedIssue,
  validateEvent,
  validateIssueContract: validateTaskContract,
  validatePullRequestContract,
};
