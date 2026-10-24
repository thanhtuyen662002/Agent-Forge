import React, { useEffect, useState } from 'react';
import { LogIn, ShieldCheck } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { AccessibleDialog } from './AccessibleDialog';

interface CliSignInDialogProps {
  agentName: string;
  accountId: string;
  onVerified: () => Promise<void>;
  onClose: () => void;
}

const KNOWN_ERRORS = new Set(['ACCOUNT_NOT_FOUND', 'NOT_A_SUPPORTED_CLI_ACCOUNT', 'PROFILE_UNAVAILABLE', 'CLI_UNAVAILABLE', 'UNSUPPORTED_PLATFORM', 'SIGN_IN_UNAVAILABLE']);
const KNOWN_REASONS = new Set(['VERIFIED', 'NOT_SIGNED_IN', 'NOT_A_SUBSCRIPTION_LOGIN', 'VERIFY_FAILED', 'ALREADY_IN_USE']);
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Claude Code / Gemini sign-in (#242): the main process opens the CLI's own
 * browser sign-in in a terminal bound to this account's profile; the owner
 * then asks the app to verify it with the CLI's own check. No credential ever
 * reaches the renderer.
 */
export const CliSignInDialog: React.FC<CliSignInDialogProps> = ({ agentName, accountId, onVerified, onClose }) => {
  const { t } = useI18n();
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [opened, setOpened] = useState<'idle' | 'opening' | 'opened'>('idle');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => { setOpened('idle'); setError(null); setReason(null); }, [accountId]);

  const open = async () => {
    setOpened('opening');
    setError(null);
    try {
      const reply = await api?.startCliSignIn(accountId);
      if (isRecord(reply) && reply.success === true) { setOpened('opened'); return; }
      const code = isRecord(reply) && typeof reply.errorCode === 'string' && KNOWN_ERRORS.has(reply.errorCode) ? reply.errorCode : 'SIGN_IN_UNAVAILABLE';
      setError(t(`cliSignIn.errors.${code}`));
    } catch {
      setError(t('cliSignIn.errors.SIGN_IN_UNAVAILABLE'));
    }
    setOpened('idle');
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const reply = await api?.verifyCliSignIn(accountId);
      if (isRecord(reply) && reply.success === true && typeof reply.reasonCode === 'string') {
        setReason(KNOWN_REASONS.has(reply.reasonCode) ? reply.reasonCode : 'VERIFY_FAILED');
        if (reply.verified === true) await onVerified();
      } else {
        const code = isRecord(reply) && typeof reply.errorCode === 'string' && KNOWN_ERRORS.has(reply.errorCode) ? reply.errorCode : 'SIGN_IN_UNAVAILABLE';
        setError(t(`cliSignIn.errors.${code}`));
      }
    } catch {
      setError(t('cliSignIn.errors.SIGN_IN_UNAVAILABLE'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <AccessibleDialog onDismiss={onClose} aria-labelledby="cli-sign-in-title"
        className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
        <h3 id="cli-sign-in-title" className="text-base font-bold text-white">{t('cliSignIn.title', { name: agentName })}</h3>
        <ol className="list-decimal pl-5 text-sm text-slate-300 space-y-1">
          <li>{t('cliSignIn.step1')}</li>
          <li>{t('cliSignIn.step2')}</li>
          <li>{t('cliSignIn.step3')}</li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <button type="button" data-dialog-initial-focus onClick={() => void open()} disabled={opened === 'opening' || busy}
            className="px-4 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5 disabled:opacity-40">
            <LogIn className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{t('cliSignIn.open')}</span>
          </button>
          <button type="button" onClick={() => void verify()} disabled={busy}
            className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-200 rounded-lg text-xs flex items-center gap-1.5 disabled:opacity-40">
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{busy ? t('cliSignIn.verifying') : t('cliSignIn.verify')}</span>
          </button>
        </div>
        {opened === 'opened' && <p role="status" className="text-xs text-slate-400">{t('cliSignIn.opened')}</p>}
        {reason && (
          <p role="status" className={`text-sm ${reason === 'VERIFIED' ? 'text-emerald-300' : 'text-amber-300'}`}>{t(`cliSignIn.reasons.${reason}`)}</p>
        )}
        {error && <p role="alert" className="text-sm text-rose-300">{error}</p>}
        <p className="text-xs text-slate-500">{t('cliSignIn.privacy')}</p>
        <div className="flex justify-end pt-3 border-t border-surface-border">
          <button type="button" onClick={onClose} className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs">
            {t('cliSignIn.close')}
          </button>
        </div>
      </AccessibleDialog>
    </div>
  );
};
