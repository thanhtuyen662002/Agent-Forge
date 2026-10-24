import React from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { AccessibleDialog } from './AccessibleDialog';
import type { TrashActionResult } from '../workspaceTrash';
import type { TrashListing } from '../../core/types/workspace';

export const TrashFailureMessage: React.FC<{ result: TrashActionResult; taskId?: string }> = ({ result, taskId }) => {
  const { t } = useI18n();
  if (result.success) return null;
  return (
    <div role="alert" className="p-2.5 bg-rose-950/40 border border-rose-800/50 text-rose-300 rounded-lg text-xs space-y-1">
      <div>{t(`trash.errors.${result.code}`)}</div>
      {result.blockers.length > 0 && (
        <ul className="list-disc pl-4 space-y-0.5">
          {result.blockers.map((blocker, index) => (
            <li key={`${blocker.code}-${blocker.reference}-${index}`}>
              {t(`trash.blockers.${blocker.code}`, { reference: blocker.reference, task: blocker.taskId ?? taskId ?? '' })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

interface ConfirmTrashDialogProps {
  kind: 'project' | 'task';
  name: string;
  pending: boolean;
  failure: TrashActionResult | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export const ConfirmTrashDialog: React.FC<ConfirmTrashDialogProps> = ({ kind, name, pending, failure, onCancel, onConfirm }) => {
  const { t } = useI18n();
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <AccessibleDialog
        onDismiss={() => { if (!pending) onCancel(); }}
        dismissible={!pending}
        aria-labelledby="trash-confirm-title"
        aria-describedby="trash-confirm-body"
        className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4"
      >
        <h3 id="trash-confirm-title" className="text-base font-bold text-white">
          {t(kind === 'project' ? 'trash.confirm.projectTitle' : 'trash.confirm.taskTitle', { name })}
        </h3>
        <p id="trash-confirm-body" className="text-sm text-slate-300">{t('trash.confirm.body')}</p>
        {failure && <TrashFailureMessage result={failure} />}
        <div className="flex justify-end gap-3 pt-3 border-t border-surface-border">
          <button
            type="button"
            data-dialog-initial-focus
            onClick={onCancel}
            disabled={pending}
            className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs"
          >
            {t('trash.confirm.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            aria-busy={pending}
            className="px-5 py-2 bg-rose-600 hover:bg-rose-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold rounded-lg text-xs shadow"
          >
            {pending ? t('actions.pending') : t('trash.confirm.confirm')}
          </button>
        </div>
      </AccessibleDialog>
    </div>
  );
};

interface TrashListProps {
  listing: TrashListing;
  show: 'projects' | 'tasks';
  pending: boolean;
  onRestoreProject?: (id: string, name: string) => void;
  onRestoreTask?: (id: string, title: string) => void;
}

/** Trashed items with restore controls. Nothing here deletes data. */
export const TrashList: React.FC<TrashListProps> = ({ listing, show, pending, onRestoreProject, onRestoreTask }) => {
  const { t } = useI18n();
  const items = show === 'projects'
    ? listing.projects.map((project) => ({ id: project.id, label: project.name, detail: project.status, trashedAt: project.trashedAt, restore: () => onRestoreProject?.(project.id, project.name) }))
    : listing.tasks.map((task) => ({ id: task.id, label: task.title, detail: t('trash.inProject', { name: task.projectName }), trashedAt: task.trashedAt, restore: () => onRestoreTask?.(task.id, task.title) }));
  const headingId = `trash-list-${show}`;

  return (
    <section aria-labelledby={headingId} className="bg-surface-card border border-surface-border rounded-xl p-5 space-y-3">
      <h3 id={headingId} className="text-sm font-semibold text-white flex items-center gap-2">
        <Trash2 className="w-4 h-4 text-slate-400" aria-hidden="true" />
        <span>{t(show === 'projects' ? 'trash.projectsHeading' : 'trash.tasksHeading')} ({items.length})</span>
      </h3>
      <p className="text-xs text-slate-400">{t('trash.subtitle')}</p>
      {items.length === 0 ? (
        <p className="text-xs text-slate-500">{t('trash.empty')}</p>
      ) : (
        <ul className="divide-y divide-surface-border">
          {items.map((item) => (
            <li key={item.id} className="py-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm text-slate-200 truncate" title={item.label}>{item.label}</div>
                <div className="text-[11px] text-slate-500 truncate">
                  {item.detail} · {t('trash.trashedAt', { time: new Date(item.trashedAt).toLocaleString() })}
                </div>
              </div>
              <button
                type="button"
                onClick={item.restore}
                disabled={pending}
                className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-forge-cyan/15 text-forge-cyan border border-forge-cyan/40 hover:bg-forge-cyan/25 disabled:opacity-40 flex items-center gap-1.5"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t('trash.restore')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
