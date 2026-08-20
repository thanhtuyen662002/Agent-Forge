import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { History, Search, Filter, ChevronDown, ChevronRight, Terminal, Shield } from 'lucide-react';

export const TimelineView: React.FC = () => {
  const { events } = useOrchestrator();
  const { t } = useI18n();
  const [filterType, setFilterType] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

  const filteredEvents = events.filter((ev) => {
    if (filterType !== 'ALL' && !ev.type.includes(filterType)) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      return (
        ev.type.toLowerCase().includes(q) ||
        ev.summary.toLowerCase().includes(q) ||
        (ev.task_id && ev.task_id.toLowerCase().includes(q))
      );
    }
    return true;
  });

  return (
    <div className="p-8 space-y-6 max-w-7xl mx-auto overflow-y-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center space-x-2.5">
            <History className="w-5 h-5 text-forge-cyan" />
            <span>{t('timeline.title')}</span>
          </h2>
          <p className="text-xs text-slate-400">
            {t('timeline.subtitle')}
          </p>
        </div>

        {/* Filter and Search */}
        <div className="flex items-center space-x-3 text-xs font-mono">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('timeline.searchPlaceholder')}
              className="bg-surface-card border border-surface-border rounded-lg pl-8 pr-3 py-1.5 text-white focus:outline-none focus:border-forge-cyan"
            />
          </div>

          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="bg-surface-card border border-surface-border rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-forge-cyan"
          >
            <option value="ALL">{t('timeline.filterAll')}</option>
            <option value="MANAGER">{t('timeline.filterManager')}</option>
            <option value="CODER">{t('timeline.filterCoder')}</option>
            <option value="TEST">{t('timeline.filterTest')}</option>
            <option value="EMERGENCY">{t('timeline.filterEmergency')}</option>
          </select>
        </div>
      </div>

      {/* Events Feed */}
      <div className="space-y-3">
        {filteredEvents.length === 0 ? (
          <div className="p-12 text-center text-slate-500 font-mono text-xs border border-dashed border-surface-border rounded-xl">
            {t('timeline.noEventsMatch')}
          </div>
        ) : (
          filteredEvents.map((ev) => {
            const isExpanded = expandedEventId === ev.id;
            return (
              <div
                key={ev.id}
                className="bg-surface-card border border-surface-border rounded-xl p-4 space-y-3 hover:border-surface-hover transition"
              >
                <div
                  onClick={() => setExpandedEventId(isExpanded ? null : ev.id)}
                  className="flex items-start justify-between cursor-pointer"
                >
                  <div className="flex items-start space-x-3">
                    <div className="w-2 h-2 rounded-full bg-forge-cyan mt-1.5 shrink-0"></div>
                    <div className="space-y-0.5">
                      <div className="flex items-center space-x-3 text-xs font-mono">
                        <span className="font-bold text-white">{ev.type}</span>
                        {ev.task_id && (
                          <span className="px-1.5 py-0.2 rounded bg-surface text-forge-cyan border border-surface-border text-[10px]">
                            {ev.task_id}
                          </span>
                        )}
                        <span className="text-[10px] text-slate-500">{new Date(ev.timestamp).toLocaleString()}</span>
                      </div>
                      <p className="text-xs text-slate-300 font-sans">{ev.summary}</p>
                    </div>
                  </div>

                  <div className="text-slate-400 p-1">
                    {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </div>
                </div>

                {isExpanded && (
                  <div className="pt-3 border-t border-surface-border font-mono text-xs">
                    <div className="text-[10px] text-slate-400 mb-1">{t('timeline.structuredPayloadLabel')}:</div>
                    <pre className="p-3 bg-surface rounded-lg border border-surface-border text-slate-200 overflow-x-auto text-[11px]">
                      {JSON.stringify(ev.structured_payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
