import Database from 'better-sqlite3';
import zlib from 'zlib';
import crypto from 'crypto';
import type { Migration } from './types';

// Migration 24 raw DDL SQL is stored as compressed Base64/GZIP chunks to provide
// deterministic SQL integrity across heterogeneous host platforms
// (preventing line-ending divergence between CRLF/LF environments during Git checkouts
// for complex trigger procedural statements), while maintaining compact source file size.
// Integrity is verified at module initialization via deterministic SHA-256 comparison against
// MIGRATION_24_EXPECTED_SQL_SHA256 in decompressAndVerifyMigration24Sql.
export const MIGRATION_24_EXPECTED_SQL_SHA256 = '2fc99142425342a96d76c187ad86f5ed433c214718f0a3790e482c2767a751fd';

export const MIGRATION_24_GZIP_CHUNKS = [
  "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"
];

export function decompressAndVerifyMigration24Sql(
  chunks: readonly string[] = MIGRATION_24_GZIP_CHUNKS,
  expectedHash: string = MIGRATION_24_EXPECTED_SQL_SHA256
): string {
  // 1. Strict Base64 validation and decoding
  const base64Regex = /^[A-Za-z0-9+/=]+$/;
  const buffers: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (typeof chunk !== 'string' || chunk.length === 0) {
      throw new Error(`[MIGRATION_24_INTEGRITY_VIOLATION] Migration 24 chunk ${i} must be a non-empty string`);
    }
    const cleanChunk = chunk.replace(/[\r\n\s]+/g, '');
    if (!base64Regex.test(cleanChunk)) {
      throw new Error(`[MIGRATION_24_INTEGRITY_VIOLATION] Migration 24 chunk ${i} contains invalid Base64 characters`);
    }
    const buf = Buffer.from(cleanChunk, 'base64');
    // Round-trip check to catch invalid Base64 padding or malformed sequences
    if (buf.toString('base64').replace(/=/g, '') !== cleanChunk.replace(/=/g, '')) {
      throw new Error(`[MIGRATION_24_INTEGRITY_VIOLATION] Migration 24 chunk ${i} failed strict Base64 roundtrip verification`);
    }
    buffers.push(buf);
  }

  // 2. Strict GZIP decompression
  let decompressedBuffer: Buffer;
  try {
    const concatenated = Buffer.concat(buffers);
    decompressedBuffer = zlib.gunzipSync(concatenated);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`[MIGRATION_24_INTEGRITY_VIOLATION] Failed to decompress Migration 24 GZIP stream: ${msg}`);
  }

  // 3. Fatal UTF-8 decoding
  let decompressedSql: string;
  try {
    decompressedSql = new TextDecoder('utf-8', { fatal: true }).decode(decompressedBuffer);
  } catch (err: unknown) {
    throw new Error('[MIGRATION_24_INTEGRITY_VIOLATION] Migration 24 decompressed payload contains invalid UTF-8 bytes');
  }

  // 4. SHA-256 hash calculation and verification
  const computedHash = crypto.createHash('sha256').update(decompressedSql, 'utf8').digest('hex');
  if (computedHash !== expectedHash) {
    throw new Error(
      `[MIGRATION_24_INTEGRITY_VIOLATION] Migration 24 SQL SHA-256 mismatch: expected ${expectedHash}, computed ${computedHash}`
    );
  }

  return decompressedSql;
}

export function decompressMigration24Sql(chunks: readonly string[] = MIGRATION_24_GZIP_CHUNKS): string {
  return decompressAndVerifyMigration24Sql(chunks, MIGRATION_24_EXPECTED_SQL_SHA256);
}

export const MIGRATION_24_RAW_SQL = decompressAndVerifyMigration24Sql(
  MIGRATION_24_GZIP_CHUNKS,
  MIGRATION_24_EXPECTED_SQL_SHA256
);

export const migration024: Migration =
{
    version: 24,
    name: '024_r5j_reviewer_session_authority',
    up: (db: Database.Database) => {
      db.exec(MIGRATION_24_RAW_SQL);
    },
  }
