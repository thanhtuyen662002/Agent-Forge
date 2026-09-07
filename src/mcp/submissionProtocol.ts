import crypto from 'crypto';
import { z } from 'zod';

/**
 * Authoritative regex and domain constants for R5J4 Durable Coder Submission Authority.
 */
export const SUBMISSION_TOKEN_REGEX = /^af-sub-[A-Za-z0-9_-]{43}$/;
export const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HEX_40_REGEX = /^[0-9a-f]{40}$/;
export const HEX_64_REGEX = /^[0-9a-f]{64}$/;

/**
 * Portable relative forward-slash path regex.
 * Rejects leading/trailing slashes, empty segments, backslashes, drive letters, UNC,
 * and rejects dot segments ('.' or '..') at any path depth.
 */
export const PORTABLE_PATH_REGEX =
  /^(?!.*\/\.\.(?:\/|$))(?!.*\/\.(?:\/|$))(?!^\.\.(?:\/|$))(?!^\.(?:\/|$))^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/;

export const MAX_ARGUMENT_BYTES = 65536;

/**
 * Exactly 7 sorted keys committed by claim_content_hash.
 */
export const CLAIM_CONTENT_KEYS = [
  'blockers',
  'changed_files',
  'client_metadata',
  'review_requested',
  'status',
  'summary',
  'tests_claimed',
] as const;

/**
 * Exactly 19 sorted keys committed by authority_fingerprint.
 */
export const AUTHORITY_FINGERPRINT_KEYS = [
  'assignment_id',
  'attempt_id',
  'authorization_id',
  'authorization_status',
  'base_sha',
  'dispatched_at',
  'execution_id',
  'lifecycle_version',
  'manager_message_id',
  'manager_payload_hash',
  'project_id',
  'repository_head_sha',
  'routing_decision_id',
  'selected_account_id',
  'selected_provider_id',
  'selected_resource_id',
  'task_id',
  'task_ownership_epoch',
  'task_revision',
] as const;

/**
 * Exactly 28 sorted keys committed by canonical_envelope_hash (Authoritative Section 2.1).
 */
export const CANONICAL_ENVELOPE_KEYS = [
  'assignment_id',
  'attempt_id',
  'authority_fingerprint',
  'authorization_id',
  'authorization_status',
  'authorized_head_sha',
  'base_sha',
  'canonical_arguments_bytes',
  'claim_content_hash',
  'claimed_status',
  'dispatched_at',
  'execution_id',
  'lifecycle_version',
  'manager_message_id',
  'manager_payload_hash',
  'project_id',
  'quarantine_status',
  'routing_decision_id',
  'schema_version',
  'selected_account_id',
  'selected_provider_id',
  'selected_resource_id',
  'session_id',
  'submission_id',
  'submitted_at',
  'task_id',
  'task_ownership_epoch',
  'task_revision',
] as const;

/**
 * Authoritative error code domain for coder submission authority.
 * Note: MCP_SESSION_SCOPE_UNAUTHORIZED is removed per Section 2.4.
 */
export const SUBMISSION_ERROR_CODES = [
  'CLAIM_ARGUMENTS_TOO_LARGE',
  'INVALID_SUBMISSION_TOKEN',
  'MCP_SESSION_EXPIRED',
  'MCP_SESSION_REVOKED',
  'MCP_AUTHORITY_FENCED',
  'SCHEMA_VALIDATION_FAILED',
  'SUBMISSION_ID_COLLISION_CONTENT_MISMATCH',
  'SUBMISSION_INTEGRITY_CONFLICT',
  'CODER_SUBMISSION_EVENT_CONFLICT',
  'REPOSITORY_HEAD_DRIFT_DETECTED',
  'DATABASE_BUSY',
  'INTERNAL_SUBMISSION_ERROR',
] as const;

export type SubmissionErrorCode = (typeof SUBMISSION_ERROR_CODES)[number];

export type SubmissionResult =
  | {
      accepted: true;
      submission_id: string;
      quarantine_status: 'QUARANTINED';
      claim_content_hash: string;
      canonical_envelope_hash: string;
      submitted_at: string;
      is_duplicate: boolean;
    }
  | {
      accepted: false;
      error_code: SubmissionErrorCode;
      message: string;
      retryable: boolean;
    };

/**
 * Generates an unpadded base64url-encoded 32-byte submission token.
 * Output format: ^af-sub-[A-Za-z0-9_-]{43}$
 */
export function generateSubmissionToken(): string {
  const bytes = crypto.randomBytes(32);
  const raw = bytes.toString('base64url');
  return `af-sub-${raw}`;
}

export function validateSubmissionToken(token: string): boolean {
  if (typeof token !== 'string') return false;
  return SUBMISSION_TOKEN_REGEX.test(token);
}

export function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').toLowerCase();
}

/**
 * Validates whether a given string is a portable forward-slash relative path.
 * Enforces:
 * - No leading or trailing slash
 * - Total length <= 512, segment length <= 128
 * - No empty segments (//)
 * - No dot segments ('.' or '..')
 * - No backslashes, drive letters, UNC paths, control characters, or NUL bytes
 * - Portable segment character set [a-zA-Z0-9_.-]+
 */
export function isPortablePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 512) {
    return false;
  }
  if (/[\\]|[\x00-\x1f\x7f]|^[a-zA-Z]:/.test(p)) {
    return false;
  }
  if (p.startsWith('/') || p.endsWith('/')) {
    return false;
  }
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg.length === 0 || seg.length > 128) {
      return false;
    }
    if (seg === '.' || seg === '..') {
      return false;
    }
    if (!/^[a-zA-Z0-9_.-]+$/.test(seg)) {
      return false;
    }
  }
  return true;
}

/**
 * Strict canonical JSON stringify using recursive lexicographical code-unit key sorting.
 * Rejects undefined, functions, symbols, NaN, and Infinity to guarantee RFC-conformant JSON.
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null) {
    return 'null';
  }
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) {
      throw new TypeError('[CANONICAL_JSON_ERROR] Non-finite numbers (NaN/Infinity) are forbidden');
    }
    return JSON.stringify(obj);
  }
  if (typeof obj === 'string' || typeof obj === 'boolean') {
    return JSON.stringify(obj);
  }
  if (typeof obj !== 'object') {
    throw new TypeError(`[CANONICAL_JSON_ERROR] Unsupported type: ${typeof obj}`);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map((item) => canonicalJsonStringify(item)).join(',') + ']';
  }

  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const pairs = keys.map((k) => {
    const val = record[k];
    if (val === undefined) {
      throw new TypeError(`[CANONICAL_JSON_ERROR] Undefined value at key: ${k}`);
    }
    return JSON.stringify(k) + ':' + canonicalJsonStringify(val);
  });
  return '{' + pairs.join(',') + '}';
}

/**
 * Derives deterministic event ID per Section 2.5:
 * evt-coder-${sha256(`agentforge:coder-submission:v1:${submissionId}`).slice(0, 32)}
 */
export function deriveDeterministicEventId(submissionId: string): string {
  const digest = computeSha256(`agentforge:coder-submission:v1:${submissionId}`);
  return `evt-coder-${digest.slice(0, 32)}`;
}

/**
 * Strict Client Metadata Schema.
 */
export const ClosedClientMetadataSchema = z
  .object({
    client_name: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^(?!\s*$).+/, 'client_name cannot be whitespace-only')
      .optional(),
    client_version: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^(?!\s*$).+/, 'client_version cannot be whitespace-only')
      .optional(),
    client_session_mode: z.enum(['GUI_EXTERNAL', 'CLI_EXTERNAL', 'SUBAGENT_CODER']).optional(),
  })
  .strict();

export type ClosedClientMetadata = z.infer<typeof ClosedClientMetadataSchema>;

/**
 * Strict Zod Input Schema for coder submission tool arguments.
 * Rejects unknown keys, token, evidence_hash, and server-generated hashes.
 * Requires uniqueItems across all arrays.
 */
export const CoderSubmissionInputZodSchema = z
  .object({
    submission_id: z
      .string()
      .trim()
      .regex(UUID_V4_REGEX, 'Must be RFC 4122 UUID v4 in lowercase'),
    authorization_id: z
      .string()
      .trim()
      .regex(UUID_V4_REGEX, 'Must be RFC 4122 UUID v4 in lowercase')
      .optional(),
    project_id: z.string().trim().min(1).max(128).optional(),
    task_id: z.string().trim().min(1).max(128).optional(),
    task_ownership_epoch: z.number().int().positive('Ownership epoch must be a positive integer').optional(),
    base_sha: z
      .string()
      .trim()
      .regex(HEX_40_REGEX, 'Base SHA must be 40 lowercase hex characters')
      .optional(),
    repository_head_sha: z
      .string()
      .trim()
      .regex(HEX_40_REGEX, 'Repository head SHA must be 40 lowercase hex characters')
      .optional(),
    status: z.enum(['COMPLETED', 'IN_PROGRESS', 'BLOCKED', 'FAILED']),
    summary: z
      .string()
      .trim()
      .min(1, 'Summary cannot be empty')
      .max(4096, 'Summary max length is 4096 characters')
      .regex(/^(?!\s*$).+/, 'Summary cannot be whitespace-only'),
    changed_files: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(512)
          .regex(PORTABLE_PATH_REGEX, 'Must be portable forward-slash relative path without traversal')
          .refine((p) => isPortablePath(p), 'Must be portable relative path without dot segments')
      )
      .max(1000)
      .default([])
      .refine((items) => new Set(items).size === items.length, {
        message: 'changed_files array elements must be unique',
      }),
    tests_claimed: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(256)
          .regex(/^(?!\s*$).+/, 'Test name cannot be whitespace-only')
      )
      .max(1000)
      .default([])
      .refine((items) => new Set(items).size === items.length, {
        message: 'tests_claimed array elements must be unique',
      }),
    blockers: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(512)
          .regex(/^(?!\s*$).+/, 'Blocker description cannot be whitespace-only')
      )
      .max(1000)
      .default([])
      .refine((items) => new Set(items).size === items.length, {
        message: 'blockers array elements must be unique',
      }),
    review_requested: z.boolean().default(true),
    client_metadata: ClosedClientMetadataSchema.default({}),
  })
  .strict();

export type CoderSubmissionInput = z.infer<typeof CoderSubmissionInputZodSchema>;

/**
 * Exported JSON Schema equivalent for MCP tool argument definition.
 */
export const CODER_SUBMISSION_INPUT_JSON_SCHEMA = {
  type: 'object',
  required: ['submission_id', 'status', 'summary'],
  properties: {
    submission_id: {
      type: 'string',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      description: 'Client-generated RFC 4122 UUID v4 in lowercase',
    },
    authorization_id: {
      type: 'string',
      pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
      description: 'Optional execution authorization UUID',
    },
    project_id: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Optional project identifier',
    },
    task_id: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      description: 'Optional task identifier',
    },
    task_ownership_epoch: {
      type: 'integer',
      minimum: 1,
      description: 'Optional task ownership epoch',
    },
    base_sha: {
      type: 'string',
      pattern: '^[0-9a-f]{40}$',
      description: 'Optional base git SHA (40 lowercase hex)',
    },
    repository_head_sha: {
      type: 'string',
      pattern: '^[0-9a-f]{40}$',
      description: 'Optional repository head git SHA (40 lowercase hex)',
    },
    status: {
      type: 'string',
      enum: ['COMPLETED', 'IN_PROGRESS', 'BLOCKED', 'FAILED'],
      description: 'Coder execution status',
    },
    summary: {
      type: 'string',
      minLength: 1,
      maxLength: 4096,
      pattern: '^(?!\\s*$).+',
      description: 'Non-whitespace summary up to 4096 characters',
    },
    changed_files: {
      type: 'array',
      items: {
        type: 'string',
        maxLength: 512,
        pattern: '^(?!.*\\/\\.\\.(?:\\/|$))(?!.*\\/\\.(?:\\/|$))(?!^\\.\\.(?:\\/|$))(?!^\\.(?:\\/|$))^[a-zA-Z0-9_.-]+(?:\\/[a-zA-Z0-9_.-]+)*$',
      },
      maxItems: 1000,
      uniqueItems: true,
      default: [],
    },
    tests_claimed: {
      type: 'array',
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 256,
        pattern: '^(?!\\s*$).+',
      },
      maxItems: 1000,
      uniqueItems: true,
      default: [],
    },
    blockers: {
      type: 'array',
      items: {
        type: 'string',
        minLength: 1,
        maxLength: 512,
        pattern: '^(?!\\s*$).+',
      },
      maxItems: 1000,
      uniqueItems: true,
      default: [],
    },
    review_requested: {
      type: 'boolean',
      default: true,
    },
    client_metadata: {
      type: 'object',
      properties: {
        client_name: { type: 'string', minLength: 1, maxLength: 64, pattern: '^(?!\\s*$).+' },
        client_version: { type: 'string', minLength: 1, maxLength: 64, pattern: '^(?!\\s*$).+' },
        client_session_mode: { type: 'string', enum: ['GUI_EXTERNAL', 'CLI_EXTERNAL', 'SUBAGENT_CODER'] },
      },
      additionalProperties: false,
      default: {},
    },
  },
  additionalProperties: false,
} as const;

/**
 * Exported Discriminated JSON Schema for MCP tool output definition.
 */
export const CODER_SUBMISSION_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      required: [
        'accepted',
        'submission_id',
        'quarantine_status',
        'claim_content_hash',
        'canonical_envelope_hash',
        'submitted_at',
        'is_duplicate',
      ],
      properties: {
        accepted: { const: true },
        submission_id: {
          type: 'string',
          pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
        },
        quarantine_status: {
          const: 'QUARANTINED',
        },
        claim_content_hash: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
        },
        canonical_envelope_hash: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
        },
        submitted_at: {
          type: 'string',
          pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
        },
        is_duplicate: {
          type: 'boolean',
        },
      },
      additionalProperties: false,
    },
    {
      type: 'object',
      required: ['accepted', 'error_code', 'message', 'retryable'],
      properties: {
        accepted: { const: false },
        error_code: {
          type: 'string',
          enum: SUBMISSION_ERROR_CODES,
        },
        message: { type: 'string', minLength: 1 },
        retryable: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  ],
} as const;

/**
 * Structure of the 7-field claim content commitment.
 */
export interface ClaimContentPayload {
  readonly blockers: readonly string[];
  readonly changed_files: readonly string[];
  readonly client_metadata: Readonly<Record<string, unknown>>;
  readonly review_requested: boolean;
  readonly status: string;
  readonly summary: string;
  readonly tests_claimed: readonly string[];
}

/**
 * Computes the 7-key claim content hash.
 * All arrays are normalized by lexicographical code-point sort prior to serialization.
 */
export function computeClaimContentHash(content: {
  blockers?: readonly string[];
  changed_files?: readonly string[];
  client_metadata?: Record<string, unknown>;
  review_requested?: boolean;
  status: string;
  summary: string;
  tests_claimed?: readonly string[];
}): { hash: string; canonicalJson: string; normalizedContent: ClaimContentPayload } {
  const normalizedContent: ClaimContentPayload = {
    blockers: [...(content.blockers ?? [])].sort(),
    changed_files: [...(content.changed_files ?? [])].sort(),
    client_metadata: content.client_metadata ? { ...content.client_metadata } : {},
    review_requested: content.review_requested ?? true,
    status: content.status,
    summary: content.summary,
    tests_claimed: [...(content.tests_claimed ?? [])].sort(),
  };

  const canonicalJson = canonicalJsonStringify(normalizedContent);
  const hash = computeSha256(canonicalJson);
  return { hash, canonicalJson, normalizedContent };
}

/**
 * Structure of the 19-field authority fingerprint commitment.
 */
export interface AuthorityFingerprintPayload {
  readonly assignment_id: string | null;
  readonly attempt_id: string | null;
  readonly authorization_id: string;
  readonly authorization_status: string;
  readonly base_sha: string;
  readonly dispatched_at: string;
  readonly execution_id: string | null;
  readonly lifecycle_version: number | null;
  readonly manager_message_id: string;
  readonly manager_payload_hash: string;
  readonly project_id: string;
  readonly repository_head_sha: string;
  readonly routing_decision_id: string;
  readonly selected_account_id: string | null;
  readonly selected_provider_id: string;
  readonly selected_resource_id: string;
  readonly task_id: string;
  readonly task_ownership_epoch: number;
  readonly task_revision: number;
}

/**
 * Computes authority fingerprint across all 19 fields.
 */
export function computeAuthorityFingerprint(payload: AuthorityFingerprintPayload): string {
  const ordered: Record<string, unknown> = {};
  for (const k of AUTHORITY_FINGERPRINT_KEYS) {
    ordered[k] = (payload as unknown as Record<string, unknown>)[k] ?? null;
  }
  const canonicalJson = canonicalJsonStringify(ordered);
  return computeSha256(canonicalJson);
}

/**
 * Structure of the 28-key canonical envelope commitment (Authoritative Section 2.1).
 */
export interface CanonicalEnvelopePayload {
  readonly assignment_id: string | null;
  readonly attempt_id: string | null;
  readonly authority_fingerprint: string;
  readonly authorization_id: string;
  readonly authorization_status: string;
  readonly authorized_head_sha: string;
  readonly base_sha: string;
  readonly canonical_arguments_bytes: number;
  readonly claim_content_hash: string;
  readonly claimed_status: string;
  readonly dispatched_at: string;
  readonly execution_id: string | null;
  readonly lifecycle_version: number | null;
  readonly manager_message_id: string;
  readonly manager_payload_hash: string;
  readonly project_id: string;
  readonly quarantine_status: 'QUARANTINED';
  readonly routing_decision_id: string;
  readonly schema_version: number;
  readonly selected_account_id: string | null;
  readonly selected_provider_id: string;
  readonly selected_resource_id: string;
  readonly session_id: string;
  readonly submission_id: string;
  readonly submitted_at: string;
  readonly task_id: string;
  readonly task_ownership_epoch: number;
  readonly task_revision: number;
}

/**
 * Computes canonical envelope hash across exactly 28 keys.
 */
export function computeCanonicalEnvelope(payload: CanonicalEnvelopePayload): {
  hash: string;
  canonicalJson: string;
  orderedEnvelope: Record<string, unknown>;
} {
  const orderedEnvelope: Record<string, unknown> = {};
  for (const k of CANONICAL_ENVELOPE_KEYS) {
    orderedEnvelope[k] = (payload as unknown as Record<string, unknown>)[k] ?? null;
  }
  const canonicalJson = canonicalJsonStringify(orderedEnvelope);
  const hash = computeSha256(canonicalJson);
  return { hash, canonicalJson, orderedEnvelope };
}

/**
 * Exported frozen capability metadata constant (used by tests and documentation only per Section 5.3).
 */
export const CODER_SUBMISSION_CAPABILITY_METADATA = Object.freeze({
  server_name: 'agentforge-submit',
  protocol_version: '2024-11-05',
  tool_name: 'agentforge_submit_coder_claim',
  credential_scope: 'CODER_SUBMISSION',
  envelope_keys_count: 28,
  content_keys_count: 7,
  fingerprint_keys_count: 19,
  max_argument_bytes: MAX_ARGUMENT_BYTES,
  quarantine_status: 'QUARANTINED',
});
