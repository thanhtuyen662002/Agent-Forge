import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Repository } from '../database/repositories';
import { CanonicalExecutionPayload, CanonicalExecutionPayloadSchema, computePayloadHash } from './ExecutionAuthorizationService';
import { canonicalJsonStringify } from '../context/ContextIntegrity';
import { PolicyService } from './PolicyService';
import { isProtectedExecutableName, resolveTrustedExecutable } from './ExecutableResolver';
import { CommandParser } from './CommandParser';
import {
  VerificationCapabilityError, VerificationCapabilityPayload, VerificationCapabilityPayloadSchema,
  VerificationCapabilityRecord, VerificationCapabilityReference, VerificationCapabilityReferenceSchema,
  VerificationFileBindingSchema,
  issueVerificationProcessBoundary, VerificationProcessBoundary,
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
      const root = canonicalPath(projectRoot, true);
      const project = this.repo.getProject(projectId);
      if (!project || !samePath(canonicalPath(project.repository_path, true).path, root.path)) {
        throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
      }
      // A simple npm script can be approved as its direct invocation. npm,
      // lifecycle hooks, shell composition and package execution never run.
      // The owner approves the resulting exact command displayed by the UI;
      // later package.json edits cannot retarget that captured invocation.
      if (/^npm(?:\.cmd|\.exe)?$/i.test(path.basename(executable))) {
        const scriptName = args[0] === 'test' ? 'test' : args[0] === 'run' ? args[1] : undefined;
        const consumed = args[0] === 'test' ? 1 : 2;
        if (!scriptName || !/^[a-zA-Z0-9:_-]{1,100}$/.test(scriptName) ||
            (args.length > consumed && args[consumed] !== '--')) throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
        const manifest = bindFile(path.join(root.path, 'package.json'));
        const bytes = fs.readFileSync(manifest.path);
        if (bytes.length > 1048576 || sha256(bytes) !== manifest.sha256) throw new VerificationCapabilityError('CONTENT_HASH_CHANGED');
        const scripts = JSON.parse(bytes.toString('utf8')).scripts;
        if (!scripts || typeof scripts[scriptName] !== 'string' || scripts[`pre${scriptName}`] || scripts[`post${scriptName}`]) {
          throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
        }
        const direct = CommandParser.parse(scripts[scriptName]);
        if (!direct) throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
        executable = direct.executable;
        args = [...direct.args, ...args.slice(consumed + 1)];
      }
      const candidate = PolicyService.classifyVerificationCommandCandidate(executable, args, false);
      if (candidate.decision === 'DENY') throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
      // Resolve Windows bare names as real executables; never use PATHEXT
      // shell shims or an inherited arbitrary PATH for verification approval.
      const requested = process.platform === 'win32' && !path.extname(executable) ? `${executable}.exe` : executable;
      const resolved = resolveTrustedExecutable(requested, isProtectedExecutableName(requested) ?? 'generic', {
        allowExplicitAbsolute: true, allowExplicitAbsoluteForProtected: true,
      });
      if (!resolved) throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
      // Installation aliases such as NVM are resolved before owner approval;
      // execution receives the physical identity displayed in that approval.
      const canonicalExecutable = fs.realpathSync.native(resolved);
      if (PolicyService.classifyVerificationCommandCandidate(canonicalExecutable, args, false).decision === 'DENY') {
        throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
      }
      const scripts: VerificationCapabilityPayload['scripts'] = [];
      const base = path.basename(canonicalExecutable).toLowerCase().replace(/\.exe$/, '');
      if (/^(node|nodejs|python(?:\d+(?:\.\d+)?)?)$/.test(base)) {
        const index = args.findIndex((arg) => !arg.startsWith('-'));
        const indices = /^(node|nodejs)$/.test(base) && args.includes('--test')
          ? args.map((argument, position) => argument.startsWith('-') ? -1 : position).filter((position) => position >= 0)
          : index >= 0 ? [index] : [];
        if (!indices.length && !(args.length === 1 && ['--version', '-v', '-V', '--help', '-h'].includes(args[0]))) {
          throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
        }
        if (args.includes('-')) throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
        for (const argumentIndex of indices) {
          const script = canonicalPath(path.resolve(root.path, args[argumentIndex]), false).path;
          const relative = path.relative(root.path, script);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new VerificationCapabilityError('CAPABILITY_PATH_ESCAPE');
          scripts.push({ argument_index: argumentIndex, relative_path: relative, binding: bindFile(script) });
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
      if (!project || !samePath(canonicalPath(project.repository_path, true).path, payload.project_root)) throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
      this.repo.getDatabase().prepare(`INSERT INTO verification_capabilities
        (id,project_id,owner_principal,version,state,payload_json,payload_hash,approval_id,approval_json,created_at)
        VALUES (?,?,?,1,'ACTIVE',?,?,?,?,?)`).run(id, payload.project_id, currentOwner, payloadJson, payloadHash, approvalId,
        canonicalJsonStringify({ method: 'OS_AUTHENTICATED_NATIVE_CONFIRMATION', owner_principal: currentOwner, approval_id: approvalId, payload_hash: payloadHash }), new Date().toISOString());
    });
    return { id, version: 1, owner_principal: currentOwner, payload_hash: payloadHash };
  }

  public validate(reference: VerificationCapabilityReference, projectId: string, executable: string, args: string[], runtimeRoot: string,
    authorizationId?: string): VerificationCapabilityPayload {
    const ref = VerificationCapabilityReferenceSchema.safeParse(reference);
    if (!ref.success) throw new VerificationCapabilityError('OWNER_APPROVAL_REQUIRED');
    const row = this.repo.getDatabase().prepare('SELECT * FROM verification_capabilities WHERE id=?').get(ref.data.id) as VerificationCapabilityRecord | undefined;
    if (!row) throw new VerificationCapabilityError('CAPABILITY_NOT_FOUND');
    if (row.state !== 'ACTIVE' || row.revoked_at) throw new VerificationCapabilityError('CAPABILITY_REVOKED');
    if (row.version !== ref.data.version) throw new VerificationCapabilityError('CAPABILITY_VERSION_MISMATCH');
    if (row.owner_principal !== this.ownerPrincipal() || row.owner_principal !== ref.data.owner_principal) throw new VerificationCapabilityError('CAPABILITY_OWNER_MISMATCH');
    const payload = VerificationCapabilityPayloadSchema.parse(JSON.parse(row.payload_json));
    let approval: Record<string, unknown>;
    try { approval = JSON.parse(row.approval_json); } catch { throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY'); }
    if (!approval || approval.method !== 'OS_AUTHENTICATED_NATIVE_CONFIRMATION' ||
        approval.approval_id !== row.approval_id || approval.owner_principal !== row.owner_principal || approval.payload_hash !== row.payload_hash) {
      throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
    }
    if (row.project_id !== projectId || payload.project_id !== projectId || payload.owner_principal !== row.owner_principal ||
      row.payload_hash !== ref.data.payload_hash || sha256(canonicalJsonStringify(payload)) !== row.payload_hash ||
      !samePath(payload.executable.path, executable) || canonicalJsonStringify(payload.args) !== canonicalJsonStringify(args)) {
      throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
    }
    const project = this.repo.getProject(projectId);
    if (!project || !samePath(canonicalPath(project.repository_path, true).path, payload.project_root)) {
      throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
    }
    const authorized = authorizationId ? this.loadAuthorizationPayload(projectId, authorizationId) : undefined;
    if (authorized && !Object.values(authorized.verificationCommands).some((command) => command &&
        canonicalJsonStringify(command.capability) === canonicalJsonStringify(ref.data) &&
        samePath(command.executable, executable) && canonicalJsonStringify(command.args) === canonicalJsonStringify(args))) {
      throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
    }
    const runtimePath = canonicalPath(runtimeRoot, true).path;
    if (!samePath(runtimePath, payload.project_root)) {
      if (!authorized?.executionScope || !samePath(runtimePath, canonicalPath(authorized.executionScope.worktree, true).path)) {
        throw new VerificationCapabilityError('CAPABILITY_PATH_ESCAPE');
      }
    }
    this.assertPayloadFiles(payload, runtimePath, samePath(runtimePath, payload.project_root));
    return payload;
  }

  public revoke(reference: VerificationCapabilityReference): void {
    const ref = VerificationCapabilityReferenceSchema.parse(reference);
    if (ref.owner_principal !== this.ownerPrincipal()) throw new VerificationCapabilityError('CAPABILITY_OWNER_MISMATCH');
    const result = this.repo.getDatabase().prepare(`UPDATE verification_capabilities SET state='REVOKED', version=version+1, revoked_at=?
      WHERE id=? AND owner_principal=? AND version=? AND state='ACTIVE'`).run(new Date().toISOString(), ref.id, ref.owner_principal, ref.version);
    if (result.changes !== 1) throw new VerificationCapabilityError('CAPABILITY_VERSION_MISMATCH');
  }

  public createProcessBoundary(reference: VerificationCapabilityReference, projectId: string, executable: string,
    args: string[], runtimeRoot: string, authorizationId?: string): VerificationProcessBoundary {
    const captured = VerificationCapabilityReferenceSchema.parse(JSON.parse(JSON.stringify(reference)));
    const capturedArgs = [...args];
    const runtime = canonicalPath(runtimeRoot, true);
    const root = runtime.path;
    this.validate(captured, projectId, executable, capturedArgs, root, authorizationId);
    // Windows process creation fills an omitted USERPROFILE from the host.
    // Explicit empty values prevent ambient profile/config inheritance.
    const environment: Record<string, string> = {
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      USERPROFILE: '', HOME: '', APPDATA: '', LOCALAPPDATA: '',
    };
    const temp = fs.realpathSync.native(os.tmpdir());
    environment.TEMP = temp;
    environment.TMP = temp;
    if (process.platform === 'win32') {
      const systemRoot = fs.realpathSync.native(process.env.SystemRoot ?? 'C:\\Windows');
      environment.SystemRoot = systemRoot;
      environment.WINDIR = systemRoot;
      environment.PATH = path.join(systemRoot, 'System32');
    } else {
      environment.PATH = '/usr/bin:/bin';
    }
    return issueVerificationProcessBoundary(environment, (actualExecutable, actualArgs, cwd) => {
      if (!samePath(canonicalPath(cwd, true).path, root)) throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
      if (canonicalPath(cwd, true).identity !== runtime.identity) throw new VerificationCapabilityError('PATH_IDENTITY_CHANGED');
      this.validate(captured, projectId, actualExecutable, actualArgs, cwd, authorizationId);
    });
  }

  /** Every enabled snapshot command must retain a live, owner-bound grant. */
  public validateSnapshot(projectId: string, snapshot: unknown, runtimeRoot: string, authorizationId?: string): void {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
    }
    if (authorizationId) {
      const payload = this.loadAuthorizationPayload(projectId, authorizationId);
      if (canonicalJsonStringify(snapshot) !== canonicalJsonStringify(payload.verificationCommands)) {
        throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
      }
    }
    for (const type of ['TEST', 'LINT', 'BUILD']) {
      const command = (snapshot as Record<string, unknown>)[type];
      if (command === null || command === undefined) continue;
      if (!command || typeof command !== 'object' || Array.isArray(command)) {
        throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
      }
      const value = command as Record<string, unknown>;
      if (typeof value.executable !== 'string' || !Array.isArray(value.args) ||
          !value.args.every((argument) => typeof argument === 'string')) {
        throw new VerificationCapabilityError('INVALID_VERIFICATION_CAPABILITY');
      }
      this.validate(value.capability as VerificationCapabilityReference, projectId, value.executable, value.args, runtimeRoot, authorizationId);
    }
  }

  private loadAuthorizationPayload(projectId: string, authorizationId: string): CanonicalExecutionPayload {
    const authorization = this.repo.getExecutionAuthorization(authorizationId);
    if (!authorization || authorization.project_id !== projectId || !authorization.canonical_payload_json ||
        authorization.status === 'INVALIDATED') throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH');
    try {
      const payload = CanonicalExecutionPayloadSchema.parse(JSON.parse(authorization.canonical_payload_json));
      const task = this.repo.getTask(authorization.task_id);
      if (!task || task.project_id !== projectId || payload.projectId !== projectId || payload.taskId !== task.id ||
          computePayloadHash(payload) !== authorization.instruction_payload_hash ||
          (authorization.task_ownership_epoch != null && authorization.task_ownership_epoch !== (task.ownership_epoch ?? 1))) {
        throw new Error('AUTHORIZATION_BINDING_MISMATCH');
      }
      return payload;
    } catch { throw new VerificationCapabilityError('CAPABILITY_BINDING_MISMATCH'); }
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
      // Validate what the exact argv resolves to, including path aliases.
      // Absolute argv keeps its original binding when cwd is a worktree.
      const argument = path.resolve(runtime.path, payload.args[script.argument_index]);
      const actual = samePath(argument, candidate) ? binding : bindFile(argument);
      const expected = original || path.isAbsolute(payload.args[script.argument_index]) ? script.binding : binding;
      if (!samePath(actual.path, expected.path) || actual.identity !== expected.identity) throw new VerificationCapabilityError('PATH_IDENTITY_CHANGED');
      if (actual.sha256 !== script.binding.sha256) throw new VerificationCapabilityError('CONTENT_HASH_CHANGED');
    }
  }
}
