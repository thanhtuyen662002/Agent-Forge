import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { redactTrialEvidenceText } from './trialEvidence';
import { sanitizeAutonomyText } from './contracts';

/**
 * The collector is intentionally a small, local-only evidence primitive.  It
 * reads explicitly selected files below one runtime root, applies the same
 * autonomy sanitizer used by persisted process/manager output, and writes a
 * deterministic JSON bundle.  It does not discover credentials, invoke
 * providers, or upload evidence anywhere.
 */

export const REDACTED_LOG_COLLECTION_SCHEMA_VERSION = 1 as const;
export const REDACTED_LOG_DEFAULT_MAX_FILES = 256;
export const REDACTED_LOG_DEFAULT_MAX_BYTES_PER_FILE = 4 * 1024 * 1024;
export const REDACTED_LOG_DEFAULT_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const REDACTED_LOG_MAX_FILES = 512;
export const REDACTED_LOG_MAX_BYTES_PER_FILE = 8 * 1024 * 1024;
export const REDACTED_LOG_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const REDACTED_LOG_MAX_OUTPUT_BYTES = 40 * 1024 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;

export interface RedactedTrialLogEntry {
  relativePath: string;
  contentType: 'text/plain';
  content: string;
  byteSize: number;
  sha256: string;
  redacted: true;
}
export interface RedactedTrialLogCollection {
  schemaVersion: typeof REDACTED_LOG_COLLECTION_SCHEMA_VERSION;
  collectedAt: string;
  files: RedactedTrialLogEntry[];
  totalByteSize: number;
}

export interface CollectRedactedTrialLogsOptions {
  /** Runtime root. Every input and output path must remain below this root. */
  rootDir: string;
  /** Relative files or directories below rootDir to collect. */
  inputRelativePaths: string[];
  /** Relative output file below rootDir. */
  outputRelativePath: string;
  /** Optional canonical timestamp. Defaults to the current UTC timestamp. */
  collectedAt?: string;
  maxFiles?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}

export interface RedactedTrialLogCollectionResult {
  collection: RedactedTrialLogCollection;
  canonicalJson: string;
  filePath: string;
  /** SHA-256 of the exact bytes written to file, including the final newline. */
  sha256: string;
  byteSize: number;
}

interface BoundedLimits {
  maxFiles: number;
  maxBytesPerFile: number;
  maxTotalBytes: number;
}

function fail(message: string): never {
  throw new Error(`TRIAL_LOG_COLLECTION_INVALID: ${message}`);
}

function isWindowsPath(): boolean {
  return process.platform === 'win32';
}

function comparablePath(value: string): string {
  return isWindowsPath() ? value.toLowerCase() : value;
}

function isContained(root: string, target: string): boolean {
  const relative = path.relative(comparablePath(root), comparablePath(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function normalizeRelativePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    fail(`${field} must be a non-empty path of at most 512 characters`);
  }
  const normalized = value.replace(/\\/g, '/');
  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes('\u0000')
  ) {
    fail(`${field} must be relative to the runtime root`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    fail(`${field} contains an empty, dot, or traversal segment`);
  }
  return parts.join('/');
}

function validateTimestamp(value: unknown): string {
  if (value === undefined) return new Date().toISOString();
  if (typeof value !== 'string' || value.length > 64) {
    fail('collectedAt must be a canonical ISO timestamp');
  }
  let canonical: string;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    fail('collectedAt must be a canonical ISO timestamp');
  }
  if (canonical !== value) fail('collectedAt must be a canonical ISO timestamp');
  return value;
}

function validateLimits(options: CollectRedactedTrialLogsOptions): BoundedLimits {
  const maxFiles = options.maxFiles ?? REDACTED_LOG_DEFAULT_MAX_FILES;
  const maxBytesPerFile = options.maxBytesPerFile ?? REDACTED_LOG_DEFAULT_MAX_BYTES_PER_FILE;
  const maxTotalBytes = options.maxTotalBytes ?? REDACTED_LOG_DEFAULT_MAX_TOTAL_BYTES;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > REDACTED_LOG_MAX_FILES) {
    fail(`maxFiles must be an integer from 1 through ${REDACTED_LOG_MAX_FILES}`);
  }
  if (!Number.isSafeInteger(maxBytesPerFile) || maxBytesPerFile < 1 || maxBytesPerFile > REDACTED_LOG_MAX_BYTES_PER_FILE) {
    fail(`maxBytesPerFile must be an integer from 1 through ${REDACTED_LOG_MAX_BYTES_PER_FILE}`);
  }
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > REDACTED_LOG_MAX_TOTAL_BYTES) {
    fail(`maxTotalBytes must be an integer from 1 through ${REDACTED_LOG_MAX_TOTAL_BYTES}`);
  }
  if (maxBytesPerFile > maxTotalBytes) fail('maxBytesPerFile cannot exceed maxTotalBytes');
  return { maxFiles, maxBytesPerFile, maxTotalBytes };
}

function ensureRootDirectory(rootDir: string): string {
  if (typeof rootDir !== 'string' || rootDir.length === 0) fail('rootDir must be a non-empty path');
  const absoluteRoot = path.resolve(rootDir);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(absoluteRoot);
  } catch {
    fail('rootDir must already exist');
  }
  if (rootStat.isSymbolicLink()) fail('rootDir may not be a symbolic link or junction');
  if (!rootStat.isDirectory()) fail('rootDir must be a directory');
  return fs.realpathSync(absoluteRoot);
}

/**
 * Checks lexical and real path containment, rejecting every existing symlink
 * component. Missing components are accepted only for output parents.
 */
function ensurePathBelowRoot(root: string, target: string, allowMissing: boolean, field: string): string {
  const absoluteTarget = path.resolve(target);
  if (!isContained(root, absoluteTarget)) fail(`${field} escapes runtime root`);
  const relative = path.relative(root, absoluteTarget);
  let current = root;
  const segments = relative.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error: unknown) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      fail(`${field} cannot be inspected`);
    }
    if (stat.isSymbolicLink()) fail(`${field} contains a symbolic link or junction`);
    if (index < segments.length - 1 && !stat.isDirectory()) fail(`${field} has a non-directory parent`);
    if (index === segments.length - 1 && !allowMissing && !stat.isFile() && !stat.isDirectory()) {
      fail(`${field} is not a regular file or directory`);
    }
  }
  if (fs.existsSync(absoluteTarget)) {
    let realTarget: string;
    try {
      realTarget = fs.realpathSync(absoluteTarget);
    } catch {
      fail(`${field} real path cannot be verified`);
    }
    if (!isContained(root, realTarget)) fail(`${field} resolves outside runtime root`);
  }
  return absoluteTarget;
}

function ensureOutputPath(root: string, relativePath: string): string {
  const outputPath = ensurePathBelowRoot(root, path.join(root, relativePath), true, 'output path');
  if (fs.existsSync(outputPath)) {
    const stat = fs.lstatSync(outputPath);
    if (stat.isSymbolicLink()) fail('output path is a symbolic link or junction');
    if (!stat.isFile()) fail('output path must be a regular file');
  }
  let parent = path.dirname(outputPath);
  if (parent !== root && !isContained(root, parent)) fail('output parent escapes runtime root');
  while (parent !== root) {
    if (fs.existsSync(parent)) {
      const stat = fs.lstatSync(parent);
      if (stat.isSymbolicLink()) fail('output parent contains a symbolic link or junction');
      if (!stat.isDirectory()) fail('output parent is not a directory');
    }
    parent = path.dirname(parent);
  }
  return outputPath;
}

function readBoundedUtf8(filePath: string, maximumBytes: number, field: string): { text: string; byteSize: number } {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const chunks: Buffer[] = [];
    let total = 0;
    const chunkSize = Math.min(64 * 1024, maximumBytes + 1);
    while (total <= maximumBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(chunkSize, maximumBytes + 1 - total));
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      chunks.push(buffer.subarray(0, count));
      total += count;
      if (total > maximumBytes) fail(`${field} exceeds the configured byte limit`);
    }
    const content = Buffer.concat(chunks, total).toString('utf8');
    return { text: content, byteSize: total };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith('TRIAL_LOG_COLLECTION_INVALID:')) throw error;
    return fail(`${field} could not be read`);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve read failure */ }
    }
  }
}

function enumerateFiles(root: string, relativePath: string, outputPath: string, limits: BoundedLimits, files: string[]): void {
  const absolutePath = ensurePathBelowRoot(root, path.join(root, relativePath), false, `input path ${relativePath}`);
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink()) fail(`input path ${relativePath} is a symbolic link or junction`);
  if (stat.isFile()) {
    if (path.resolve(absolutePath) === path.resolve(outputPath)) fail('output path cannot also be an input log');
    files.push(relativePath);
    if (files.length > limits.maxFiles) fail(`input contains more than ${limits.maxFiles} files`);
    return;
  }
  if (!stat.isDirectory()) fail(`input path ${relativePath} is not a regular file or directory`);
  if (isContained(absolutePath, outputPath)) fail('output path cannot be inside an input directory');
  const entries = fs.readdirSync(absolutePath, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const childRelative = `${relativePath}/${entry.name}`;
    const childAbsolute = path.join(root, childRelative);
    if (entry.isSymbolicLink()) fail(`input path ${childRelative} is a symbolic link or junction`);
    if (entry.isDirectory()) {
      enumerateFiles(root, childRelative, outputPath, limits, files);
    } else if (entry.isFile()) {
      ensurePathBelowRoot(root, childAbsolute, false, `input path ${childRelative}`);
      if (path.resolve(childAbsolute) === path.resolve(outputPath)) fail('output path cannot also be an input log');
      files.push(childRelative);
      if (files.length > limits.maxFiles) fail(`input contains more than ${limits.maxFiles} files`);
    } else {
      fail(`input path ${childRelative} is not a regular file`);
    }
  }
}

function canonicalizeCollection(collection: RedactedTrialLogCollection): string {
  return JSON.stringify({
    schemaVersion: collection.schemaVersion,
    collectedAt: collection.collectedAt,
    files: collection.files.map((entry) => ({
      relativePath: entry.relativePath,
      contentType: entry.contentType,
      content: entry.content,
      byteSize: entry.byteSize,
      sha256: entry.sha256,
      redacted: entry.redacted,
    })),
    totalByteSize: collection.totalByteSize,
  });
}

function hashBytes(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeAtomic(outputPath: string, payload: Buffer, expectedSha256: string, root: string): void {
  ensurePathBelowRoot(root, outputPath, true, 'output path');
  const parent = path.dirname(outputPath);
  fs.mkdirSync(parent, { recursive: true });
  ensurePathBelowRoot(root, outputPath, true, 'output path');
  if (fs.existsSync(outputPath)) {
    if (fs.lstatSync(outputPath).isSymbolicLink()) fail('output path is a symbolic link or junction');
    const existing = readBoundedUtf8(outputPath, REDACTED_LOG_MAX_OUTPUT_BYTES, 'existing output');
    if (hashBytes(Buffer.from(existing.text, 'utf8')) !== expectedSha256 || existing.byteSize !== payload.byteLength || existing.text !== payload.toString('utf8')) {
      fail('output path already exists with a different digest');
    }
    return;
  }
  const temporaryPath = `${outputPath}.tmp-${crypto.randomUUID()}`;
  ensurePathBelowRoot(root, temporaryPath, true, 'temporary output path');
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporaryPath, 'wx');
    let offset = 0;
    while (offset < payload.length) {
      offset += fs.writeSync(fd, payload, offset, payload.length - offset);
    }
    fs.fsyncSync(fd);
  } catch (error: unknown) {
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* preserve original failure */ }
    throw new Error(`TRIAL_LOG_COLLECTION_WRITE_FAILED: ${error instanceof Error ? error.message : 'temporary write failed'}`);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* preserve original write result */ }
    }
  }
  try {
    fs.renameSync(temporaryPath, outputPath);
  } catch (error: unknown) {
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* preserve original failure */ }
    throw new Error(`TRIAL_LOG_COLLECTION_WRITE_FAILED: ${error instanceof Error ? error.message : 'atomic rename failed'}`);
  }
  const written = fs.readFileSync(outputPath);
  if (hashBytes(written) !== expectedSha256 || !written.equals(payload)) {
    fail('atomic output verification failed');
  }
}

/**
 * Collects and atomically writes redacted logs beneath `rootDir`.
 *
 * The operation is synchronous by design: a trial evidence capture is a
 * bounded operator action, and synchronous reads make the byte limits and
 * deterministic ordering auditable.
 */
export function collectRedactedTrialLogs(options: CollectRedactedTrialLogsOptions): RedactedTrialLogCollectionResult {
  const root = ensureRootDirectory(options.rootDir);
  const limits = validateLimits(options);
  if (!Array.isArray(options.inputRelativePaths) || options.inputRelativePaths.length === 0 || options.inputRelativePaths.length > limits.maxFiles) {
    fail(`inputRelativePaths must contain between 1 and ${limits.maxFiles} entries`);
  }
  const inputPaths = [...new Set(options.inputRelativePaths.map((value, index) => normalizeRelativePath(value, `inputRelativePaths[${index}]`)))].sort();
  const outputRelativePath = normalizeRelativePath(options.outputRelativePath, 'outputRelativePath');
  const outputPath = ensureOutputPath(root, outputRelativePath);
  const files: string[] = [];
  for (const relativePath of inputPaths) enumerateFiles(root, relativePath, outputPath, limits, files);
  const uniqueFiles = [...new Set(files)].sort();
  if (uniqueFiles.length > limits.maxFiles) fail(`input contains more than ${limits.maxFiles} files`);

  let totalSourceBytes = 0;
  const entries: RedactedTrialLogEntry[] = [];
  for (const relativePath of uniqueFiles) {
    const absolutePath = ensurePathBelowRoot(root, path.join(root, relativePath), false, `input path ${relativePath}`);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`input path ${relativePath} is not a safe regular file`);
    if (stat.size > limits.maxBytesPerFile) fail(`input path ${relativePath} exceeds the configured byte limit`);
    if (totalSourceBytes > limits.maxTotalBytes - stat.size) fail(`input logs exceed the configured total byte limit`);
    const raw = readBoundedUtf8(absolutePath, limits.maxBytesPerFile, `input path ${relativePath}`);
    totalSourceBytes += raw.byteSize;
    const sanitized = redactTrialEvidenceText(sanitizeAutonomyText(raw.text, limits.maxBytesPerFile));
    const sanitizedByteSize = Buffer.byteLength(sanitized, 'utf8');
    if (sanitizedByteSize > limits.maxBytesPerFile) fail(`redacted input path ${relativePath} exceeds the configured byte limit`);
    entries.push({
      relativePath,
      contentType: 'text/plain',
      content: sanitized,
      byteSize: sanitizedByteSize,
      sha256: hashBytes(sanitized),
      redacted: true,
    });
  }
  const collection: RedactedTrialLogCollection = {
    schemaVersion: REDACTED_LOG_COLLECTION_SCHEMA_VERSION,
    collectedAt: validateTimestamp(options.collectedAt),
    files: entries,
    totalByteSize: entries.reduce((sum, entry) => sum + entry.byteSize, 0),
  };
  const canonicalJson = canonicalizeCollection(collection);
  const payload = Buffer.from(`${canonicalJson}\n`, 'utf8');
  if (payload.byteLength > REDACTED_LOG_MAX_OUTPUT_BYTES) fail(`collection output exceeds ${REDACTED_LOG_MAX_OUTPUT_BYTES} bytes`);
  const sha256 = hashBytes(payload);
  writeAtomic(outputPath, payload, sha256, root);
  return { collection, canonicalJson, filePath: outputPath, sha256, byteSize: payload.byteLength };
}

/** Strictly validates a collector result read from disk and returns its digest. */
export function verifyRedactedTrialLogCollectionFile(filePath: string, rootDir: string): { collection: RedactedTrialLogCollection; sha256: string; byteSize: number } {
  const root = ensureRootDirectory(rootDir);
  const absolutePath = ensurePathBelowRoot(root, filePath, false, 'collection path');
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink() || !stat.isFile()) fail('collection path must be a regular file');
  const raw = readBoundedUtf8(absolutePath, REDACTED_LOG_MAX_OUTPUT_BYTES, 'collection output');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.text); } catch { fail('collection output is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('collection output must be an object');
  const collection = parsed as RedactedTrialLogCollection;
  const collectionKeys = Object.keys(collection as object).sort();
  if (collectionKeys.join(',') !== 'collectedAt,files,schemaVersion,totalByteSize' || collection.schemaVersion !== REDACTED_LOG_COLLECTION_SCHEMA_VERSION || !Array.isArray(collection.files)) fail('collection schema is unsupported');
  if (collection.files.length > REDACTED_LOG_MAX_FILES || typeof collection.collectedAt !== 'string' || validateTimestamp(collection.collectedAt) !== collection.collectedAt || !Number.isSafeInteger(collection.totalByteSize) || collection.totalByteSize < 0) {
    fail('collection metadata is malformed');
  }
  const canonicalJson = canonicalizeCollection(collection);
  if (raw.text !== `${canonicalJson}\n`) fail('collection output is not canonical');
  let previousPath = '';
  let totalByteSize = 0;
  for (const entry of collection.files) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('collection entry is malformed');
    const entryKeys = Object.keys(entry as object).sort();
    if (entryKeys.join(',') !== 'byteSize,content,contentType,redacted,relativePath,sha256' || entry.contentType !== 'text/plain' || entry.redacted !== true || typeof entry.content !== 'string' || typeof entry.relativePath !== 'string' || normalizeRelativePath(entry.relativePath, 'collection entry relativePath') !== entry.relativePath || entry.relativePath <= previousPath || typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256) || entry.sha256 !== hashBytes(entry.content) || redactTrialEvidenceText(sanitizeAutonomyText(entry.content, REDACTED_LOG_MAX_BYTES_PER_FILE)) !== entry.content || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0 || entry.byteSize !== Buffer.byteLength(entry.content, 'utf8') || entry.byteSize > REDACTED_LOG_MAX_BYTES_PER_FILE) {
      fail('collection entry is malformed or has an invalid digest');
    }
    previousPath = entry.relativePath;
    totalByteSize += entry.byteSize;
  }
  if (totalByteSize !== collection.totalByteSize) fail('collection totalByteSize does not match entries');
  if (totalByteSize > REDACTED_LOG_MAX_TOTAL_BYTES) fail('collection exceeds the configured total byte limit');
  return { collection, sha256: hashBytes(Buffer.from(raw.text, 'utf8')), byteSize: raw.byteSize };
}
