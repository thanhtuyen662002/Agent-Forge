import React, { useState } from 'react';
import { ExternalLink, Copy } from 'lucide-react';
import { useI18n } from '../context/I18nContext';
import { AccessibleDialog } from './AccessibleDialog';
import type { SignInView } from '../accountSignIn';

interface SignInDialogProps {
  agentName: string;
  view: SignInView;
  terminal: boolean;
  onOpenPage: () => void;
  onCancel: () => void;
  onClose: () => void;
}

const KNOWN_ERRORS = new Set([
  'ACCOUNT_NOT_FOUND', 'NOT_A_CODEX_ACCOUNT', 'PROFILE_UNAVAILABLE', 'CODEX_UNAVAILABLE',
  'LOGIN_ALREADY_IN_PROGRESS', 'PROTOCOL_ERROR', 'TIMEOUT', 'SIGN_IN_UNAVAILABLE',
]);

/** Device-code sign-in: shows only the one-time code; tokens never reach the renderer. */
export const SignInDialog: React.FC<SignInDialogProps> = ({ agentName, view, terminal, onOpenPage, onCancel, onClose }) => {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!view.userCode) return;
    try { await navigator.clipboard.writeText(view.userCode); setCopied(true); } catch { setCopied(false); }
  };
  const errorText = view.state === 'START_FAILED'
    ? t(`accountSignIn.errors.${view.errorCode && KNOWN_ERRORS.has(view.errorCode) ? view.errorCode : 'INVALID_RESPONSE'}`)
    : view.state === 'FAILED' || view.state === 'CANCELLED' || view.state === 'TIMED_OUT'
      ? t(`accountSignIn.states.${view.state}`) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <AccessibleDialog
        onDismiss={terminal ? onClose : onCancel}
        aria-labelledby="sign-in-title"
        className="bg-surface border border-surface-border rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4"
      >
        <h3 id="sign-in-title" className="text-base font-bold text-white">{t('accountSignIn.title', { name: agentName })}</h3>
        {view.state === 'STARTING' && <p role="status" className="text-sm text-slate-300">{t('accountSignIn.starting')}</p>}
        {view.state === 'WAITING_FOR_USER' && view.userCode && (
          <div className="space-y-3">
            <p className="text-sm text-slate-300">{t('accountSignIn.instructions')}</p>
            <p className="text-2xl font-mono font-bold tracking-widest text-forge-cyan text-center select-all" aria-label={view.userCode}>{view.userCode}</p>
            <div className="flex flex-wrap justify-center gap-2">
              <button type="button" data-dialog-initial-focus onClick={onOpenPage}
                className="px-4 py-2 bg-forge-cyan hover:bg-cyan-600 text-slate-950 font-bold rounded-lg text-xs flex items-center gap-1.5">
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t('accountSignIn.openPage')}</span>
              </button>
              <button type="button" onClick={() => void copy()}
                className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-200 rounded-lg text-xs flex items-center gap-1.5">
                <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{t('accountSignIn.copyCode')}</span>
              </button>
            </div>
            {copied && <p role="status" className="text-xs text-emerald-300 text-center">{t('accountSignIn.copied')}</p>}
            <p role="status" className="text-xs text-slate-400">{t('accountSignIn.waiting')}</p>
            <p className="text-xs text-slate-500">{t('accountSignIn.privacy')}</p>
          </div>
        )}
        {view.state === 'SIGNED_IN' && <p role="status" className="text-sm text-emerald-300">{t('accountSignIn.signedIn')}</p>}
        {errorText && <p role="alert" className="text-sm text-rose-300">{errorText}</p>}
        <div className="flex justify-end gap-3 pt-3 border-t border-surface-border">
          {terminal ? (
            <button type="button" onClick={onClose} className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs">
              {t('accountSignIn.close')}
            </button>
          ) : (
            <button type="button" onClick={onCancel} className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 rounded-lg text-xs">
              {t('accountSignIn.cancel')}
            </button>
          )}
        </div>
      </AccessibleDialog>
    </div>
  );
};
