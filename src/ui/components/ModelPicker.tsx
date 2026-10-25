import React, { useEffect, useState } from 'react';
import { useI18n } from '../context/I18nContext';
import type { CatalogModel, ModelCatalog } from '../../core/services/ModelCatalogService';
import type { AgentConnectionKind } from '../../core/types/workspace';

const CUSTOM = '__custom__';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Accepts only a well-formed catalog; anything else means "type it yourself". */
export function normalizeModelCatalog(reply: unknown): ModelCatalog | null {
  if (!isRecord(reply) || reply.success !== true || !isRecord(reply.catalog)) return null;
  const { catalog } = reply;
  if ((catalog.source !== 'LIVE' && catalog.source !== 'BUILT_IN') || !Array.isArray(catalog.models)) return null;
  const models: CatalogModel[] = [];
  for (const item of catalog.models) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || typeof item.label !== 'string') return null;
    models.push({
      id: item.id, label: item.label,
      description: typeof item.description === 'string' ? item.description : null,
      descriptionKey: typeof item.descriptionKey === 'string' ? item.descriptionKey : null,
      isDefault: item.isDefault === true,
      kind: item.kind === 'ALIAS' ? 'ALIAS' : 'MODEL',
    });
  }
  return { connection: catalog.connection as AgentConnectionKind, source: catalog.source, models };
}

interface ModelPickerProps {
  id: string;
  /** OTHER (configured outside Agent Center) and the manual bridge get a plain text field. */
  connection: AgentConnectionKind | 'OTHER';
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  describedBy?: string;
  inputClass: string;
}

/**
 * Model choice for a CLI agent (#263): the CLI's own current list (Codex) or
 * its latest-tracking aliases, with "Other" for a name typed by hand.
 */
export const ModelPicker: React.FC<ModelPickerProps> = ({ id, connection, value, onChange, disabled, describedBy, inputClass }) => {
  const { t } = useI18n();
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [custom, setCustom] = useState(false);

  useEffect(() => {
    let active = true;
    setCatalog(null);
    setCustom(false);
    if (connection === 'MANUAL_BRIDGE' || connection === 'OTHER' || !api?.listAgentModels) return undefined;
    setLoading(true);
    Promise.resolve(api.listAgentModels(connection)).then((reply: unknown) => {
      if (active) setCatalog(normalizeModelCatalog(reply));
    }).catch(() => undefined).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, connection]);

  const models = catalog?.models ?? [];
  const known = models.some((entry) => entry.id === value);

  // A new agent starts on the CLI's default choice once the list arrives.
  useEffect(() => {
    if (!catalog || value || disabled) return;
    const preferred = catalog.models.find((entry) => entry.isDefault) ?? catalog.models[0];
    if (preferred) onChange(preferred.id);
  }, [catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const textInput = (
    <input
      id={catalog && models.length > 0 ? `${id}-custom` : id}
      type="text"
      required
      maxLength={120}
      value={value}
      disabled={disabled}
      aria-describedby={describedBy}
      aria-label={catalog && models.length > 0 ? t('agentCenter.models.customLabel') : undefined}
      onChange={(event) => onChange(event.target.value)}
      placeholder={t('agentCenter.form.modelPlaceholder')}
      className={`${inputClass} disabled:opacity-50`}
    />
  );

  if (!catalog || models.length === 0) {
    return (
      <>
        {textInput}
        {loading && <p className="mt-1 text-xs text-slate-500">{t('agentCenter.models.loading')}</p>}
      </>
    );
  }

  const showCustom = custom || (!!value && !known);
  const selected = models.find((entry) => entry.id === value) ?? null;
  const description = selected
    ? selected.description ?? (selected.descriptionKey ? t(`agentCenter.models.descriptions.${selected.descriptionKey}`) : null)
    : null;
  const option = (entry: CatalogModel) => (
    <option key={entry.id} value={entry.id}>
      {entry.label}{entry.label !== entry.id ? ` (${entry.id})` : ''}{entry.isDefault ? ` — ${t('agentCenter.models.default')}` : ''}
    </option>
  );
  const aliases = models.filter((entry) => entry.kind === 'ALIAS');
  const specific = models.filter((entry) => entry.kind === 'MODEL');

  return (
    <div className="space-y-1.5">
      <select
        id={id}
        value={showCustom ? CUSTOM : value}
        disabled={disabled}
        aria-describedby={describedBy}
        onChange={(event) => {
          if (event.target.value === CUSTOM) { setCustom(true); onChange(''); }
          else { setCustom(false); onChange(event.target.value); }
        }}
        className={`${inputClass} disabled:opacity-50`}
      >
        {aliases.length > 0 && <optgroup label={t('agentCenter.models.latestGroup')}>{aliases.map(option)}</optgroup>}
        {specific.length > 0 && <optgroup label={t('agentCenter.models.modelGroup')}>{specific.map(option)}</optgroup>}
        <option value={CUSTOM}>{t('agentCenter.models.custom')}</option>
      </select>
      {showCustom && textInput}
      {!showCustom && description && <p className="text-xs text-slate-400">{description}</p>}
      <p className="text-[11px] text-slate-500">{t(catalog.source === 'LIVE' ? 'agentCenter.models.sourceLive' : 'agentCenter.models.sourceBuiltIn')}</p>
    </div>
  );
};
