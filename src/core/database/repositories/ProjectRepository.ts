import Database from 'better-sqlite3';
import { Project, ProjectContract, ProjectStatus } from '../../types/domain';
import { assertRepositoryRootIdentity, RepositoryRootError, RepositoryRootIdentity } from '../../services/RepositoryRootIdentity';
import { RepositoryRootLease } from '../../services/RepositoryRootLease';

/**
 * Project persistence boundary extracted from the compatibility Repository
 * facade. It deliberately accepts the facade's existing SQLite handle so
 * callers keep the same transaction and single-writer semantics.
 */
export class ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  public createProject(project: Project, rootIdentity?: RepositoryRootIdentity): void {
    if (rootIdentity && project.repository_path !== rootIdentity.canonicalPath) throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_CHANGED');
    const receipt = rootIdentity ? JSON.stringify(rootIdentity) : null;
    if (receipt && Buffer.byteLength(receipt) > 262_144) throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE');
    const lease = rootIdentity ? RepositoryRootLease.acquire(rootIdentity) : undefined;
    try { this.db.transaction(() => {
      if (rootIdentity) assertRepositoryRootIdentity(rootIdentity);
      this.db
        .prepare(`
          INSERT INTO projects (
            id, name, description, repository_path, default_branch,
            status, contract_json, created_at, updated_at, started_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          project.id,
          project.name,
          project.description,
          project.repository_path,
          project.default_branch,
          project.status,
          project.contract ? JSON.stringify(project.contract) : null,
          project.created_at,
          project.updated_at,
          project.started_at,
          project.completed_at
        );
      if (rootIdentity) {
        this.db.prepare(`INSERT INTO project_repository_identities (project_id, canonical_path, identity_json, created_at)
          VALUES (?, ?, ?, ?)`).run(project.id, rootIdentity.canonicalPath, receipt, project.created_at);
        assertRepositoryRootIdentity(rootIdentity);
      }
    }).immediate(); } finally { lease?.close(); }
  }

  public getProject(id: string): Project | null {
    const project = this.getProjectMetadata(id);
    if (!project) return null;
    this.getRepositoryIdentity(id);
    return project;
  }

  /** Display/stop metadata only; this lookup grants no repository access. */
  public getProjectMetadata(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapProject(row);
  }

  public getRepositoryIdentity(id: string): RepositoryRootIdentity | null {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_repository_identities'").get()) return null;
    const row = this.db.prepare(`SELECT r.canonical_path, r.identity_json, p.repository_path
      FROM project_repository_identities r JOIN projects p ON p.id=r.project_id WHERE r.project_id=?`).get(id) as {
      canonical_path: string; identity_json: string; repository_path: string;
    } | undefined;
    if (!row) return null;
    let identity: RepositoryRootIdentity;
    try {
      if (typeof row.identity_json !== 'string' || Buffer.byteLength(row.identity_json) > 262_144) throw new Error();
      identity = JSON.parse(row.identity_json) as RepositoryRootIdentity;
      if (row.repository_path !== row.canonical_path || identity.canonicalPath !== row.canonical_path) throw new Error();
    } catch { throw new RepositoryRootError('REPOSITORY_ROOT_IDENTITY_UNAVAILABLE'); }
    assertRepositoryRootIdentity(identity);
    return identity;
  }

  public getAllProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((row) => this.mapProject(row));
  }

  public updateProjectStatus(id: string, status: ProjectStatus, startedAt?: string, completedAt?: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        UPDATE projects
        SET status = ?, updated_at = ?,
            started_at = COALESCE(?, started_at),
            completed_at = COALESCE(?, completed_at)
        WHERE id = ?
      `)
      .run(status, now, startedAt ?? null, completedAt ?? null, id);
  }

  public updateProjectContract(id: string, contract: ProjectContract): void {
    const now = new Date().toISOString();
    this.db
      .prepare('UPDATE projects SET contract_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(contract), now, id);
  }

  private mapProject(row: Record<string, unknown>): Project {
    return {
      id: String(row.id),
      name: String(row.name),
      description: row.description ? String(row.description) : null,
      repository_path: String(row.repository_path),
      default_branch: String(row.default_branch),
      status: row.status as ProjectStatus,
      contract: row.contract_json ? (JSON.parse(String(row.contract_json)) as ProjectContract) : null,
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
      started_at: row.started_at ? String(row.started_at) : null,
      completed_at: row.completed_at ? String(row.completed_at) : null,
    };
  }
}
