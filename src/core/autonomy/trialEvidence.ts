import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { assertPathContained } from '../services/ArtifactStore';

export const PRODUCTION_TRIAL_PHASES = ['R5L0', 'R5L1', 'R5L2', 'R5L3', 'R5L4'] as const;
export type ProductionTrialPhase = (typeof PRODUCTION_TRIAL_PHASES)[number];

export const PRODUCTION_TRIAL_OUTCOMES = ['PASS', 'HOLD', 'FAIL'] as const;
export type ProductionTrialOutcome = (typeof PRODUCTION_TRIAL_OUTCOMES)[number];

export interface TrialEvidenceEntry {
  evidenceId: string;
  relativePath: string;
  sha256: string;
  byteSize: number;
  contentType: string;
  redacted: boolean;
}

export interface ProductionTrialEvidenceManifest {
  schemaVersion: 1;
  trialId: string;
  phase: ProductionTrialPhase;
  createdAt: string;
  source: {
    commitSha: string;
    treeSha: string;
    ciRunId: string;
  };
  artifacts: {
    installerSha256: string | null;
    appSha256: string | null;
    databaseProjectionSha256: string | null;
  };
  lifecycleIds: string[];
  contextHashes: Record<string, string>;
  outcome: ProductionTrialOutcome;
  evidence: TrialEvidenceEntry[];
  approvals: {
    operatorIds: string[];
    approverIds: string[];
  };
  retention: {
    location: string;
    retentionClass: string;
  };
  notes: string | null;
}

export interface TrialEvidenceManifestResult {
  manifest: ProductionTrialEvidenceManifest;
  canonicalJson: string;
  sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CONTENT_TYPE = /^[A-Za-z0-9!#$&^_.+\-]+\/[A-Za-z0-9!#$&^_.+\-]+(?:;[A-Za-z0-9=._+\-]+)*$/;
const SECRET_PATTERNS: RegExp[] = [
  /(?:gh[pousr]_[A-Za-z0-9_\-]{20,})/g,
  /(?:github_pat_[A-Za-z0-9_\-]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi,
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|oauth[_-]?token|secret[_-]?token|password|secret|token)\s*[:=]\s*[^\s,;}]{8,}/gi,
];

function fail(message: string): never {
  throw new Error(`TRIAL_EVIDENCE_INVALID: ${message}`);
}

function requireBoundedString(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000\r\n]/.test(value)) {
    fail(`${field} must be a non-empty bounded string without control characters`);
  }
  return value;
}

function requireSafeId(value: unknown, field: string): string {
  const id = requireBoundedString(value, field, 128);
  if (!SAFE_ID.test(id)) fail(`${field} contains unsupported characters`);
  return id;
}

function requireSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(`${field} must be a lowercase SHA-256 digest`);
  return value;
}

function requireOptionalSha(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireSha(value, field);
}

function requireGitSha(value: unknown, field: string): string {
  if (typeof value !== 'string' || !GIT_SHA.test(value)) fail(`${field} must be a 40-character Git SHA`);
  return value.toLowerCase();
}

function requireExactKeys(value: unknown, expected: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be a plain object`);
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${field} has unexpected or missing properties`);
  }
  return value as Record<string, unknown>;
}

function assertNoSecrets(value: string, field: string): void {
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) fail(`${field} contains a secret-like value; redact it before persisting evidence`);
  }
}

/**
 * Redacts known credential forms before evidence enters a durable manifest.
 * Verification still rejects unredacted secret-like values, so callers cannot
 * use this helper to silently bless malformed evidence.
 */
export function redactTrialEvidenceText(value: string): string {
  let redacted = value;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, '[REDACTED_SECRET]');
  }
  return redacted;
}

function normalizeRelativePath(value: unknown, field: string): string {
  const raw = requireBoundedString(value, field, 512).replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.includes('\u0000')) {
    fail(`${field} must be a workspace-relative path`);
  }
  const parts = raw.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`${field} contains an empty, dot, or traversal segment`);
  }
  return parts.join('/');
}

function normalizeStringArray(value: unknown, field: string, maxItems = 512): string[] {
  if (!Array.isArray(value) || value.length > maxItems) fail(`${field} must be a bounded array`);
  const items = value.map((item, index) => requireSafeId(item, `${field}[${index}]`));
  return [...new Set(items)].sort();
}

function normalizeContextHashes(value: unknown): Record<string, string> {
  const record = requireExactKeysObject(value, 'contextHashes');
  const entries = Object.entries(record).map(([key, digest]) => [requireSafeId(key, 'contextHashes key'), requireSha(digest, `contextHashes.${key}`)] as const);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

function requireExactKeysObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${field} must be a plain object`);
  if (Object.keys(value as Record<string, unknown>).length > 128) fail(`${field} has too many entries`);
  return value as Record<string, unknown>;
}

function normalizeEvidence(value: unknown): TrialEvidenceEntry[] {
  if (!Array.isArray(value) || value.length > 4096) fail('evidence must be a bounded array');
  const entries = value.map((raw, index) => {
    const row = requireExactKeys(raw, ['evidenceId', 'relativePath', 'sha256', 'byteSize', 'contentType', 'redacted'], `evidence[${index}]`);
    if (!Number.isSafeInteger(row.byteSize) || Number(row.byteSize) < 0) fail(`evidence[${index}].byteSize must be a non-negative safe integer`);
    const contentType = requireBoundedString(row.contentType, `evidence[${index}].contentType`, 128);
    if (!SAFE_CONTENT_TYPE.test(contentType)) fail(`evidence[${index}].contentType is invalid`);
    if (typeof row.redacted !== 'boolean') fail(`evidence[${index}].redacted must be boolean`);
    return {
      evidenceId: requireSafeId(row.evidenceId, `evidence[${index}].evidenceId`),
      relativePath: normalizeRelativePath(row.relativePath, `evidence[${index}].relativePath`),
      sha256: requireSha(row.sha256, `evidence[${index}].sha256`),
      byteSize: Number(row.byteSize),
      contentType,
      redacted: row.redacted,
    };
  });
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.evidenceId)) fail(`duplicate evidenceId "${entry.evidenceId}"`);
    ids.add(entry.evidenceId);
  }
  return entries.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
}

function normalizeManifest(raw: unknown, sanitizeText: boolean): ProductionTrialEvidenceManifest {
  const row = requireExactKeys(raw, [
    'schemaVersion', 'trialId', 'phase', 'createdAt', 'source', 'artifacts',
    'lifecycleIds', 'contextHashes', 'outcome', 'evidence', 'approvals', 'retention', 'notes',
  ], 'manifest');
  if (row.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof row.phase !== 'string' || !PRODUCTION_TRIAL_PHASES.includes(row.phase as ProductionTrialPhase)) fail('phase is unsupported');
  if (typeof row.outcome !== 'string' || !PRODUCTION_TRIAL_OUTCOMES.includes(row.outcome as ProductionTrialOutcome)) fail('outcome is unsupported');
  const createdAt = requireBoundedString(row.createdAt, 'createdAt', 64);
  if (Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) fail('createdAt must be a canonical ISO timestamp');
  const source = requireExactKeys(row.source, ['commitSha', 'treeSha', 'ciRunId'], 'source');
  const artifacts = requireExactKeys(row.artifacts, ['installerSha256', 'appSha256', 'databaseProjectionSha256'], 'artifacts');
  const approvals = requireExactKeys(row.approvals, ['operatorIds', 'approverIds'], 'approvals');
  const retention = requireExactKeys(row.retention, ['location', 'retentionClass'], 'retention');
  const notes = row.notes === null ? null : requireBoundedString(row.notes, 'notes', 4096);
  const normalizedNotes = sanitizeText && notes !== null ? redactTrialEvidenceText(notes) : notes;
  if (normalizedNotes !== null) assertNoSecrets(normalizedNotes, 'notes');
  const lifecycleIds = normalizeStringArray(row.lifecycleIds, 'lifecycleIds');
  lifecycleIds.forEach((id) => assertNoSecrets(id, 'lifecycleIds'));
  const operatorIds = normalizeStringArray(approvals.operatorIds, 'approvals.operatorIds', 64);
  const approverIds = normalizeStringArray(approvals.approverIds, 'approvals.approverIds', 64);
  operatorIds.forEach((id) => assertNoSecrets(id, 'approvals.operatorIds'));
  approverIds.forEach((id) => assertNoSecrets(id, 'approvals.approverIds'));
  const contextHashes = normalizeContextHashes(row.contextHashes);
  const evidence = normalizeEvidence(row.evidence);
  const location = normalizeRelativePath(retention.location, 'retention.location');
  const retentionClass = requireSafeId(retention.retentionClass, 'retention.retentionClass');
  const ciRunId = requireBoundedString(source.ciRunId, 'source.ciRunId', 256);
  assertNoSecrets(ciRunId, 'source.ciRunId');
  assertNoSecrets(location, 'retention.location');
  assertNoSecrets(retentionClass, 'retention.retentionClass');
  for (const item of evidence) {
    assertNoSecrets(item.relativePath, `evidence.${item.evidenceId}.relativePath`);
    assertNoSecrets(item.contentType, `evidence.${item.evidenceId}.contentType`);
  }
  return {
    schemaVersion: 1,
    trialId: requireSafeId(row.trialId, 'trialId'),
    phase: row.phase as ProductionTrialPhase,
    createdAt,
    source: {
      commitSha: requireGitSha(source.commitSha, 'source.commitSha'),
      treeSha: requireGitSha(source.treeSha, 'source.treeSha'),
      ciRunId,
    },
    artifacts: {
      installerSha256: requireOptionalSha(artifacts.installerSha256, 'artifacts.installerSha256'),
      appSha256: requireOptionalSha(artifacts.appSha256, 'artifacts.appSha256'),
      databaseProjectionSha256: requireOptionalSha(artifacts.databaseProjectionSha256, 'artifacts.databaseProjectionSha256'),
    },
    lifecycleIds,
    contextHashes,
    outcome: row.outcome as ProductionTrialOutcome,
    evidence,
    approvals: {
      operatorIds,
      approverIds,
    },
    retention: { location, retentionClass },
    notes: normalizedNotes,
  };
}

export function canonicalizeTrialEvidenceManifest(manifest: ProductionTrialEvidenceManifest): string {
  const normalized = normalizeManifest(manifest, false);
  return JSON.stringify(normalized);
}

export function computeTrialEvidenceManifestSha256(manifestOrJson: ProductionTrialEvidenceManifest | string): string {
  let canonical: string;
  if (typeof manifestOrJson === 'string') {
    try {
      canonical = canonicalizeTrialEvidenceManifest(JSON.parse(manifestOrJson) as ProductionTrialEvidenceManifest);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('TRIAL_EVIDENCE_INVALID:')) throw error;
      fail('manifest JSON is malformed');
    }
  } else {
    canonical = canonicalizeTrialEvidenceManifest(manifestOrJson);
  }
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function buildTrialEvidenceManifest(input: Omit<ProductionTrialEvidenceManifest, 'schemaVersion' | 'createdAt'> & { createdAt?: string }): TrialEvidenceManifestResult {
  const manifest = normalizeManifest({ ...input, schemaVersion: 1, createdAt: input.createdAt ?? new Date().toISOString() }, true);
  const canonicalJson = canonicalizeTrialEvidenceManifest(manifest);
  return { manifest, canonicalJson, sha256: crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex') };
}

export function parseAndVerifyTrialEvidenceManifest(rawJson: string, expectedSha256?: string): TrialEvidenceManifestResult {
  if (typeof rawJson !== 'string' || Buffer.byteLength(rawJson, 'utf8') > 16 * 1024 * 1024) fail('manifest JSON is missing or too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    fail('manifest JSON is malformed');
  }
  const manifest = normalizeManifest(parsed, false);
  const canonicalJson = canonicalizeTrialEvidenceManifest(manifest);
  const sha256 = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256) || expectedSha256 !== sha256)) {
    fail('manifest SHA-256 does not match expected digest');
  }
  return { manifest, canonicalJson, sha256 };
}

export function writeTrialEvidenceManifest(rootDir: string, relativePath: string, result: TrialEvidenceManifestResult): { filePath: string; sha256: string } {
  // Validate and recompute the supplied result before touching the filesystem.
  // A caller may deserialize or construct this object from untrusted JSON;
  // trusting its canonicalJson/sha256 fields would allow a malformed receipt
  // to poison a previously empty evidence location.
  let canonicalJson: string;
  let sha256: string;
  try {
    canonicalJson = canonicalizeTrialEvidenceManifest((result as unknown as { manifest: ProductionTrialEvidenceManifest }).manifest);
    sha256 = crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('TRIAL_EVIDENCE_INVALID:')) throw error;
    fail('manifest result is malformed');
  }
  const supplied = result as unknown as { canonicalJson?: unknown; sha256?: unknown };
  if (supplied.canonicalJson !== canonicalJson || supplied.sha256 !== sha256) {
    fail('manifest result canonical JSON or SHA-256 does not match its manifest');
  }
  const safeRelativePath = normalizeRelativePath(relativePath, 'manifest output path');
  const absoluteRoot = path.resolve(rootDir);
  fs.mkdirSync(absoluteRoot, { recursive: true });
  const filePath = assertPathContained(path.join(absoluteRoot, safeRelativePath), absoluteRoot);
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(filePath)) {
    if (fs.lstatSync(filePath).isSymbolicLink()) fail('manifest output path is a symbolic link');
    const existing = parseAndVerifyTrialEvidenceManifest(fs.readFileSync(filePath, 'utf8'));
    if (existing.sha256 !== sha256) fail('manifest output already exists with a different digest');
    return { filePath, sha256 };
  }
  const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
  assertPathContained(tempPath, absoluteRoot);
  const fd = fs.openSync(tempPath, 'wx');
  try {
    fs.writeFileSync(fd, `${canonicalJson}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* preserve original failure */ }
    throw new Error(`TRIAL_EVIDENCE_WRITE_FAILED: ${error instanceof Error ? error.message : 'atomic rename failed'}`);
  }
  const written = parseAndVerifyTrialEvidenceManifest(fs.readFileSync(filePath, 'utf8'), sha256);
  return { filePath, sha256: written.sha256 };
}
