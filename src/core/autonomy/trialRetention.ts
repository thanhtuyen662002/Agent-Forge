import crypto from 'crypto';
import path from 'path';
import {
  computeTrialEvidenceManifestSha256,
  PRODUCTION_TRIAL_PHASES,
  type ProductionTrialEvidenceManifest,
  type ProductionTrialPhase,
} from './trialEvidence';
import {
  closeTrialFilesystemRoot,
  openTrialFilesystemRoot,
  readTrialFileBounded,
  writeTrialFileAtomic,
} from './trialLogCollector';

/**
 * A durable, local receipt that names the location approved for a trial's
 * evidence bundle.  The receipt is deliberately separate from the evidence
 * manifest: a manifest describes the evidence, while this record proves that
 * a named operator designated where it must be retained.
 */
export interface TrialRetentionDesignation {
  schemaVersion: 1;
  trialId: string;
  phase: ProductionTrialPhase;
  manifestSha256: string;
  location: string;
  retentionClass: string;
  designatedBy: string[];
  designatedAt: string;
}

export interface TrialRetentionDesignationResult {
  designation: TrialRetentionDesignation;
  canonicalJson: string;
  sha256: string;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SECRET_PATTERNS: RegExp[] = [
  /(?:gh[pousr]_[A-Za-z0-9_-]{20,})/g,
  /(?:github_pat_[A-Za-z0-9_-]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/gi,
  /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|oauth[_-]?token|secret[_-]?token|password|secret|token)\s*[:=]\s*[^\s,;}]{8,}/gi,
];

function fail(message: string): never {
  throw new Error(`TRIAL_RETENTION_INVALID: ${message}`);
}

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000\r\n]/.test(value)) {
    fail(`${field} must be a bounded string`);
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
    if (pattern.test(value)) fail(`${field} contains a secret-like value`);
  }
}

function normalizeRelativePath(value: unknown, field: string): string {
  const raw = requireBoundedString(value, field, 512).replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[A-Za-z]:\//.test(raw)) fail(`${field} must be a workspace-relative path`);
  const parts = raw.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    fail(`${field} contains an empty, dot, or traversal segment`);
  }
  assertNoSecrets(raw, field);
  return parts.join('/');
}

function normalizeDesignatedBy(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) fail('designatedBy must be a non-empty bounded array');
  const ids = value.map((item, index) => requireSafeId(item, `designatedBy[${index}]`));
  ids.forEach((id) => assertNoSecrets(id, 'designatedBy'));
  return [...new Set(ids)].sort();
}

function normalizeDesignation(raw: unknown): TrialRetentionDesignation {
  const row = requireExactKeys(raw, [
    'schemaVersion', 'trialId', 'phase', 'manifestSha256', 'location',
    'retentionClass', 'designatedBy', 'designatedAt',
  ], 'designation');
  if (row.schemaVersion !== 1) fail('schemaVersion must be 1');
  if (typeof row.phase !== 'string' || !PRODUCTION_TRIAL_PHASES.includes(row.phase as ProductionTrialPhase)) fail('phase is unsupported');
  const designatedAt = requireBoundedString(row.designatedAt, 'designatedAt', 64);
  if (Number.isNaN(Date.parse(designatedAt)) || new Date(designatedAt).toISOString() !== designatedAt) {
    fail('designatedAt must be a canonical ISO timestamp');
  }
  const designation: TrialRetentionDesignation = {
    schemaVersion: 1,
    trialId: requireSafeId(row.trialId, 'trialId'),
    phase: row.phase as ProductionTrialPhase,
    manifestSha256: requireSha(row.manifestSha256, 'manifestSha256'),
    location: normalizeRelativePath(row.location, 'location'),
    retentionClass: requireSafeId(row.retentionClass, 'retentionClass'),
    designatedBy: normalizeDesignatedBy(row.designatedBy),
    designatedAt,
  };
  assertNoSecrets(designation.trialId, 'trialId');
  assertNoSecrets(designation.retentionClass, 'retentionClass');
  return designation;
}

function digest(canonicalJson: string): string {
  return crypto.createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}

export function canonicalizeTrialRetentionDesignation(designation: TrialRetentionDesignation): string {
  return JSON.stringify(normalizeDesignation(designation));
}

export function computeTrialRetentionDesignationSha256(designationOrJson: TrialRetentionDesignation | string): string {
  const canonicalJson = typeof designationOrJson === 'string'
    ? parseAndVerifyTrialRetentionDesignation(designationOrJson).canonicalJson
    : canonicalizeTrialRetentionDesignation(designationOrJson);
  return digest(canonicalJson);
}

export function buildTrialRetentionDesignation(
  input: Omit<TrialRetentionDesignation, 'schemaVersion'>,
): TrialRetentionDesignationResult {
  const designation = normalizeDesignation({ ...input, schemaVersion: 1 });
  const canonicalJson = canonicalizeTrialRetentionDesignation(designation);
  return { designation, canonicalJson, sha256: digest(canonicalJson) };
}

/**
 * Checks that a designation is for the exact canonical manifest being
 * evaluated.  Invalid untrusted input returns false so readiness callers can
 * turn it into a HOLD without catching parser details at every call site.
 */
export function isTrialRetentionDesignationBound(
  manifest: ProductionTrialEvidenceManifest,
  designation: unknown,
): designation is TrialRetentionDesignation {
  try {
    const normalized = normalizeDesignation(designation);
    return normalized.trialId === manifest.trialId
      && normalized.phase === manifest.phase
      && normalized.location === manifest.retention.location
      && normalized.retentionClass === manifest.retention.retentionClass
      && normalized.manifestSha256 === computeTrialEvidenceManifestSha256(manifest);
  } catch {
    return false;
  }
}

export function parseAndVerifyTrialRetentionDesignation(
  rawJson: string,
  expectedSha256?: string,
): TrialRetentionDesignationResult {
  if (typeof rawJson !== 'string' || Buffer.byteLength(rawJson, 'utf8') > 1024 * 1024) fail('designation JSON is missing or too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    fail('designation JSON is malformed');
  }
  const designation = normalizeDesignation(parsed);
  const canonicalJson = canonicalizeTrialRetentionDesignation(designation);
  const sha256 = digest(canonicalJson);
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== 'string' || !SHA256.test(expectedSha256) || expectedSha256 !== sha256)) {
    fail('designation SHA-256 does not match expected digest');
  }
  return { designation, canonicalJson, sha256 };
}

export function writeTrialRetentionDesignation(
  rootDir: string,
  relativePath: string,
  result: TrialRetentionDesignationResult,
): { filePath: string; sha256: string } {
  // Validate and recompute before any directory or file mutation. Retention
  // receipts are durable authority and must never trust caller-supplied hash
  // fields independently of their canonical designation.
  let canonicalJson: string;
  let sha256: string;
  try {
    canonicalJson = canonicalizeTrialRetentionDesignation((result as unknown as { designation: TrialRetentionDesignation }).designation);
    sha256 = digest(canonicalJson);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('TRIAL_RETENTION_INVALID:')) throw error;
    fail('designation result is malformed');
  }
  const supplied = result as unknown as { canonicalJson?: unknown; sha256?: unknown };
  if (supplied.canonicalJson !== canonicalJson || supplied.sha256 !== sha256) {
    fail('designation result canonical JSON or SHA-256 does not match its designation');
  }
  const safeRelativePath = normalizeRelativePath(relativePath, 'designation output path');
  const root = openTrialFilesystemRoot(rootDir, true);
  const filePath = path.resolve(root.baseDir, safeRelativePath);
  const payload = Buffer.from(`${canonicalJson}\n`, 'utf8');
  try {
    try {
      const existing = readTrialFileBounded(root, filePath, 1024 * 1024, 'designation output');
      const parsed = parseAndVerifyTrialRetentionDesignation(existing.text);
      if (parsed.sha256 !== sha256) fail('designation output already exists with a different digest');
      return { filePath, sha256 };
    } catch (error) {
      if (!(error instanceof Error) || !/missing/i.test(error.message)) throw error;
    }
    writeTrialFileAtomic(root, filePath, payload, 1024 * 1024, 'designation output');
    const written = readTrialFileBounded(root, filePath, 1024 * 1024, 'designation output');
    const parsed = parseAndVerifyTrialRetentionDesignation(written.text, sha256);
    return { filePath, sha256: parsed.sha256 };
  } finally {
    closeTrialFilesystemRoot(root);
  }
}
