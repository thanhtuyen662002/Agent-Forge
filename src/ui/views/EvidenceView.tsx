import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { ShieldCheck, FileCode, Check, Eye } from 'lucide-react';

export const EvidenceView: React.FC = () => {
  const { evidence } = useOrchestrator();
  const { t } = useI18n();
  const [selectedEvidence, setSelectedEvidence] = useState<any | null>(null);

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto overflow-y-auto">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
          <ShieldCheck className="w-5 h-5 text-forge-emerald" />
          <span>{t('evidence.title')}</span>
        </h2>
        <p className="text-xs text-slate-400">
          {t('evidence.subtitle')}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Evidence List (1 col) */}
        <div className="bg-surface-card border border-surface-border rounded-xl p-4 shadow space-y-3 max-h-[600px] overflow-y-auto">
          <div className="text-xs font-mono font-semibold text-slate-400 uppercase tracking-wider pb-2 border-b border-surface-border">
            {t('evidence.collectedRecords', { count: evidence.length.toString() })}
          </div>

          {evidence.length === 0 ? (
            <div className="p-8 text-center text-xs font-mono text-slate-500">
              {t('evidence.noEvidence')}
            </div>
          ) : (
            evidence.map((ev) => (
              <div
                key={ev.id}
                onClick={() => setSelectedEvidence(ev)}
                className={`p-3 rounded-lg border text-xs font-mono cursor-pointer transition space-y-1.5 ${
                  selectedEvidence?.id === ev.id
                    ? 'bg-forge-cyan/15 border-forge-cyan/40 text-white'
                    : 'bg-surface border-surface-border text-slate-300 hover:border-slate-600'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-forge-cyan">{ev.evidence_type}</span>
                  <span className="text-[10px] text-slate-500">{ev.storage_type}</span>
                </div>
                <div className="text-[11px] text-slate-300 truncate font-sans">{ev.summary}</div>
                <div className="text-[10px] text-slate-500 font-mono flex items-center justify-between">
                  <span>{t('evidence.shaPrefix')}: {ev.hash.substring(0, 8)}...</span>
                  <span>{ev.byte_size} {t('common.bytes')}</span>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Evidence Inspector (2 cols) */}
        <div className="lg:col-span-2 bg-surface-card border border-surface-border rounded-xl p-5 shadow space-y-4 flex flex-col justify-between">
          <div>
            <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider mb-2">
              {t('evidence.inspectorTitle')}
            </h3>

            {selectedEvidence ? (
              <div className="space-y-4">
                <div className="p-3 bg-surface rounded-lg border border-surface-border text-xs font-mono space-y-1">
                  <div>{t('evidence.idLabel')}: <strong className="text-white">{selectedEvidence.id}</strong></div>
                  <div>{t('evidence.checksumLabel')}: <strong className="text-forge-emerald">{selectedEvidence.hash}</strong></div>
                  <div>{t('evidence.storageTypeLabel')}: <span className="text-slate-300">{selectedEvidence.storage_type} ({selectedEvidence.file_path || t('evidence.inlineSqlite')})</span></div>
                </div>

                <pre className="p-4 bg-surface rounded-xl border border-surface-border text-slate-200 font-mono text-xs overflow-x-auto max-h-96">
                  {selectedEvidence.raw_payload || t('evidence.payloadDiskNotice')}
                </pre>
              </div>
            ) : (
              <div className="h-80 flex flex-col items-center justify-center text-slate-500 font-mono text-xs border border-dashed border-surface-border rounded-xl">
                {t('evidence.emptyInspector')}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
