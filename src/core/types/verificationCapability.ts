import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const boundedText = z.string().min(1).max(4096).refine((value) => !/[\u0000-\u001f\u007f]/.test(value));
export const VerificationCapabilityReferenceSchema = z.object({
  id: z.string().min(1).max(128),
  version: z.number().int().positive().safe(),
  owner_principal: digest,
  payload_hash: digest,
}).strict();
export type VerificationCapabilityReference = z.infer<typeof VerificationCapabilityReferenceSchema>;

export const VerificationFileBindingSchema = z.object({
  path: boundedText,
  identity: z.string().min(1).max(256),
  sha256: digest,
}).strict();
export const VerificationCapabilityPayloadSchema = z.object({
  project_id: z.string().min(1).max(200),
  owner_principal: digest,
  project_root: boundedText,
  project_root_identity: z.string().min(1).max(256),
  executable: VerificationFileBindingSchema,
  args: z.array(z.string().max(4096).refine((value) => !/[\u0000-\u001f\u007f]/.test(value))).max(128)
    .refine((args) => args.reduce((bytes, value) => bytes + Buffer.byteLength(value, 'utf8'), 0) <= 16384),
  scripts: z.array(z.object({
    argument_index: z.number().int().nonnegative(),
    relative_path: boundedText,
    binding: VerificationFileBindingSchema,
  }).strict()).max(16),
}).strict();
export type VerificationCapabilityPayload = z.infer<typeof VerificationCapabilityPayloadSchema>;

export interface VerificationCapabilityRecord {
  id: string;
  project_id: string;
  owner_principal: string;
  version: number;
  state: 'ACTIVE' | 'REVOKED';
  payload_json: string;
  payload_hash: string;
  approval_id: string;
  approval_json: string;
  created_at: string;
  revoked_at: string | null;
}

export type VerificationCapabilityFailureCode =
  | 'OWNER_APPROVAL_REQUIRED' | 'OWNER_IDENTITY_UNAVAILABLE' | 'CAPABILITY_NOT_FOUND'
  | 'CAPABILITY_REVOKED' | 'CAPABILITY_VERSION_MISMATCH' | 'CAPABILITY_OWNER_MISMATCH'
  | 'CAPABILITY_BINDING_MISMATCH' | 'CAPABILITY_PATH_ESCAPE' | 'PATH_IDENTITY_CHANGED'
  | 'CONTENT_HASH_CHANGED' | 'INVALID_VERIFICATION_CAPABILITY';

export class VerificationCapabilityError extends Error {
  constructor(public readonly code: VerificationCapabilityFailureCode) {
    super(code);
    this.name = 'VerificationCapabilityError';
  }
}

/** Backend-only process boundary. Structured IPC cannot supply its closure. */
export interface VerificationProcessBoundary {
  readonly environment: Readonly<Record<string, string>>;
  readonly assertInvocation: (executable: string, args: string[], cwd: string) => void;
}
const issuedProcessBoundaries = new WeakSet<object>();

export function issueVerificationProcessBoundary(environment: Record<string, string>,
  assertInvocation: VerificationProcessBoundary['assertInvocation']): VerificationProcessBoundary {
  const boundary = Object.freeze({ environment: Object.freeze({ ...environment }), assertInvocation });
  issuedProcessBoundaries.add(boundary);
  return boundary;
}

export function isIssuedVerificationProcessBoundary(value: unknown): value is VerificationProcessBoundary {
  return typeof value === 'object' && value !== null && issuedProcessBoundaries.has(value);
}
