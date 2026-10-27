import React, { useCallback, useEffect, useState } from 'react';
import { Copy, Eye, EyeOff, Plug, RefreshCw } from 'lucide-react';
import { useI18n } from '../context/I18nContext';

export interface McpSettingsView {
  enabled: boolean;
  running: boolean;
  url: string;
  token: string;
  errorCode: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Accepts only a well-formed `mcp:*` reply; anything else is "unknown". */
export function normalizeMcpReply(reply: unknown): McpSettingsView | null {
  if (!isRecord(reply) || reply.success !== true || !isRecord(reply.settings)) return null;
  const s = reply.settings;
  if (typeof s.enabled !== 'boolean' || typeof s.running !== 'boolean' || typeof s.url !== 'string' || typeof s.token !== 'string') return null;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/mcp$/.test(s.url)) return null;
  return {
    enabled: s.enabled, running: s.running, url: s.url, token: s.token,
    errorCode: typeof s.errorCode === 'string' && /^[A-Z_]{1,64}$/.test(s.errorCode) ? s.errorCode : null,
  };
}

export const claudeCommand = (settings: Pick<McpSettingsView, 'url' | 'token'>) =>
  `claude mcp add --transport http --scope user agent-forge ${settings.url} --header "Authorization: Bearer ${settings.token}"`;

export const codexConfig = (settings: Pick<McpSettingsView, 'url'>) =>
  `[mcp_servers.agent_forge]\nurl = "${settings.url}"\nbearer_token_env_var = "AGENT_FORGE_MCP_TOKEN"`;

export const codexTokenCommand = (settings: Pick<McpSettingsView, 'token'>) => `setx AGENT_FORGE_MCP_TOKEN "${settings.token}"`;

const ERRORS = new Set(['PORT_IN_USE', 'START_FAILED']);

/**
 * Settings → external AI connection (#289): the owner turns the local MCP
 * server on and copies the ready-made connection for Claude Code or Codex.
 */
export const ExternalAiConnectionPanel: React.FC = () => {
  const { t } = useI18n();
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [settings, setSettings] = useState<McpSettingsView | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const apply = (reply: unknown) => {
    const next = normalizeMcpReply(reply);
    setFailed(!next);
    if (next) setSettings(next);
  };
  const load = useCallback(async () => {
    if (!api?.getMcpSettings) return;
    try { apply(await api.getMcpSettings()); } catch { setFailed(true); }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { apply(await action()); } catch { setFailed(true); } finally { setBusy(false); }
  };
  const copy = async (key: string, value: string) => {
    try { await navigator.clipboard.writeText(value); setCopied(key); setTimeout(() => setCopied(null), 2000); } catch { setCopied(null); }
  };

  if (!api?.getMcpSettings) return null;
  const masked = settings ? `${settings.token.slice(0, 4)}${'•'.repeat(16)}` : '';
  const shownToken = settings ? (showToken ? settings.token : masked) : '';
  const view = settings ? { url: settings.url, token: shownToken } : null;

  const block = (key: string, label: string, value: string, copyValue: string) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-slate-400">{label}</span>
        <button type="button" onClick={() => void copy(key, copyValue)}
          className="text-[11px] text-forge-cyan hover:text-cyan-300 flex items-center gap-1">
          <Copy className="w-3 h-3" aria-hidden="true" />{copied === key ? t('externalAi.copied') : t('externalAi.copy')}
        </button>
      </div>
      <pre className="bg-surface border border-surface-border rounded-lg px-3 py-2 text-[11px] text-slate-200 whitespace-pre-wrap break-all">{value}</pre>
    </div>
  );

  return (
    <div className="bg-surface-card border border-surface-border rounded-xl p-6 shadow-lg space-y-4">
      <h3 className="text-xs font-mono font-semibold text-slate-300 uppercase tracking-wider flex items-center space-x-2">
        <Plug className="w-4 h-4 text-forge-cyan" aria-hidden="true" />
        <span>{t('externalAi.title')}</span>
      </h3>
      <p className="text-xs text-slate-400">{t('externalAi.subtitle')}</p>

      <label className="flex items-start gap-2 text-xs text-slate-200">
        <input type="checkbox" className="mt-0.5" checked={settings?.enabled ?? false} disabled={busy || !settings}
          onChange={(event) => void run(() => api.setMcpEnabled(event.target.checked))} />
        <span>{t('externalAi.toggle')}</span>
      </label>
      <p className="text-[11px] text-amber-300">{t('externalAi.warning')}</p>

      {failed && <p role="alert" className="text-xs text-rose-300">{t('externalAi.unavailable')}</p>}
      {settings?.enabled && (
        <p role="status" className={`text-xs ${settings.running ? 'text-emerald-300' : 'text-rose-300'}`}>
          {settings.running
            ? t('externalAi.running', { url: settings.url })
            : t(`externalAi.errors.${settings.errorCode && ERRORS.has(settings.errorCode) ? settings.errorCode : 'OTHER'}`)}
        </p>
      )}

      {settings?.enabled && view && (
        <div className="space-y-4 pt-2 border-t border-surface-border">
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
            <span>{t('externalAi.token')}:</span>
            <code className="text-slate-200">{shownToken}</code>
            <button type="button" onClick={() => setShowToken((value) => !value)} className="text-forge-cyan flex items-center gap-1">
              {showToken ? <EyeOff className="w-3 h-3" aria-hidden="true" /> : <Eye className="w-3 h-3" aria-hidden="true" />}
              {showToken ? t('externalAi.hide') : t('externalAi.show')}
            </button>
            <button type="button" disabled={busy} onClick={() => void run(() => api.regenerateMcpToken())} className="text-forge-cyan flex items-center gap-1 disabled:opacity-40">
              <RefreshCw className="w-3 h-3" aria-hidden="true" />{t('externalAi.regenerate')}
            </button>
          </div>
          {block('claude', t('externalAi.claudeLabel'), claudeCommand(view), claudeCommand(settings))}
          {block('codexToken', t('externalAi.codexTokenLabel'), codexTokenCommand(view), codexTokenCommand(settings))}
          {block('codexConfig', t('externalAi.codexConfigLabel'), codexConfig(settings), codexConfig(settings))}
          <p className="text-[11px] text-slate-400">{t('externalAi.tryIt')}</p>
        </div>
      )}
    </div>
  );
};
