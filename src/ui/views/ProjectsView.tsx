import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { FolderGit2, Plus, FileCode, Check } from 'lucide-react';

export const ProjectsView: React.FC = () => {
  const { projects, activeProject, createProject, importContract } = useOrchestrator();
  const [isCreateOpen, setIsCreateOpen] = useState<boolean>(false);
  const [name, setName] = useState<string>('');
  const [desc, setDesc] = useState<string>('');
  const [repoPath, setRepoPath] = useState<string>('d:\\Projects\\Agent-Forge');
  const [contractJson, setContractJson] = useState<string>('');
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !repoPath.trim()) return;
    await createProject({ name, description: desc, repositoryPath: repoPath });
    setName('');
    setDesc('');
    setIsCreateOpen(false);
  };

  const handleImportContract = async () => {
    if (!contractJson.trim()) return;
    try {
      const parsed = JSON.parse(contractJson);
      await importContract(parsed);
      setImportStatus('Contract successfully imported!');
    } catch (err: any) {
      setImportStatus(`JSON Error: ${err.message}`);
    }
  };

  return (
    <div className="p-8 space-y-8 max-w-7xl mx-auto overflow-y-auto">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
            <FolderGit2 className="w-5 h-5 text-forge-cyan" />
            <span>Projects & Project Contract</span>
          </h2>
          <p className="text-xs text-slate-400">
            Bind local Git repositories and import durable project contracts and architecture constraints.
          </p>
        </div>

        <button
          onClick={() => setIsCreateOpen(true)}
          className="px-4 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-mono font-bold text-xs rounded-lg shadow flex items-center space-x-2 transition"
        >
          <Plus className="w-4 h-4" />
          <span>NEW PROJECT</span>
        </button>
      </div>

      {/* Contract Editor / Importer */}
      <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
        <h3 className="text-sm font-semibold text-white font-mono uppercase tracking-wider flex items-center space-x-2">
          <FileCode className="w-4 h-4 text-forge-purple" />
          <span>Project Contract Importer</span>
        </h3>
        <p className="text-xs text-slate-400">
          Import durable project goals, security requirements, and definition of done (DoD) to guide Manager decomposition.
        </p>

        <textarea
          value={contractJson}
          onChange={(e) => setContractJson(e.target.value)}
          placeholder={`{
  "goal": "Build a local AI engineering desktop orchestrator",
  "architecture_constraints": ["Must use better-sqlite3 with WAL mode", "Strict Electron security boundary"],
  "security_requirements": ["No arbitrary shell execution", "Zero ChatGPT web scraping"],
  "definition_of_done": ["All unit tests pass", "Manual bridge functions end-to-end"]
}`}
          className="w-full h-48 bg-surface border border-surface-border rounded-lg p-4 text-xs font-mono text-slate-100 focus:outline-none focus:border-forge-purple resize-none"
        />

        {importStatus && (
          <div className="p-3 bg-emerald-950/30 border border-emerald-800/40 text-emerald-300 rounded-lg text-xs font-mono">
            {importStatus}
          </div>
        )}

        <div className="flex justify-end">
          <button
            onClick={handleImportContract}
            className="px-5 py-2 bg-forge-purple hover:bg-purple-600 text-white font-mono font-bold text-xs rounded-lg shadow transition"
          >
            IMPORT CONTRACT
          </button>
        </div>
      </div>

      {/* New Project Modal */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-sm font-mono font-bold text-white uppercase tracking-wider">Create New Project</h3>
            <form onSubmit={handleCreate} className="space-y-4 text-xs font-mono">
              <div>
                <label className="block text-slate-400 mb-1">Project Name:</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Agent-Forge Control Plane"
                  className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-white font-sans focus:outline-none focus:border-forge-cyan"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Description:</label>
                <textarea
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  placeholder="Project overview..."
                  className="w-full h-20 bg-surface-card border border-surface-border rounded-lg p-3 text-white font-sans focus:outline-none focus:border-forge-cyan resize-none"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Repository Path (Absolute):</label>
                <input
                  type="text"
                  required
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-forge-cyan"
                />
              </div>

              <div className="flex justify-end space-x-3 pt-3 border-t border-surface-border">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-bold rounded-lg text-xs shadow"
                >
                  Initialize Project
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
