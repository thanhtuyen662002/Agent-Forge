/**
 * MIGRATION IMMUTABILITY RULE:
 * Once a migration version has been published/pushed to a review branch or release,
 * DO NOT EDIT OR IMPROVE IT. Always append a new migration version for subsequent
 * schema changes or data repairs.
 */

import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations/registry';
export { MIGRATIONS } from './migrations/registry';
export type { Migration } from './migrations/types';
export {
  MIGRATION_24_EXPECTED_SQL_SHA256,
  MIGRATION_24_GZIP_CHUNKS,
  MIGRATION_24_RAW_SQL,
  decompressAndVerifyMigration24Sql,
  decompressMigration24Sql,
} from './migrations/migration024';




export function verifyMigration21SchemaAuthority(db: Database.Database): void {
  // 1. Exact ledger table and version 21 row existence
  const ledgerTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  if (!ledgerTable) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 21 ledger authority (021_r5j_mcp_client_session_authority)');
  }

  const v21Row = db
    .prepare("SELECT version, name FROM schema_migrations WHERE version = 21 AND name = '021_r5j_mcp_client_session_authority'")
    .get() as { version: number; name: string } | undefined;
  if (!v21Row) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 21 ledger authority (021_r5j_mcp_client_session_authority)');
  }

  // 2. Table existence
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_sessions'")
    .get() as { name: string } | undefined;
  if (!table) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions is missing');
  }

  // 3. Exactly eight required columns, PK, notnull, type
  const columns = db.prepare("PRAGMA table_info(mcp_client_sessions)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (columns.length !== 8) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing column authority: expected exactly 8 columns (found ${columns.length})`);
  }
  const colMap = new Map(columns.map((c) => [c.name, c]));

  const requiredCols: Array<{ name: string; type: string; notnull: number; pk: number }> = [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'authorization_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'scope', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'token_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'authorization_fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'issued_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'expires_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'revoked_at', type: 'TEXT', notnull: 0, pk: 0 },
  ];

  for (let i = 0; i < requiredCols.length; i++) {
    const req = requiredCols[i];
    const col = colMap.get(req.name);
    if (!col) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing column "${req.name}"`);
    }
    if (col.type !== req.type) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" has unexpected type "${col.type}" (expected "${req.type}")`);
    }
    if (col.pk !== req.pk) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" pk authority mismatch (expected ${req.pk}, got ${col.pk})`);
    }
    if (col.notnull !== req.notnull) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" notnull authority mismatch (expected ${req.notnull}, got ${col.notnull})`);
    }
    if (col.cid !== i) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" cid order authority mismatch (expected ${i}, got ${col.cid})`);
    }
  }

  // 4. Foreign key on authorization_id -> execution_authorizations(id) with RESTRICT
  const fks = db.prepare("PRAGMA foreign_key_list(mcp_client_sessions)").all() as {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }[];
  if (fks.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions must have exactly 1 foreign key (found ${fks.length})`);
  }
  const authFk = fks[0];
  if (
    authFk.table !== 'execution_authorizations' ||
    authFk.from !== 'authorization_id' ||
    authFk.to !== 'id' ||
    authFk.on_delete !== 'RESTRICT' ||
    authFk.on_update !== 'NO ACTION' ||
    authFk.match !== 'NONE'
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions foreign key authority mismatch on authorization_id -> execution_authorizations(id)');
  }

  // 5. Indexes verification via PRAGMA index_list, index_xinfo, and sqlite_master
  const indexes = db.prepare("PRAGMA index_list(mcp_client_sessions)").all() as {
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];

  // Must have exactly 5 indexes total: exactly 4 user-defined ('c') + exactly 1 primary key ('pk')
  // Reject every origin-u autoindex and every extra index.
  if (indexes.length !== 5) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions must have exactly 5 indexes (found ${indexes.length})`);
  }

  const userDefinedIndexes = indexes.filter((idx) => idx.origin === 'c');
  if (userDefinedIndexes.length !== 4) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions must have exactly 4 user-defined indexes (found ${userDefinedIndexes.length})`);
  }

  const pkIndexes = indexes.filter((idx) => idx.origin === 'pk');
  if (pkIndexes.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions must have exactly 1 primary-key index (found ${pkIndexes.length})`);
  }

  const originUIndexes = indexes.filter((idx) => idx.origin === 'u');
  if (originUIndexes.length > 0) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions contains forbidden origin-u autoindex: ${originUIndexes[0].name}`);
  }

  const unexpectedOrigin = indexes.filter((idx) => idx.origin !== 'c' && idx.origin !== 'pk');
  if (unexpectedOrigin.length > 0) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions contains unexpected index origin: ${unexpectedOrigin[0].origin}`);
  }

  const expectedIndexNames = new Set([
    'uq_mcp_client_sessions_active_auth',
    'idx_mcp_client_sessions_token_hash',
    'idx_mcp_client_sessions_expires_at',
    'idx_mcp_client_sessions_auth_id',
  ]);

  for (const idx of userDefinedIndexes) {
    if (!expectedIndexNames.has(idx.name)) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions contains unexpected user-defined index "${idx.name}"`);
    }
  }

  const idxMap = new Map(indexes.map((idx) => [idx.name, idx]));

  interface XInfoRow {
    seqno: number;
    cid: number;
    name: string | null;
    desc: number;
    coll: string;
    key: number;
  }

  // 5.0 Implicit primary-key index verification via PRAGMA index_xinfo
  const pkIdxName = pkIndexes[0].name;
  const pkXInfo = db.prepare(`PRAGMA index_xinfo('${pkIdxName}')`).all() as XInfoRow[];
  const pkKeyCols = pkXInfo.filter((r) => r.key === 1);
  if (
    pkKeyCols.length !== 1 ||
    pkKeyCols[0].name !== 'id' ||
    pkKeyCols[0].coll !== 'BINARY' ||
    pkKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Primary key index on mcp_client_sessions must index exactly [id] ascending with BINARY collation and no extra key expression');
  }

  // 5.1 uq_mcp_client_sessions_active_auth
  const activeAuthIdx = idxMap.get('uq_mcp_client_sessions_active_auth');
  if (!activeAuthIdx || activeAuthIdx.unique !== 1 || activeAuthIdx.partial !== 1) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing unique partial index uq_mcp_client_sessions_active_auth');
  }
  const activeAuthXInfo = db.prepare("PRAGMA index_xinfo('uq_mcp_client_sessions_active_auth')").all() as XInfoRow[];
  const activeAuthKeyCols = activeAuthXInfo.filter((r) => r.key === 1);
  if (
    activeAuthKeyCols.length !== 1 ||
    activeAuthKeyCols[0].name !== 'authorization_id' ||
    activeAuthKeyCols[0].coll !== 'BINARY' ||
    activeAuthKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index uq_mcp_client_sessions_active_auth must index exactly [authorization_id] with BINARY collation');
  }
  const activeAuthSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_mcp_client_sessions_active_auth'")
    .get() as { sql: string } | undefined;
  const activeAuthSql = (activeAuthSqlRow?.sql ?? '').replace(/\s+/g, ' ').trim();
  if (!/WHERE\s+revoked_at\s+IS\s+NULL$/i.test(activeAuthSql) || /WHERE.*(?:OR|AND).*revoked_at\s+IS\s+NULL/i.test(activeAuthSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index uq_mcp_client_sessions_active_auth must have exact partial predicate WHERE revoked_at IS NULL');
  }

  // 5.2 idx_mcp_client_sessions_token_hash
  const tokenHashIdx = idxMap.get('idx_mcp_client_sessions_token_hash');
  if (!tokenHashIdx || tokenHashIdx.unique !== 1 || tokenHashIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing unique index idx_mcp_client_sessions_token_hash');
  }
  const tokenHashXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_client_sessions_token_hash')").all() as XInfoRow[];
  const tokenHashKeyCols = tokenHashXInfo.filter((r) => r.key === 1);
  if (
    tokenHashKeyCols.length !== 1 ||
    tokenHashKeyCols[0].name !== 'token_hash' ||
    tokenHashKeyCols[0].coll !== 'BINARY' ||
    tokenHashKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_client_sessions_token_hash must index exactly [token_hash] with BINARY collation');
  }

  // 5.3 idx_mcp_client_sessions_expires_at
  const expiresAtIdx = idxMap.get('idx_mcp_client_sessions_expires_at');
  if (!expiresAtIdx || expiresAtIdx.unique !== 0 || expiresAtIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing index idx_mcp_client_sessions_expires_at');
  }
  const expiresAtXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_client_sessions_expires_at')").all() as XInfoRow[];
  const expiresAtKeyCols = expiresAtXInfo.filter((r) => r.key === 1);
  if (
    expiresAtKeyCols.length !== 1 ||
    expiresAtKeyCols[0].name !== 'expires_at' ||
    expiresAtKeyCols[0].coll !== 'BINARY' ||
    expiresAtKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_client_sessions_expires_at must index exactly [expires_at] with BINARY collation');
  }

  // 5.4 idx_mcp_client_sessions_auth_id
  const authIdIdx = idxMap.get('idx_mcp_client_sessions_auth_id');
  if (!authIdIdx || authIdIdx.unique !== 0 || authIdIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing index idx_mcp_client_sessions_auth_id');
  }
  const authIdXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_client_sessions_auth_id')").all() as XInfoRow[];
  const authIdKeyCols = authIdXInfo.filter((r) => r.key === 1);
  if (
    authIdKeyCols.length !== 1 ||
    authIdKeyCols[0].name !== 'authorization_id' ||
    authIdKeyCols[0].coll !== 'BINARY' ||
    authIdKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_client_sessions_auth_id must index exactly [authorization_id] with BINARY collation');
  }

  // 6. CHECK constraints in table sql (must be exactly 6 canonical constraints)
  const tableSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mcp_client_sessions'")
    .get() as { sql: string } | undefined;
  const sql = (tableSqlRow?.sql ?? '').replace(/\s+/g, ' ');

  const checkMatches = sql.match(/\bCHECK\s*\(/gi);
  if (!checkMatches || checkMatches.length !== 6) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions must contain exactly 6 CHECK constraints (found ${checkMatches?.length ?? 0})`);
  }

  if (!/CHECK\s*\(\s*scope\s*=\s*'AUTHORIZED_CONTEXT_READ'\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing scope CHECK constraint');
  }
  if (!/CHECK\s*\(\s*length\(token_hash\)\s*=\s*64\s+AND\s+token_hash\s+GLOB\s+'(\[0-9a-f\]){64}'\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing token_hash CHECK constraint');
  }
  if (!/CHECK\s*\(\s*length\(authorization_fingerprint\)\s*=\s*64\s+AND\s+authorization_fingerprint\s+GLOB\s+'(\[0-9a-f\]){64}'\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing authorization_fingerprint CHECK constraint');
  }
  if (!/CHECK\s*\(\s*length\(issued_at\)\s*>\s*0\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing issued_at CHECK constraint');
  }
  if (!/CHECK\s*\(\s*length\(expires_at\)\s*>\s*0\s+AND\s+expires_at\s*>\s*issued_at\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing expires_at CHECK constraint');
  }
  if (!/CHECK\s*\(\s*revoked_at\s+IS\s+NULL\s+OR\s+\(\s*length\(revoked_at\)\s*>\s*0\s+AND\s+revoked_at\s*>=\s*issued_at\s*\)\s*\)/i.test(sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_client_sessions missing revoked_at CHECK constraint');
  }

  // 7. Contiguous, unique migration ledger 1..21 whose names match MIGRATIONS
  const ledgerRows = db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC')
    .all() as { version: number; name: string }[];

  if (ledgerRows.length !== 21) {
    const isCanonical22 = ledgerRows.length === 22 && ledgerRows[21]?.version === 22 && ledgerRows[21]?.name === '022_r5j_coder_submission_authority';
    const isCanonical23 = ledgerRows.length === 23 && ledgerRows[21]?.version === 22 && ledgerRows[21]?.name === '022_r5j_coder_submission_authority' && ledgerRows[22]?.version === 23 && ledgerRows[22]?.name === '023_r5j_quarantined_submission_adjudication_and_verification_admission';
    const isCanonical24 = ledgerRows.length === 24 && ledgerRows[21]?.version === 22 && ledgerRows[21]?.name === '022_r5j_coder_submission_authority' && ledgerRows[22]?.version === 23 && ledgerRows[22]?.name === '023_r5j_quarantined_submission_adjudication_and_verification_admission' && ledgerRows[23]?.version === 24 && ledgerRows[23]?.name === '024_r5j_reviewer_session_authority';
    if (!isCanonical22 && !isCanonical23 && !isCanonical24) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema migrations ledger must contain exactly 21 migrations (found ${ledgerRows.length})`);
    }
  }

  const checkCount = Math.min(ledgerRows.length, 21);
  for (let i = 0; i < checkCount; i++) {
    const expectedVersion = i + 1;
    const expectedMigration = MIGRATIONS[i];
    if (ledgerRows[i].version !== expectedVersion) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema ledger is not contiguous: expected version ${expectedVersion}, got ${ledgerRows[i].version}`);
    }
    if (ledgerRows[i].name !== expectedMigration.name) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema ledger migration name mismatch at version ${expectedVersion}: expected "${expectedMigration.name}", got "${ledgerRows[i].name}"`);
    }
  }
}

export function verifyMigration22SchemaAuthority(db: Database.Database): void {
  // 1. Exact ledger table and version 22 row existence
  const ledgerTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { name: string } | undefined;
  if (!ledgerTable) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 22 ledger authority (022_r5j_coder_submission_authority)');
  }

  const v22Row = db
    .prepare("SELECT version, name FROM schema_migrations WHERE version = 22 AND name = '022_r5j_coder_submission_authority'")
    .get() as { version: number; name: string } | undefined;
  if (!v22Row) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 22 ledger authority (022_r5j_coder_submission_authority)');
  }

  // Contiguous, unique migration ledger 1..22 whose names match MIGRATIONS
  const ledgerRows = db
    .prepare('SELECT version, name FROM schema_migrations ORDER BY version ASC')
    .all() as { version: number; name: string }[];

  if (ledgerRows.length !== 22) {
    const isCanonical23 = ledgerRows.length === 23 && ledgerRows[22]?.version === 23 && ledgerRows[22]?.name === '023_r5j_quarantined_submission_adjudication_and_verification_admission';
    const isCanonical24 = ledgerRows.length === 24 && ledgerRows[22]?.version === 23 && ledgerRows[22]?.name === '023_r5j_quarantined_submission_adjudication_and_verification_admission' && ledgerRows[23]?.version === 24 && ledgerRows[23]?.name === '024_r5j_reviewer_session_authority';
    if (!isCanonical23 && !isCanonical24) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema migrations ledger must contain exactly 22 migrations (found ${ledgerRows.length})`);
    }
  }

  for (let i = 0; i < ledgerRows.length; i++) {
    const expectedVersion = i + 1;
    const expectedMigration = MIGRATIONS[i];
    if (ledgerRows[i].version !== expectedVersion) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema ledger is not contiguous: expected version ${expectedVersion}, got ${ledgerRows[i].version}`);
    }
    if (ledgerRows[i].name !== expectedMigration.name) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Database schema ledger migration name mismatch at version ${expectedVersion}: expected "${expectedMigration.name}", got "${ledgerRows[i].name}"`);
    }
  }

  // Helper type for pragma index info
  interface XInfoRow {
    seqno: number;
    cid: number;
    name: string | null;
    desc: number;
    coll: string;
    key: number;
  }

  // 2. Table: mcp_submission_sessions
  const sessTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_submission_sessions'")
    .get() as { name: string } | undefined;
  if (!sessTable) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions is missing');
  }

  const sessColumns = db.prepare("PRAGMA table_info(mcp_submission_sessions)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (sessColumns.length !== 10) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing column authority: expected exactly 10 columns (found ${sessColumns.length})`);
  }
  const sessColMap = new Map(sessColumns.map((c) => [c.name, c]));
  const reqSessCols: Array<{ name: string; type: string; notnull: number; pk: number }> = [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'authorization_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'scope', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'issuer_identity', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'token_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'authorization_fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'issued_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'expires_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'revoked_at', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'revocation_reason', type: 'TEXT', notnull: 0, pk: 0 },
  ];

  for (let i = 0; i < reqSessCols.length; i++) {
    const req = reqSessCols[i];
    const col = sessColMap.get(req.name);
    if (!col) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing column "${req.name}"`);
    }
    if (col.type !== req.type) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" has unexpected type "${col.type}" (expected "${req.type}")`);
    }
    if (col.pk !== req.pk) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" pk authority mismatch (expected ${req.pk}, got ${col.pk})`);
    }
    if (col.notnull !== req.notnull) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" notnull authority mismatch (expected ${req.notnull}, got ${col.notnull})`);
    }
    if (col.cid !== i) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" cid order authority mismatch (expected ${i}, got ${col.cid})`);
    }
  }

  // FK on mcp_submission_sessions
  const sessFks = db.prepare("PRAGMA foreign_key_list(mcp_submission_sessions)").all() as {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }[];
  if (sessFks.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions must contain exactly 1 foreign key (found ${sessFks.length})`);
  }
  const sessFk = sessFks[0];
  if (
    sessFk.table !== 'execution_authorizations' ||
    sessFk.from !== 'authorization_id' ||
    sessFk.to !== 'id' ||
    sessFk.on_delete.toUpperCase() !== 'RESTRICT' ||
    sessFk.on_update.toUpperCase() !== 'NO ACTION' ||
    sessFk.match !== 'NONE'
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions foreign key on authorization_id must reference execution_authorizations(id) ON DELETE RESTRICT');
  }

  // Indexes on mcp_submission_sessions
  const sessIdxList = db.prepare("PRAGMA index_list(mcp_submission_sessions)").all() as {
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  if (sessIdxList.length !== 5) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions must have exactly 5 indexes total (found ${sessIdxList.length})`);
  }
  const sessUserIdxs = sessIdxList.filter((idx) => idx.origin === 'c');
  if (sessUserIdxs.length !== 4) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions must have exactly 4 user-defined indexes (found ${sessUserIdxs.length})`);
  }
  const sessPkIdxs = sessIdxList.filter((idx) => idx.origin === 'pk');
  if (sessPkIdxs.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions must have exactly 1 primary-key index (found ${sessPkIdxs.length})`);
  }
  const autoIdxs = sessIdxList.filter((idx) => idx.origin === 'u');
  if (autoIdxs.length > 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions contains unexpected auto-indexes (origin = "u")');
  }

  const sessIdxMap = new Map(sessIdxList.map((idx) => [idx.name, idx]));
  const uqActive = sessIdxMap.get('uq_mcp_submission_sessions_active_auth');
  if (!uqActive || uqActive.unique !== 1 || uqActive.partial !== 1) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing partial unique index uq_mcp_submission_sessions_active_auth');
  }
  const uqActiveXInfo = db.prepare("PRAGMA index_xinfo('uq_mcp_submission_sessions_active_auth')").all() as XInfoRow[];
  const uqActiveKeyCols = uqActiveXInfo.filter((r) => r.key === 1);
  if (
    uqActiveKeyCols.length !== 1 ||
    uqActiveKeyCols[0].name !== 'authorization_id' ||
    uqActiveKeyCols[0].coll !== 'BINARY' ||
    uqActiveKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index uq_mcp_submission_sessions_active_auth must index [authorization_id] with BINARY collation');
  }
  const uqActiveSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'uq_mcp_submission_sessions_active_auth'")
    .get() as { sql: string } | undefined;
  if (!uqActiveSqlRow || !/WHERE\s+revoked_at\s+IS\s+NULL/i.test(uqActiveSqlRow.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index uq_mcp_submission_sessions_active_auth missing WHERE revoked_at IS NULL predicate');
  }

  const tokenHashIdx = sessIdxMap.get('idx_mcp_submission_sessions_token_hash');
  if (!tokenHashIdx || tokenHashIdx.unique !== 1 || tokenHashIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing unique index idx_mcp_submission_sessions_token_hash');
  }
  const tokenHashXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_submission_sessions_token_hash')").all() as XInfoRow[];
  const tokenHashKeyCols = tokenHashXInfo.filter((r) => r.key === 1);
  if (
    tokenHashKeyCols.length !== 1 ||
    tokenHashKeyCols[0].name !== 'token_hash' ||
    tokenHashKeyCols[0].coll !== 'BINARY' ||
    tokenHashKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_submission_sessions_token_hash must index [token_hash] with BINARY collation');
  }

  const expiresAtIdx = sessIdxMap.get('idx_mcp_submission_sessions_expires_at');
  if (!expiresAtIdx || expiresAtIdx.unique !== 0 || expiresAtIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing index idx_mcp_submission_sessions_expires_at');
  }
  const expiresAtXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_submission_sessions_expires_at')").all() as XInfoRow[];
  const expiresAtKeyCols = expiresAtXInfo.filter((r) => r.key === 1);
  if (
    expiresAtKeyCols.length !== 1 ||
    expiresAtKeyCols[0].name !== 'expires_at' ||
    expiresAtKeyCols[0].coll !== 'BINARY' ||
    expiresAtKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_submission_sessions_expires_at must index [expires_at] with BINARY collation');
  }

  const authIdIdx = sessIdxMap.get('idx_mcp_submission_sessions_auth_id');
  if (!authIdIdx || authIdIdx.unique !== 0 || authIdIdx.partial !== 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing index idx_mcp_submission_sessions_auth_id');
  }
  const authIdXInfo = db.prepare("PRAGMA index_xinfo('idx_mcp_submission_sessions_auth_id')").all() as XInfoRow[];
  const authIdKeyCols = authIdXInfo.filter((r) => r.key === 1);
  if (
    authIdKeyCols.length !== 1 ||
    authIdKeyCols[0].name !== 'authorization_id' ||
    authIdKeyCols[0].coll !== 'BINARY' ||
    authIdKeyCols[0].desc !== 0
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Index idx_mcp_submission_sessions_auth_id must index [authorization_id] with BINARY collation');
  }

  // CHECK constraints on mcp_submission_sessions
  const sessSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mcp_submission_sessions'")
    .get() as { sql: string } | undefined;
  const sessSql = (sessSqlRow?.sql ?? '').replace(/\s+/g, ' ');
  const sessChecks = sessSql.match(/\bCHECK\s*\(/gi);
  if (!sessChecks || sessChecks.length !== 8) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions must contain exactly 8 CHECK constraints (found ${sessChecks?.length ?? 0})`);
  }
  if (!/scope\s*=\s*'CODER_SUBMISSION'/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing scope CHECK constraint');
  }
  if (!/issuer_identity\s*=\s*'OWNER_LOCAL_CLI'/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing issuer_identity CHECK constraint');
  }
  if (!/length\(token_hash\)\s*=\s*64\s+AND\s+token_hash\s+GLOB\s+'(\[0-9a-f\]){64}'/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing token_hash CHECK constraint');
  }
  if (!/length\(authorization_fingerprint\)\s*=\s*64\s+AND\s+authorization_fingerprint\s+GLOB\s+'(\[0-9a-f\]){64}'/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing authorization_fingerprint CHECK constraint');
  }
  if (!/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*issued_at\)\s*=\s*issued_at/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing issued_at round-trip CHECK constraint');
  }
  if (!/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*expires_at\)\s*=\s*expires_at/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing expires_at round-trip CHECK constraint');
  }
  if (!/\(unixepoch\(expires_at\)\s*-\s*unixepoch\(issued_at\)\)\s*>=\s*300\s+AND\s+\(unixepoch\(expires_at\)\s*-\s*unixepoch\(issued_at\)\)\s*<=\s*86400/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing TTL bounds CHECK constraint');
  }
  if (!/revoked_at\s+IS\s+NULL\s+AND\s+revocation_reason\s+IS\s+NULL/i.test(sessSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing revoked_at CHECK constraint');
  }

  // Triggers on mcp_submission_sessions
  const sessTriggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'mcp_submission_sessions'")
    .all() as { name: string; sql: string }[];
  const sessTrigMap = new Map(sessTriggers.map((t) => [t.name, t]));
  if (!sessTrigMap.has('trg_mcp_submission_sessions_no_delete') || !sessTrigMap.has('trg_mcp_submission_sessions_immutable_update')) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions missing required triggers');
  }
  if (sessTriggers.length !== 2) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table mcp_submission_sessions has unexpected triggers (found ${sessTriggers.length})`);
  }
  const noDeleteTrig = sessTrigMap.get('trg_mcp_submission_sessions_no_delete')!;
  if (!/BEFORE\s+DELETE\s+ON\s+mcp_submission_sessions/i.test(noDeleteTrig.sql) || !/MCP_SUBMISSION_SESSION_DELETE_FORBIDDEN/i.test(noDeleteTrig.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_mcp_submission_sessions_no_delete authority mismatch');
  }
  const immutableUpdateTrig = sessTrigMap.get('trg_mcp_submission_sessions_immutable_update')!;
  if (
    !/BEFORE\s+UPDATE\s+ON\s+mcp_submission_sessions/i.test(immutableUpdateTrig.sql) ||
    !/MCP_SUBMISSION_SESSION_ALREADY_REVOKED/i.test(immutableUpdateTrig.sql) ||
    !/MCP_SUBMISSION_SESSION_MUTATION_FORBIDDEN/i.test(immutableUpdateTrig.sql) ||
    !/NEW\.issuer_identity\s*!=\s*OLD\.issuer_identity/i.test(immutableUpdateTrig.sql)
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_mcp_submission_sessions_immutable_update authority mismatch');
  }

  // 3. Table: coder_submissions
  const subTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_submissions'")
    .get() as { name: string } | undefined;
  if (!subTable) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions is missing');
  }

  const subColumns = db.prepare("PRAGMA table_info(coder_submissions)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (subColumns.length !== 36) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing column authority: expected exactly 36 columns (found ${subColumns.length})`);
  }
  const subColMap = new Map(subColumns.map((c) => [c.name, c]));
  const reqSubCols: Array<{ name: string; type: string; notnull: number; pk: number }> = [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'authorization_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'project_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'task_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'task_ownership_epoch', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'session_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'lifecycle_version', type: 'INTEGER', notnull: 0, pk: 0 },
    { name: 'execution_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'attempt_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'assignment_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'selected_provider_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'selected_account_id', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'selected_resource_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'manager_message_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'routing_decision_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'base_sha', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'authorized_head_sha', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'schema_version', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'authorization_status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'dispatched_at', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'authority_fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'manager_payload_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'task_revision', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'claimed_status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'quarantine_status', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'summary', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'changed_files_count', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'tests_claimed_count', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'blockers_count', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'review_requested', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'claim_content_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'canonical_envelope_hash', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'claim_content_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'canonical_envelope_json', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'canonical_arguments_bytes', type: 'INTEGER', notnull: 1, pk: 0 },
    { name: 'submitted_at', type: 'TEXT', notnull: 1, pk: 0 },
  ];

  for (let i = 0; i < reqSubCols.length; i++) {
    const req = reqSubCols[i];
    const col = subColMap.get(req.name);
    if (!col) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing column "${req.name}"`);
    }
    if (col.type !== req.type) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" has unexpected type "${col.type}" (expected "${req.type}")`);
    }
    if (col.pk !== req.pk) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" pk authority mismatch (expected ${req.pk}, got ${col.pk})`);
    }
    if (col.notnull !== req.notnull) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" notnull authority mismatch (expected ${req.notnull}, got ${col.notnull})`);
    }
    if (col.cid !== i) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" cid order authority mismatch (expected ${i}, got ${col.cid})`);
    }
  }

  // FKs on coder_submissions: exactly 9 FKs
  const subFks = db.prepare("PRAGMA foreign_key_list(coder_submissions)").all() as {
    id: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }[];
  if (subFks.length !== 9) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions must contain exactly 9 foreign keys (found ${subFks.length})`);
  }
  const expectedFkMap = new Map([
    ['authorization_id', { table: 'execution_authorizations', to: 'id' }],
    ['project_id', { table: 'projects', to: 'id' }],
    ['task_id', { table: 'tasks', to: 'id' }],
    ['session_id', { table: 'mcp_submission_sessions', to: 'id' }],
    ['attempt_id', { table: 'task_attempts', to: 'id' }],
    ['assignment_id', { table: 'agent_assignments', to: 'id' }],
    ['selected_provider_id', { table: 'providers', to: 'id' }],
    ['selected_account_id', { table: 'provider_accounts', to: 'id' }],
    ['selected_resource_id', { table: 'provider_resources', to: 'id' }],
  ]);
  for (const fk of subFks) {
    if (fk.on_delete.toUpperCase() !== 'RESTRICT' || fk.on_update.toUpperCase() !== 'NO ACTION' || fk.match !== 'NONE') {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Foreign key on "${fk.from}" must be ON DELETE RESTRICT (got ${fk.on_delete})`);
    }
    const exp = expectedFkMap.get(fk.from);
    if (!exp || exp.table !== fk.table || exp.to !== fk.to) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Foreign key on "${fk.from}" references unexpected table "${fk.table}"("${fk.to}")`);
    }
  }

  // Indexes on coder_submissions
  const subIdxList = db.prepare("PRAGMA index_list(coder_submissions)").all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  if (subIdxList.length !== 7) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions must have exactly 7 indexes total (found ${subIdxList.length})`);
  }
  const subUserIdxs = subIdxList.filter((idx) => idx.origin === 'c');
  if (subUserIdxs.length !== 6) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions must have exactly 6 user-defined indexes (found ${subUserIdxs.length})`);
  }
  const subPkIdxs = subIdxList.filter((idx) => idx.origin === 'pk');
  if (subPkIdxs.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions must have exactly 1 primary-key index (found ${subPkIdxs.length})`);
  }
  const subAutoIdxs = subIdxList.filter((idx) => idx.origin === 'u');
  if (subAutoIdxs.length > 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions contains unexpected auto-indexes (origin = "u")');
  }

  const expectedSubIndexes = new Map([
    ['idx_coder_submissions_auth_id', 'authorization_id'],
    ['idx_coder_submissions_task_id', 'task_id'],
    ['idx_coder_submissions_session_id', 'session_id'],
    ['idx_coder_submissions_content_hash', 'claim_content_hash'],
    ['idx_coder_submissions_envelope_hash', 'canonical_envelope_hash'],
    ['idx_coder_submissions_submitted_at', 'submitted_at'],
  ]);

  for (const [idxName, colName] of expectedSubIndexes.entries()) {
    const idx = subIdxList.find((i) => i.name === idxName);
    if (!idx || idx.unique !== 0 || idx.partial !== 0) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Index "${idxName}" on coder_submissions missing or not non-unique non-partial`);
    }
    const xinfo = db.prepare(`PRAGMA index_xinfo('${idxName}')`).all() as XInfoRow[];
    const keyCols = xinfo.filter((r) => r.key === 1);
    if (keyCols.length !== 1 || keyCols[0].name !== colName || keyCols[0].coll !== 'BINARY' || keyCols[0].desc !== 0) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Index "${idxName}" must index [${colName}] with BINARY collation`);
    }
  }

  // CHECK constraints on coder_submissions
  const subSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'coder_submissions'")
    .get() as { sql: string } | undefined;
  const subSql = (subSqlRow?.sql ?? '').replace(/\s+/g, ' ');
  const subChecks = subSql.match(/\bCHECK\s*\(/gi);
  if (!subChecks || subChecks.length !== 25) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions must contain exactly 25 CHECK constraints (found ${subChecks?.length ?? 0})`);
  }
  if (!/schema_version\s*=\s*1/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing schema_version CHECK constraint');
  }
  if (!/authorization_status\s*=\s*'DISPATCHED'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing authorization_status CHECK constraint');
  }
  if (!/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*dispatched_at\)\s*=\s*dispatched_at/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing dispatched_at round-trip CHECK constraint');
  }
  if (!/length\(authority_fingerprint\)\s*=\s*64\s+AND\s+authority_fingerprint\s+GLOB\s+'(\[0-9a-f\]){64}'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing authority_fingerprint CHECK constraint');
  }
  if (!/length\(manager_payload_hash\)\s*=\s*64\s+AND\s+manager_payload_hash\s+GLOB\s+'(\[0-9a-f\]){64}'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing manager_payload_hash CHECK constraint');
  }
  if (!/task_revision\s*>=\s*0/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing task_revision CHECK constraint');
  }
  if (!/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*submitted_at\)\s*=\s*submitted_at/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing submitted_at round-trip CHECK constraint');
  }
  if (!/quarantine_status\s*=\s*'QUARANTINED'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing quarantine_status CHECK constraint');
  }
  if (!/json_valid\(claim_content_json\)\s*=\s*1\s+AND\s+json_type\(claim_content_json\)\s*=\s*'object'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing claim_content_json object CHECK constraint');
  }
  if (!/json_valid\(canonical_envelope_json\)\s*=\s*1\s+AND\s+json_type\(canonical_envelope_json\)\s*=\s*'object'/i.test(subSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing canonical_envelope_json object CHECK constraint');
  }

  // Triggers on coder_submissions
  const subTriggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coder_submissions'")
    .all() as { name: string; sql: string }[];
  const subTrigMap = new Map(subTriggers.map((t) => [t.name, t]));
  if (!subTrigMap.has('trg_coder_submissions_no_update') || !subTrigMap.has('trg_coder_submissions_no_delete')) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions missing required triggers');
  }
  if (subTriggers.length !== 2) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submissions has unexpected triggers (found ${subTriggers.length})`);
  }
  const subNoUpdateTrig = subTrigMap.get('trg_coder_submissions_no_update')!;
  if (!/BEFORE\s+UPDATE\s+ON\s+coder_submissions/i.test(subNoUpdateTrig.sql) || !/coder_submissions is strictly append-only: UPDATE is prohibited/i.test(subNoUpdateTrig.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_coder_submissions_no_update authority mismatch');
  }
  const subNoDeleteTrig = subTrigMap.get('trg_coder_submissions_no_delete')!;
  if (!/BEFORE\s+DELETE\s+ON\s+coder_submissions/i.test(subNoDeleteTrig.sql) || !/coder_submissions is strictly append-only: DELETE is prohibited/i.test(subNoDeleteTrig.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_coder_submissions_no_delete authority mismatch');
  }

  // 4. Table: coder_submission_dispositions
  const dispTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_submission_dispositions'")
    .get() as { name: string } | undefined;
  if (!dispTable) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions is missing');
  }

  const dispColumns = db.prepare("PRAGMA table_info(coder_submission_dispositions)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (dispColumns.length !== 8) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions missing column authority: expected exactly 8 columns (found ${dispColumns.length})`);
  }
  const dispColMap = new Map(dispColumns.map((c) => [c.name, c]));
  const reqDispCols: Array<{ name: string; type: string; notnull: number; pk: number }> = [
    { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'submission_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'disposition_event', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'disposition_reason', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'actor_type', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'actor_id', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'disposition_metadata_json', type: 'TEXT', notnull: 0, pk: 0 },
    { name: 'created_at', type: 'TEXT', notnull: 1, pk: 0 },
  ];

  for (let i = 0; i < reqDispCols.length; i++) {
    const req = reqDispCols[i];
    const col = dispColMap.get(req.name);
    if (!col) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions missing column "${req.name}"`);
    }
    if (col.type !== req.type) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" has unexpected type "${col.type}" (expected "${req.type}")`);
    }
    if (col.pk !== req.pk) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" pk authority mismatch (expected ${req.pk}, got ${col.pk})`);
    }
    if (col.notnull !== req.notnull) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" notnull authority mismatch (expected ${req.notnull}, got ${col.notnull})`);
    }
    if (col.cid !== i) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Column "${req.name}" cid order authority mismatch (expected ${i}, got ${col.cid})`);
    }
  }

  // FK on coder_submission_dispositions
  const dispFks = db.prepare("PRAGMA foreign_key_list(coder_submission_dispositions)").all() as {
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
    match: string;
  }[];
  if (dispFks.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions must contain exactly 1 foreign key (found ${dispFks.length})`);
  }
  if (
    dispFks[0].table !== 'coder_submissions' ||
    dispFks[0].from !== 'submission_id' ||
    dispFks[0].to !== 'id' ||
    dispFks[0].on_delete.toUpperCase() !== 'RESTRICT' ||
    dispFks[0].on_update.toUpperCase() !== 'NO ACTION' ||
    dispFks[0].match !== 'NONE'
  ) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions foreign key must reference coder_submissions(id) ON DELETE RESTRICT');
  }

  // Indexes on coder_submission_dispositions
  const dispIdxList = db.prepare("PRAGMA index_list(coder_submission_dispositions)").all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  if (dispIdxList.length !== 4) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions must have exactly 4 indexes total (found ${dispIdxList.length})`);
  }
  const dispUserIdxs = dispIdxList.filter((idx) => idx.origin === 'c');
  if (dispUserIdxs.length !== 3) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions must have exactly 3 user-defined indexes (found ${dispUserIdxs.length})`);
  }
  const dispPkIdxs = dispIdxList.filter((idx) => idx.origin === 'pk');
  if (dispPkIdxs.length !== 1) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions must have exactly 1 primary-key index (found ${dispPkIdxs.length})`);
  }
  const dispAutoIdxs = dispIdxList.filter((idx) => idx.origin === 'u');
  if (dispAutoIdxs.length > 0) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions contains unexpected auto-indexes (origin = "u")');
  }

  const expectedDispIndexes = new Map([
    ['idx_coder_submission_dispositions_submission', 'submission_id'],
    ['idx_coder_submission_dispositions_event', 'disposition_event'],
    ['idx_coder_submission_dispositions_created_at', 'created_at'],
  ]);

  for (const [idxName, colName] of expectedDispIndexes.entries()) {
    const idx = dispIdxList.find((i) => i.name === idxName);
    if (!idx || idx.unique !== 0 || idx.partial !== 0) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Index "${idxName}" on coder_submission_dispositions missing or invalid`);
    }
    const xinfo = db.prepare(`PRAGMA index_xinfo('${idxName}')`).all() as XInfoRow[];
    const keyCols = xinfo.filter((r) => r.key === 1);
    if (keyCols.length !== 1 || keyCols[0].name !== colName || keyCols[0].coll !== 'BINARY' || keyCols[0].desc !== 0) {
      throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Index "${idxName}" must index [${colName}] with BINARY collation`);
    }
  }

  // CHECK constraints on coder_submission_dispositions
  const dispSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'coder_submission_dispositions'")
    .get() as { sql: string } | undefined;
  const dispSql = (dispSqlRow?.sql ?? '').replace(/\s+/g, ' ');
  const dispChecks = dispSql.match(/\bCHECK\s*\(/gi);
  if (!dispChecks || dispChecks.length !== 6) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions must contain exactly 6 CHECK constraints (found ${dispChecks?.length ?? 0})`);
  }
  if (!/strftime\('%Y-%m-%dT%H:%M:%fZ',\s*created_at\)\s*=\s*created_at/i.test(dispSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions missing created_at round-trip CHECK constraint');
  }
  if (!/actor_type\s+IN\s+\('SYSTEM',\s*'MCP_CLIENT',\s*'OPERATOR'\)/i.test(dispSql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions missing actor_type CHECK constraint');
  }

  // Triggers on coder_submission_dispositions
  const dispTriggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coder_submission_dispositions'")
    .all() as { name: string; sql: string }[];
  const dispTrigMap = new Map(dispTriggers.map((t) => [t.name, t]));
  if (!dispTrigMap.has('trg_coder_submission_dispositions_no_update') || !dispTrigMap.has('trg_coder_submission_dispositions_no_delete')) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions missing required triggers');
  }
  if (dispTriggers.length !== 2) {
    throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Table coder_submission_dispositions has unexpected triggers (found ${dispTriggers.length})`);
  }
  const dispNoUpdateTrig = dispTrigMap.get('trg_coder_submission_dispositions_no_update')!;
  if (!/BEFORE\s+UPDATE\s+ON\s+coder_submission_dispositions/i.test(dispNoUpdateTrig.sql) || !/coder_submission_dispositions is strictly append-only: UPDATE is prohibited/i.test(dispNoUpdateTrig.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_coder_submission_dispositions_no_update authority mismatch');
  }
  const dispNoDeleteTrig = dispTrigMap.get('trg_coder_submission_dispositions_no_delete')!;
  if (!/BEFORE\s+DELETE\s+ON\s+coder_submission_dispositions/i.test(dispNoDeleteTrig.sql) || !/coder_submission_dispositions is strictly append-only: DELETE is prohibited/i.test(dispNoDeleteTrig.sql)) {
    throw new Error('[MCP_SCHEMA_AUTHORITY_INVALID] Trigger trg_coder_submission_dispositions_no_delete authority mismatch');
  }

  // 5. Prohibit unexpected extra tables, indexes, or triggers in sqlite_master
  const allMasterRows = db
    .prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger')")
    .all() as { type: string; name: string; tbl_name: string }[];

  const v22Tables = new Set(['mcp_submission_sessions', 'coder_submissions', 'coder_submission_dispositions']);
  const allowedAuthorityTables = new Set(v22Tables);
  if (ledgerRows.length >= 23) {
    allowedAuthorityTables.add('coder_submission_adjudications');
    allowedAuthorityTables.add('coder_submission_adjudication_events');
    allowedAuthorityTables.add('coder_submission_workspace_leases');
  }
  for (const row of allMasterRows) {
    if (row.type === 'table') {
      if ((row.name.startsWith('mcp_sub') || row.name.startsWith('coder_sub')) && !allowedAuthorityTables.has(row.name)) {
        throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Unexpected authority table in schema: "${row.name}"`);
      }
    } else if (row.type === 'trigger') {
      if (v22Tables.has(row.tbl_name)) {
        const allowedTriggers = new Set([
          'trg_mcp_submission_sessions_no_delete',
          'trg_mcp_submission_sessions_immutable_update',
          'trg_coder_submissions_no_update',
          'trg_coder_submissions_no_delete',
          'trg_coder_submission_dispositions_no_update',
          'trg_coder_submission_dispositions_no_delete',
        ]);
        if (!allowedTriggers.has(row.name)) {
          throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Unexpected authority trigger: "${row.name}" on table "${row.tbl_name}"`);
        }
      }
    } else if (row.type === 'index') {
      if (v22Tables.has(row.tbl_name)) {
        const allowedIndexes = new Set([
          'uq_mcp_submission_sessions_active_auth',
          'idx_mcp_submission_sessions_token_hash',
          'idx_mcp_submission_sessions_expires_at',
          'idx_mcp_submission_sessions_auth_id',
          'idx_coder_submissions_auth_id',
          'idx_coder_submissions_task_id',
          'idx_coder_submissions_session_id',
          'idx_coder_submissions_content_hash',
          'idx_coder_submissions_envelope_hash',
          'idx_coder_submissions_submitted_at',
          'idx_coder_submission_dispositions_submission',
          'idx_coder_submission_dispositions_event',
          'idx_coder_submission_dispositions_created_at',
        ]);
        if (!allowedIndexes.has(row.name) && !row.name.startsWith('sqlite_autoindex_')) {
          throw new Error(`[MCP_SCHEMA_AUTHORITY_INVALID] Unexpected authority index: "${row.name}" on table "${row.tbl_name}"`);
        }
      }
    }
  }
}

export function verifyMigration23SchemaAuthority(db: Database.Database): void {
  // 1. Exact ledger entry
  const v23Row = db
    .prepare("SELECT version, name FROM schema_migrations WHERE version = 23 AND name = '023_r5j_quarantined_submission_adjudication_and_verification_admission'")
    .get() as { version: number; name: string } | undefined;
  if (!v23Row) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 23 ledger authority (023_r5j_quarantined_submission_adjudication_and_verification_admission)');
  }

  // 2. Table existence
  const adjTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_submission_adjudications'").get();
  if (!adjTable) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudications is missing');
  }

  const eventsTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_submission_adjudication_events'").get();
  if (!eventsTable) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudication_events is missing');
  }

  const leaseTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'coder_submission_workspace_leases'").get();
  if (!leaseTable) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_workspace_leases is missing');
  }

  // 3. Columns on coder_submission_adjudications: exactly 39 columns
  const adjColumns = db.prepare("PRAGMA table_info(coder_submission_adjudications)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (adjColumns.length !== 39) {
    throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudications missing column authority: expected exactly 39 columns (found ${adjColumns.length})`);
  }

  const expectedAdjColumns: Record<string, { type: string; notnull: number; pk: number }> = {
    id: { type: 'TEXT', notnull: 0, pk: 1 },
    request_id: { type: 'TEXT', notnull: 1, pk: 0 },
    submission_id: { type: 'TEXT', notnull: 1, pk: 0 },
    authorization_id: { type: 'TEXT', notnull: 1, pk: 0 },
    project_id: { type: 'TEXT', notnull: 1, pk: 0 },
    task_id: { type: 'TEXT', notnull: 1, pk: 0 },
    attempt_id: { type: 'TEXT', notnull: 1, pk: 0 },
    assignment_id: { type: 'TEXT', notnull: 1, pk: 0 },
    task_ownership_epoch: { type: 'INTEGER', notnull: 1, pk: 0 },
    action: { type: 'TEXT', notnull: 1, pk: 0 },
    status: { type: 'TEXT', notnull: 1, pk: 0 },
    lifecycle_version: { type: 'INTEGER', notnull: 1, pk: 0 },
    authority_snapshot_json: { type: 'TEXT', notnull: 1, pk: 0 },
    authority_snapshot_hash: { type: 'TEXT', notnull: 1, pk: 0 },
    verification_commands_json: { type: 'TEXT', notnull: 0, pk: 0 },
    verification_commands_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    workspace_snapshot_before_json: { type: 'TEXT', notnull: 0, pk: 0 },
    workspace_snapshot_before_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    verification_result_envelope_json: { type: 'TEXT', notnull: 0, pk: 0 },
    verification_result_envelope_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    verification_execution_id: { type: 'TEXT', notnull: 0, pk: 0 },
    protocol_message_id: { type: 'TEXT', notnull: 0, pk: 0 },
    test_run_id: { type: 'TEXT', notnull: 0, pk: 0 },
    git_status_evidence_id: { type: 'TEXT', notnull: 0, pk: 0 },
    git_diff_evidence_id: { type: 'TEXT', notnull: 0, pk: 0 },
    failure_code: { type: 'TEXT', notnull: 0, pk: 0 },
    failure_json: { type: 'TEXT', notnull: 0, pk: 0 },
    created_at: { type: 'TEXT', notnull: 1, pk: 0 },
    verification_started_at: { type: 'TEXT', notnull: 0, pk: 0 },
    completed_at: { type: 'TEXT', notnull: 0, pk: 0 },
    recovery_fenced_at: { type: 'TEXT', notnull: 0, pk: 0 },
    resolution_action: { type: 'TEXT', notnull: 0, pk: 0 },
    resolution_timestamp: { type: 'TEXT', notnull: 0, pk: 0 },
    resolution_evidence_json: { type: 'TEXT', notnull: 0, pk: 0 },
    resolution_evidence_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    resolver_id: { type: 'TEXT', notnull: 0, pk: 0 },
    artifact_manifest_json: { type: 'TEXT', notnull: 0, pk: 0 },
    artifact_manifest_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    workspace_lease_id: { type: 'TEXT', notnull: 0, pk: 0 },
  };

  for (const [colName, expected] of Object.entries(expectedAdjColumns)) {
    const col = adjColumns.find((c) => c.name === colName);
    if (!col) {
      throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudications missing column "${colName}"`);
    }
    if (col.type !== expected.type || col.notnull !== expected.notnull || col.pk !== expected.pk) {
      throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudications column "${colName}" attributes mismatch`);
    }
  }

  // 4. FKs on coder_submission_adjudications: exactly 11 foreign keys
  const adjFks = db.prepare("PRAGMA foreign_key_list(coder_submission_adjudications)").all() as {
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }[];
  if (adjFks.length !== 11) {
    throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudications must contain exactly 11 foreign keys (found ${adjFks.length})`);
  }

  // 5. Indexes on coder_submission_adjudications
  const adjIdxs = db.prepare("PRAGMA index_list(coder_submission_adjudications)").all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  const activePartialIdx = adjIdxs.find((i) => i.name === 'idx_coder_submission_adjudications_active');
  if (!activePartialIdx || activePartialIdx.unique !== 1 || activePartialIdx.partial !== 1) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Partial unique index idx_coder_submission_adjudications_active missing or invalid');
  }

  // 6. Triggers on coder_submission_adjudications
  const adjTriggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coder_submission_adjudications'").all() as { name: string }[];
  const expectedAdjTriggers = new Set([
    'trg_coder_submission_adjudications_no_delete',
    'trg_coder_submission_adjudications_immutable_fields',
    'trg_coder_submission_adjudications_lifecycle_cas',
  ]);
  if (adjTriggers.length !== expectedAdjTriggers.size || adjTriggers.some((t) => !expectedAdjTriggers.has(t.name))) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Triggers on coder_submission_adjudications mismatch expected authority');
  }

  // 7. Columns on coder_submission_workspace_leases: exactly 16 columns
  const leaseColumns = db.prepare("PRAGMA table_info(coder_submission_workspace_leases)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (leaseColumns.length !== 16) {
    throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_workspace_leases missing column authority: expected exactly 16 columns (found ${leaseColumns.length})`);
  }

  const expectedLeaseColumns: Record<string, { type: string; notnull: number; pk: number }> = {
    id: { type: 'TEXT', notnull: 0, pk: 1 },
    adjudication_id: { type: 'TEXT', notnull: 1, pk: 0 },
    worktree_identity_hash: { type: 'TEXT', notnull: 1, pk: 0 },
    admitted_workspace_fingerprint_hash: { type: 'TEXT', notnull: 1, pk: 0 },
    pre_execution_fingerprint_hash: { type: 'TEXT', notnull: 0, pk: 0 },
    claim_nonce: { type: 'TEXT', notnull: 1, pk: 0 },
    execution_id: { type: 'TEXT', notnull: 1, pk: 0 },
    lease_owner_identity: { type: 'TEXT', notnull: 1, pk: 0 },
    assignment_id: { type: 'TEXT', notnull: 1, pk: 0 },
    authorization_id: { type: 'TEXT', notnull: 1, pk: 0 },
    acquired_at: { type: 'TEXT', notnull: 1, pk: 0 },
    released_at: { type: 'TEXT', notnull: 0, pk: 0 },
    lifecycle_version: { type: 'INTEGER', notnull: 1, pk: 0 },
    state: { type: 'TEXT', notnull: 1, pk: 0 },
    failure_code: { type: 'TEXT', notnull: 0, pk: 0 },
    failure_evidence_hash: { type: 'TEXT', notnull: 0, pk: 0 },
  };

  for (const [colName, expected] of Object.entries(expectedLeaseColumns)) {
    const col = leaseColumns.find((c) => c.name === colName);
    if (!col) {
      throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_workspace_leases missing column "${colName}"`);
    }
    if (col.type !== expected.type || col.notnull !== expected.notnull || col.pk !== expected.pk) {
      throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_workspace_leases column "${colName}" attributes mismatch`);
    }
  }

  // 8. FKs on coder_submission_workspace_leases: exactly 3 foreign keys
  const leaseFks = db.prepare("PRAGMA foreign_key_list(coder_submission_workspace_leases)").all() as {
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }[];
  if (leaseFks.length !== 3) {
    throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_workspace_leases must contain exactly 3 foreign keys (found ${leaseFks.length})`);
  }

  // 9. Indexes on coder_submission_workspace_leases: exactly 3 indexes
  const leaseIdxs = db.prepare("PRAGMA index_list(coder_submission_workspace_leases)").all() as {
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  const activeLeaseIdx = leaseIdxs.find((i) => i.name === 'idx_coder_submission_workspace_leases_active');
  if (!activeLeaseIdx || activeLeaseIdx.unique !== 1 || activeLeaseIdx.partial !== 1) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Partial unique index idx_coder_submission_workspace_leases_active missing or invalid');
  }

  // 10. Triggers on coder_submission_workspace_leases
  const leaseTriggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coder_submission_workspace_leases'").all() as { name: string }[];
  const expectedLeaseTriggers = new Set([
    'trg_coder_submission_workspace_leases_no_delete',
    'trg_coder_submission_workspace_leases_immutable',
  ]);
  if (leaseTriggers.length !== expectedLeaseTriggers.size || leaseTriggers.some((t) => !expectedLeaseTriggers.has(t.name))) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Triggers on coder_submission_workspace_leases mismatch expected authority');
  }

  // 11. Columns on coder_submission_adjudication_events: exactly 7 columns
  const evColumns = db.prepare("PRAGMA table_info(coder_submission_adjudication_events)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (evColumns.length !== 7) {
    throw new Error(`[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Table coder_submission_adjudication_events missing column authority: expected exactly 7 columns (found ${evColumns.length})`);
  }

  // 12. Triggers on coder_submission_adjudication_events
  const evTriggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'coder_submission_adjudication_events'").all() as { name: string }[];
  const expectedEvTriggers = new Set([
    'trg_coder_submission_adjudication_events_no_update',
    'trg_coder_submission_adjudication_events_no_delete',
  ]);
  if (evTriggers.length !== expectedEvTriggers.size || evTriggers.some((t) => !expectedEvTriggers.has(t.name))) {
    throw new Error('[ADJUDICATION_SCHEMA_AUTHORITY_INVALID] Triggers on coder_submission_adjudication_events mismatch expected authority');
  }
}

export function verifyMigration24SchemaAuthority(db: Database.Database): void {
  // 1. Exact ledger entry
  const v24Row = db
    .prepare("SELECT version, name FROM schema_migrations WHERE version = 24 AND name = '024_r5j_reviewer_session_authority'")
    .get() as { version: number; name: string } | undefined;
  if (!v24Row) {
    throw new Error('[REVIEWER_SCHEMA_AUTHORITY_INVALID] Database is missing Migration 24 ledger authority (024_r5j_reviewer_session_authority)');
  }

  // 2. Table existence
  const revTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_reviewer_sessions'").get();
  if (!revTable) {
    throw new Error('[REVIEWER_SCHEMA_AUTHORITY_INVALID] Table mcp_reviewer_sessions is missing');
  }

  // 3. Columns: exactly 19 columns
  const revColumns = db.prepare("PRAGMA table_info(mcp_reviewer_sessions)").all() as {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
    pk: number;
  }[];
  if (revColumns.length !== 19) {
    throw new Error(`[REVIEWER_SCHEMA_AUTHORITY_INVALID] Table mcp_reviewer_sessions missing column authority: expected exactly 19 columns (found ${revColumns.length})`);
  }

  const expectedCols = new Set([
    'id', 'adjudication_id', 'submission_id', 'reviewer_agent_id', 'reviewer_provider_id',
    'reviewer_account_id', 'reviewer_resource_id', 'scope', 'token_hash', 'task_ownership_epoch',
    'authority_snapshot_hash', 'verification_result_envelope_hash', 'projection_schema',
    'projection_hash', 'projection_json', 'issued_at', 'expires_at', 'revoked_at', 'revocation_reason'
  ]);
  for (const c of revColumns) {
    if (!expectedCols.has(c.name)) {
      throw new Error(`[REVIEWER_SCHEMA_AUTHORITY_INVALID] Unexpected column in mcp_reviewer_sessions: ${c.name}`);
    }
  }

  // 4. Foreign keys: exactly 6
  const fks = db.prepare("PRAGMA foreign_key_list(mcp_reviewer_sessions)").all() as {
    id: number;
    seq: number;
    table: string;
    from: string;
    to: string;
    on_update: string;
    on_delete: string;
  }[];
  if (fks.length !== 6) {
    throw new Error(`[REVIEWER_SCHEMA_AUTHORITY_INVALID] Table mcp_reviewer_sessions expected 6 foreign keys, found ${fks.length}`);
  }
  const expectedFkTables = new Set([
    'provider_resources', 'provider_accounts', 'providers', 'agents', 'coder_submissions', 'coder_submission_adjudications'
  ]);
  for (const fk of fks) {
    if (!expectedFkTables.has(fk.table) || fk.on_delete !== 'RESTRICT') {
      throw new Error(`[REVIEWER_SCHEMA_AUTHORITY_INVALID] Invalid foreign key in mcp_reviewer_sessions: table=${fk.table}, on_delete=${fk.on_delete}`);
    }
  }

  // 5. Indexes: exactly 4 named user indexes
  const idxs = db.prepare("PRAGMA index_list(mcp_reviewer_sessions)").all() as {
    seq: number;
    name: string;
    unique: number;
    origin: string;
    partial: number;
  }[];
  const userIdxs = idxs.filter((i) => !i.name.startsWith('sqlite_autoindex_'));
  if (userIdxs.length !== 4) {
    throw new Error(`[REVIEWER_SCHEMA_AUTHORITY_INVALID] Table mcp_reviewer_sessions expected 4 user indexes, found ${userIdxs.length}`);
  }
  const expectedIndexes = new Set([
    'idx_mcp_reviewer_sessions_token_hash',
    'idx_mcp_reviewer_sessions_active_adjudication_reviewer',
    'idx_mcp_reviewer_sessions_expires_at',
    'idx_mcp_reviewer_sessions_reviewer_agent'
  ]);
  for (const idx of userIdxs) {
    if (!expectedIndexes.has(idx.name)) {
      throw new Error(`[REVIEWER_SCHEMA_AUTHORITY_INVALID] Unexpected index on mcp_reviewer_sessions: ${idx.name}`);
    }
  }

  // 6. Triggers: exactly 3 triggers
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'mcp_reviewer_sessions'").all() as { name: string }[];
  if (triggers.length !== 3) {
    throw new Error(`[REVIEWER_SCHEMA_AUTHORITY_INVALID] Table mcp_reviewer_sessions expected 3 triggers, found ${triggers.length}`);
  }
  const expectedTriggers = new Set([
    'trg_mcp_reviewer_sessions_no_delete',
    'trg_mcp_reviewer_sessions_immutable_update',
    'trg_mcp_reviewer_sessions_insert_fencing'
  ]);
  for (const trg of triggers) {
    if (!expectedTriggers.has(trg.name)) {
      throw new Error(`[REVIEWER_SCHEMA_AUTHORITY_INVALID] Unexpected trigger on mcp_reviewer_sessions: ${trg.name}`);
    }
  }
}

export class MigrationRunner {
  public static run(db: Database.Database, maxVersion?: number): void {
    const limit = maxVersion ?? MIGRATIONS.length;

    // 1. Ensure migrations ledger exists
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as { version: number }[];
    const appliedVersions = new Set(appliedRows.map((r) => r.version));

    for (const migration of MIGRATIONS) {
      if (migration.version > limit) {
        break;
      }
      if (!appliedVersions.has(migration.version)) {
        console.log(`[Migrations] Applying migration ${migration.version}: ${migration.name}...`);

        if (migration.foreignKeyMode === 'DISABLED_FOR_REBUILD') {
          // Explicit rebuild mode: Capture original FK state and disable FKs BEFORE beginning transaction
          const originalFkState = db.pragma('foreign_keys', { simple: true }) as number;
          db.pragma('foreign_keys = OFF');
          const disabledFkState = db.pragma('foreign_keys', { simple: true }) as number;
          if (disabledFkState !== 0) {
            throw new Error(`[Migrations] Failed to disable foreign keys before migration ${migration.version}`);
          }

          try {
            const runTx = db.transaction(() => {
              migration.up(db);

              // Validate foreign keys before commit
              const fkViolations = db.pragma('foreign_key_check') as unknown[];
              if (fkViolations.length > 0) {
                throw new Error(
                  `[Migrations] Foreign key integrity check failed inside migration ${migration.version} with ${fkViolations.length} violation(s): ${JSON.stringify(fkViolations)}`
                );
              }

              db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
                migration.version,
                migration.name,
                new Date().toISOString()
              );
            });
            runTx();
          } finally {
            // Restore original foreign keys state
            db.pragma(`foreign_keys = ${originalFkState === 1 ? 'ON' : 'OFF'}`);
            const restoredFkState = db.pragma('foreign_keys', { simple: true }) as number;
            if (restoredFkState !== originalFkState) {
              throw new Error(
                `[Migrations] Failed to restore foreign_keys pragma state after migration ${migration.version}. Expected ${originalFkState}, got ${restoredFkState}`
              );
            }
          }

          // Final post-migration foreign key verification when restored ON
          if (originalFkState === 1) {
            const postFkViolations = db.pragma('foreign_key_check') as unknown[];
            if (postFkViolations.length > 0) {
              throw new Error(
                `[Migrations] Post-migration foreign key check failed after migration ${migration.version} with ${postFkViolations.length} violation(s)`
              );
            }
          }
        } else {
          // Standard migration mode: FK enforcement remains completely untouched (ON by default)
          const runTx = db.transaction(() => {
            migration.up(db);
            db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
              migration.version,
              migration.name,
              new Date().toISOString()
            );
          });
          runTx();
        }

        console.log(`[Migrations] Successfully applied migration ${migration.version}`);
      }
    }
  }
}
