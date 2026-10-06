import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Repository } from '../database/repositories';
import { canonicalJsonStringify } from '../context/ContextIntegrity';
import { PolicyService } from './PolicyService';
import { resolveTrustedExecutable } from './ExecutableResolver';
import {
  VerificationCapabilityError, VerificationCapabilityPayload, VerificationCapabilityPayloadSchema,
  VerificationCapabilityRecord, VerificationCapabilityReference, VerificationCapabilityReferenceSchema,
  VerificationFileBindingSchema,
} from '../types/verificationCapability';

const sha256 = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const samePath = (left: string, right: string) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

let cachedOwnerPrincipal: string | undefined;
/** The authenticated host account is independent of provider/profile identities. */
export function getVerificationOwnerPrincipal(): string {
  if (cachedOwnerPrincipal) return cachedOwnerPrincipal;
  try {
    const user = os.userInfo();
    let identity = String(user.uid);
    if (process.platform === 'win32') {
      const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
      const result = execFileSync(executable, ['/user', '/fo', 'csv', '/nh'], {
        encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8192,
        env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' },
      });
      const sid = result.match(/S-1-\d+(?:-\d+)+/);
      if (!sid) throw new Error('missing SID');
      identity = sid[0];
    }
    cachedOwnerPrincipal = sha256(canonicalJsonStringify({ platform: process.platform, host: os.hostname(), identity, username: user.username }));
    return cachedOwnerPrincipal;
  } catch {
    throw new VerificationCapabilityError('OWNER_IDENTITY_UNAVAILABLE');
  }
}

function fileIdentity(stat: fs.BigIntStats, pathComparison = false): string {
  // On Windows lstat may report dev=0 while fstat reports the real volume.
  // Compare cross-API file IDs separately; retain the full descriptor volume
  // in approved file bindings and in the before/after descriptor fence.
  const device = process.platform === 'win32' && pathComparison ? 0n : stat.dev;
  return `${device}:${stat.ino}:${stat.birthtimeNs}`;
}

/** Reject aliases before opening, then retain descriptor identity while hashing. */
function canonicalPath(candidate: string, directory: boolean): { path: string; identity: string } {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || candidate.length > 4096 || /[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
  }
  const resolved = path.resolve(candidate);
  let cursor = path.parse(resolved).root;
  for (const component of path.relative(cursor, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    const stat = fs.lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink()) throw new VerificationCapabilityError('PATH_IDENTITY_CHANGED');
  }
  const canonical = fs.realpathSync.native(resolved);
  const stat = fs.lstatSync(canonical, { bigint: true });
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) {
    throw new VerificationCapabilityError('PATH_IDENTITY_CHANGED');
  }
  return { path: canonical, identity: fileIdentity(stat, true) };
}

function bindFile(candidate: string) {
  const initial = canonicalPath(candidate, false);
  const descriptor = fs.openSync(initial.path, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW));
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (fileIdentity(before, true) !== initial.identity || before.size > 256n * 1024n * 1024n) {
      throw new VerificationCapabilityError('PATH_IDENTITY_CHANGED');
    }
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < Number(before.size)) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (!count) throw new VerificationCapabilityError('CONTENT_HASH_CHANGED');
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = canonicalPath(initial.path, false);
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        current.identity !== initial.identity || fileIdentity(after) !== fileIdentity(before)) {
      throw new VerificationCapabilityError('CONTENT_HASH_CHANGED');
    }
    return VerificationFileBindingSchema.parse({ path: initial.path, identity: fileIdentity(before), sha256: digest.digest('hex') });
  } finally { fs.closeSync(descriptor); }
}

export type ConfirmVerificationOwner = (proposal: Readonly<VerificationCapabilityPayload>) => Promise<boolean>;

export class VerificationCapabilityService {
  constructor(private readonly repo: Repository, private readonly ownerPrincipal = getVerificationOwnerPrincipal) {}

  public propose(projectId: string, executable: string, args: string[], projectRoot: string): VerificationCapabilityPayload {
    try {
      const candidate = PolicyService.classifyVerificationCommandCandidate(executable, args, false);
      if (candidate.decision === 'DENY') throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
      const root = canonicalPath(projectRoot, true);
      const project = this.repo.getProject(projectId);
      if (!project || !samePath(canonicalPath(project.repository_path, true).path, root.path)) {
        throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
      }
      const resolved = resolveTrustedExecutable(executable, 'generic', { allowExplicitAbsolute: true });
      if (!resolved) throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
      // Installation aliases such as NVM are resolved before owner approval;
      // execution receives the physical identity displayed in that approval.
      const canonicalExecutable = fs.realpathSync.native(resolved);
      const scripts: VerificationCapabilityPayload['scripts'] = [];
      const base = path.basename(resolved).toLowerCase().replace(/\.exe$/, '');
      if (/^(node|python(?:\d+(?:\.\d+)?)?)$/.test(base)) {
        const index = args.findIndex((arg) => !arg.startsWith('-'));
        if (index >= 0) {
          const script = path.resolve(root.path, args[index]);
          const relative = path.relative(root.path, script);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new VerificationCapabilityError('CAPABILITY_PATH_ESCAPE');
          scripts.push({ argument_index: index, relative_path: relative, binding: bindFile(script) });
        }
      }
      return VerificationCapabilityPayloadSchema.parse({
        project_id: projectId, owner_principal: this.ownerPrincipal(), project_root: root.path,
        project_root_identity: root.identity, executable: bindFile(canonicalExecutable), args: [...args], scripts,
      });
    } catch (error) {
      if (error instanceof VerificationCapabilityError) throw error;
      throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
    }
  }

  /** Confirmation is supplied only by the backend native owner surface. */
  public async approve(proposed: VerificationCapabilityPayload, confirmOwner: ConfirmVerificationOwner): Promise<VerificationCapabilityReference> {
    const payload = VerificationCapabilityPayloadSchema.parse(JSON.parse(JSON.stringify(proposed)));
    const payloadJson = canonicalJsonStringify(payload);
    const refreshed = this.propose(payload.project_id, payload.executable.path, payload.args, payload.project_root);
    if (canonicalJsonStringify(refreshed) !== payloadJson) throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
    const display = JSON.parse(payloadJson) as VerificationCapabilityPayload;
    if (!(await confirmOwner(display))) throw new VerificationCapabilityError('OWNER_APPROVAL_REQUIRED');
    if (payload.owner_principal !== this.ownerPrincipal()) throw new VerificationCapabilityError('CAPABILITY_OWNER_MISMATCH');
    this.assertPayloadFiles(payload, payload.project_root, true);
    const currentOwner = this.ownerPrincipal();
    if (payload.owner_principal !== currentOwner) throw new VerificationCapabilityError('CAPABILITY_OWNER_MISMATCH');
    const id = `vcap-${crypto.randomUUID()}`;
    const approvalId = crypto.randomUUID();
    const payloadHash = sha256(payloadJson);
    this.repo.runInImmediateTransaction(() => {
      const project = this.repo.getProject(payload.project_id);
      if (!project || !samePath(project.repository_path, payload.project_root)) throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
      this.repo.getDatabase().prepare(`INSERT INTO verification_capabilities
        (id,project_id,owner_principal,version,state,payload_json,payload_hash,approval_id,approval_json,created_at)
        VALUES (?,?,?,1,'ACTIVE',?,?,?,?,?)`).run(id, payload.project_id, currentOwner, payloadJson, payloadHash, approvalId,
        canonicalJsonStringify({ method: 'OS_AUTHENTICATED_NATIVE_CONFIRMATION', owner_principal: currentOwner, approval_id: approvalId, payload_hash: payloadHash }), new Date().toISOString());
    });
    return { id, version: 1, owner_principal: currentOwner, payload_hash: payloadHash };
  }

  public validate(reference: VerificationCapabilityReference, projectId: string, executable: string, args: string[], runtimeRoot: string,
    authorizedWorktree?: string): VerificationCapabilityPayload {
    const ref = VerificationCapabilityReferenceSchema.safeParse(reference);
    if (!ref.success) throw new VerificationCapabilityError('OWNER_APPROVAL_REQUIRED');
    const row = this.repo.getDatabase().prepare('SELECT * FROM verification_capabilities WHERE id=?').get(ref.data.id) as VerificationCapabilityRecord | undefined;
    if (!row) throw new VerificationCapabilityError('CAPABILITY_NOT_FOUND');
    if (row.state !== 'ACTIVE' || row.revoked_at) throw new VerificationCapabilityError('CAPABILITY_REVOKED');
    if (row.version !== ref.data.version) throw new VerificationCapabilityError('CAPABILITY_VERSION_MISMATCH');
    if (row.owner_principal !== this.ownerPrincipal() || row.owner_principal !== ref.data.owner_principal) throw new VerificationCapabilityError('CAPABILITY_OWNER_MISMATCH');
    const payload = VerificationCapabilityPayloadSchema.parse(JSON.parse(row.payload_json));
    if (row.project_id !== projectId || payload.project_id !== projectId || payload.owner_principal !== row.owner_principal ||
      row.payload_hash !== ref.data.payload_hash || sha256(canonicalJsonStringify(payload)) !== row.payload_hash ||
      !samePath(payload.executable.path, executable) || canonicalJsonStringify(payload.args) !== canonicalJsonStringify(args)) {
      throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
    }
    if (!samePath(runtimeRoot, payload.project_root) && (!authorizedWorktree || !samePath(runtimeRoot, authorizedWorktree))) {
      throw new VerificationCapabilityError('CAPABILITY_PATH_ESCAPE');
    }
    this.assertPayloadFiles(payload, runtimeRoot, samePath(runtimeRoot, payload.project_root));
    return payload;
  }

  public revoke(reference: VerificationCapabilityReference): void {
    const ref = VerificationCapabilityReferenceSchema.parse(reference);
    if (ref.owner_principal !== this.ownerPrincipal()) throw new VerificationCapabilityError('CAPABILITY_OWNER_MISMATCH');
    const result = this.repo.getDatabase().prepare(`UPDATE verification_capabilities SET state='REVOKED', version=version+1, revoked_at=?
      WHERE id=? AND owner_principal=? AND version=? AND state='ACTIVE'`).run(new Date().toISOString(), ref.id, ref.owner_principal, ref.version);
    if (result.changes !== 1) throw new VerificationCapabilityError('CAPABILITY_VERSION_MISMATCH');
  }

  private assertPayloadFiles(payload: VerificationCapabilityPayload, runtimeRoot: string, original: boolean): void {
    const root = canonicalPath(payload.project_root, true);
    if (root.identity !== payload.project_root_identity) throw new VerificationCapabilityError('PATH_IDENTITY_CHANGED');
    const executable = bindFile(payload.executable.path);
    if (executable.identity !== payload.executable.identity) throw new VerificationCapabilityError('PATH_IDENTITY_CHANGED');
    if (executable.sha256 !== payload.executable.sha256) throw new VerificationCapabilityError('CONTENT_HASH_CHANGED');
    const runtime = canonicalPath(runtimeRoot, true);
    for (const script of payload.scripts) {
      const candidate = path.resolve(runtime.path, script.relative_path);
      const relative = path.relative(runtime.path, candidate);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new VerificationCapabilityError('CAPABILITY_PATH_ESCAPE');
      const binding = bindFile(candidate);
      if (original && (!samePath(binding.path, script.binding.path) || binding.identity !== script.binding.identity)) throw new VerificationCapabilityError('PATH_IDENTITY_CHANGED');
      if (binding.sha256 !== script.binding.sha256) throw new VerificationCapabilityError('CONTENT_HASH_CHANGED');
    }
  }
}
