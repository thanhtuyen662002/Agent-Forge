import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { QuotaBadge } from '../components/QuotaBadge';
import { ProviderResource, QuotaSource } from '../../core/types/domain';
import { Cpu, Edit2 } from 'lucide-react';

export interface QuotaSnapshotResolution {
  remaining: number | null;
  total: number | null;
  source: QuotaSource;
  confidence: number;
}

/**
 * Formats a provider quota value for display in the quota editor input.
 * Preserves a real zero as '0' and represents null/undefined as an empty string ('')
 * rather than inventing numeric defaults like 0 or 100.
 */
export function formatQuotaInput(value: number | string | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  return String(value);
}

/**
 * Parses an input value from the quota editor.
 * Returns null for empty strings, null, or undefined.
 * Returns the parsed number if finite numeric (preserving zero as 0).
 */
export function parseQuotaInput(input: number | string | null | undefined): number | null {
  if (input === null || input === undefined) {
    return null;
  }
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : null;
  }
  const trimmed = String(input).trim();
  if (trimmed === '') {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export const parseQuotaValue = parseQuotaInput;

/**
 * Resolves editor inputs into a truthful quota snapshot payload.
 *
 * Rules:
 * 1. If both remaining and total inputs are empty/null:
 *    persists remaining=null, total=null, source='UNKNOWN', confidence=0.
 * 2. If entered numeric quota values are provided:
 *    persists numeric remaining/total with source='MANUAL' and confidence=1.
 */
export function resolveQuotaSnapshot(
  remainingInput: number | string | null | undefined,
  totalInput: number | string | null | undefined
): QuotaSnapshotResolution {
  const remaining = parseQuotaInput(remainingInput);
  const total = parseQuotaInput(totalInput);

  if (remaining === null && total === null) {
    return {
      remaining: null,
      total: null,
      source: 'UNKNOWN',
      confidence: 0,
    };
  }

  return {
    remaining,
    total,
    source: 'MANUAL',
    confidence: 1,
  };
}

export const resolveQuotaUpdate = resolveQuotaSnapshot;

export const CapacityView: React.FC = () => {
  const { resources, updateResourceQuota } = useOrchestrator();
  const { t } = useI18n();
  const [editingResource, setEditingResource] = useState<ProviderResource | null>(null);
  const [editRemaining, setEditRemaining] = useState<string>('');
  const [editTotal, setEditTotal] = useState<string>('');

  const handleSaveQuota = async () => {
    if (!editingResource) return;
    const snapshot = resolveQuotaSnapshot(editRemaining, editTotal);
    await updateResourceQuota(
      editingResource.id,
      snapshot.remaining,
      snapshot.total,
      snapshot.source,
      snapshot.confidence
    );
    setEditingResource(null);
    setEditRemaining('');
    setEditTotal('');
  };

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto overflow-y-auto">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
          <Cpu className="w-5 h-5 text-forge-emerald" />
          <span>{t('capacity.title')}</span>
        </h2>
        <p className="text-xs text-slate-400">
          {t('capacity.subtitle')}
        </p>
      </div>

      {/* Resource Table / Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {resources.map((res) => (
          <div
            key={res.id}
            className="bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4 flex flex-col justify-between"
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono font-bold text-forge-cyan">{res.id}</span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-surface border border-surface-border text-slate-300">
                  {res.health_status}
                </span>
              </div>
              <h3 className="text-sm font-semibold text-white">{res.model_name}</h3>
              <div className="flex flex-wrap gap-1 pt-1">
                {res.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-surface border border-surface-border text-slate-400"
                  >
                    {cap}
                  </span>
                ))}
              </div>
            </div>

            <div className="pt-3 border-t border-surface-border space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-mono text-slate-400">{t('capacity.quotaLabel')}:</span>
                <QuotaBadge
                  remaining={res.remaining_quota}
                  total={res.total_quota}
                  unit={res.quota_unit}
                  source={res.quota_source}
                  confidence={res.quota_confidence}
                />
              </div>

              <button
                onClick={() => {
                  setEditingResource(res);
                  setEditRemaining(formatQuotaInput(res.remaining_quota));
                  setEditTotal(formatQuotaInput(res.total_quota));
                }}
                className="w-full py-1.5 bg-surface hover:bg-surface-hover text-slate-300 rounded-lg border border-surface-border text-xs font-mono flex items-center justify-center space-x-1.5 transition"
              >
                <Edit2 className="w-3 h-3 text-forge-cyan" />
                <span>{t('capacity.adjustSnapshot')}</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Edit Quota Modal */}
      {editingResource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <h3 className="text-sm font-mono font-bold text-white uppercase tracking-wider">
              {t('capacity.adjustTitle', { modelName: editingResource.model_name })}
            </h3>

            <div className="space-y-3 text-xs font-mono">
              <div>
                <label className="block text-slate-400 mb-1">
                  {t('capacity.remainingUnits', { unit: editingResource.quota_unit })}:
                </label>
                <input
                  type="number"
                  value={editRemaining}
                  onChange={(e) => setEditRemaining(e.target.value)}
                  placeholder={t('common.unknown')}
                  className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-white font-mono focus:outline-none focus:border-forge-cyan"
                />
              </div>

              <div>
                <label className="block text-slate-400 mb-1">{t('capacity.totalUnits')}:</label>
                <input
                  type="number"
                  value={editTotal}
                  onChange={(e) => setEditTotal(e.target.value)}
                  placeholder={t('common.unknown')}
                  className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-white font-mono focus:outline-none focus:border-forge-cyan"
                />
              </div>
            </div>

            <div className="flex justify-end space-x-3 pt-3 border-t border-surface-border">
              <button
                onClick={() => {
                  setEditingResource(null);
                  setEditRemaining('');
                  setEditTotal('');
                }}
                className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs"
              >
                {t('capacity.cancel')}
              </button>
              <button
                onClick={handleSaveQuota}
                className="px-5 py-2 bg-forge-emerald hover:bg-emerald-600 text-slate-950 font-mono font-bold rounded-lg text-xs shadow"
              >
                {t('capacity.saveSnapshot')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
