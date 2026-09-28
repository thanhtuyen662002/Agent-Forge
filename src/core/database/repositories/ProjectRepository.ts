import Database from 'better-sqlite3';
import { Project, ProjectContract, ProjectStatus } from '../../types/domain';

/**
 * Project persistence boundary extracted from the compatibility Repository
 * facade. It deliberately accepts the facade's existing SQLite handle so
 * callers keep the same transaction and single-writer semantics.
 */
export class ProjectRepository {
  constructor(private readonly db: Database.Database) {}

  public createProject(project: Project): void {
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
  }

  public getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapProject(row);
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
