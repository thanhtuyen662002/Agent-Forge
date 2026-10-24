import { useCallback, useEffect, useRef, useState } from 'react';

export type SignInState = 'WAITING_FOR_USER' | 'SIGNED_IN' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
const STATES = new Set<SignInState>(['WAITING_FOR_USER', 'SIGNED_IN', 'FAILED', 'CANCELLED', 'TIMED_OUT']);
const TERMINAL = new Set<SignInState>(['SIGNED_IN', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

export interface SignInView {
  sessionId: string | null;
  state: SignInState | 'STARTING' | 'START_FAILED';
  userCode: string | null;
  verificationUrl: string | null;
  errorCode: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const shortText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;

export function normalizeStartReply(reply: unknown): SignInView {
  if (isRecord(reply) && reply.success === true && shortText(reply.sessionId, 128) && shortText(reply.userCode, 32) &&
      shortText(reply.verificationUrl, 512) && /^https:\/\//i.test(reply.verificationUrl)) {
    return { sessionId: reply.sessionId, state: 'WAITING_FOR_USER', userCode: reply.userCode, verificationUrl: reply.verificationUrl, errorCode: null };
  }
  const code = isRecord(reply) && shortText(reply.errorCode, 64) ? reply.errorCode : 'INVALID_RESPONSE';
  return { sessionId: null, state: 'START_FAILED', userCode: null, verificationUrl: null, errorCode: code };
}

/**
 * Codex device-code sign-in for one account. The renderer never handles
 * tokens: it shows the one-time code and asks the main process to open the
 * verification page it already holds for this session.
 */
export function useAccountSignIn(onSignedIn: () => Promise<void>) {
  const api = typeof window !== 'undefined' ? (window as any).orchestrator ?? null : null;
  const [view, setView] = useState<SignInView | null>(null);
  const viewRef = useRef<SignInView | null>(null);
  viewRef.current = view;

  const start = useCallback(async (accountId: string) => {
    if (!api?.startCodexSignIn) return;
    setView({ sessionId: null, state: 'STARTING', userCode: null, verificationUrl: null, errorCode: null });
    try {
      setView(normalizeStartReply(await api.startCodexSignIn(accountId)));
    } catch {
      setView(normalizeStartReply(null));
    }
  }, [api]);

  useEffect(() => {
    const sessionId = view?.sessionId;
    if (!api?.getCodexSignInStatus || !sessionId || view?.state !== 'WAITING_FOR_USER') return undefined;
    const handle = setInterval(async () => {
      try {
        const reply = await api.getCodexSignInStatus(sessionId);
        if (!isRecord(reply) || reply.success !== true || !isRecord(reply.status)) return;
        const state = reply.status.state as SignInState;
        if (!STATES.has(state) || viewRef.current?.sessionId !== sessionId) return;
        setView((current) => current && { ...current, state, errorCode: typeof reply.status === 'object' && typeof (reply.status as any).errorCode === 'string' ? (reply.status as any).errorCode : null });
        if (state === 'SIGNED_IN') { try { await onSignedIn(); } catch { /* own UI channel */ } }
      } catch { /* keep polling; the session has its own timeout */ }
    }, 2_000);
    return () => clearInterval(handle);
  }, [api, view?.sessionId, view?.state, onSignedIn]);

  const cancel = useCallback(async () => {
    const current = viewRef.current;
    if (current?.sessionId && current.state === 'WAITING_FOR_USER') {
      try { await api?.cancelCodexSignIn(current.sessionId); } catch { /* best effort; main process times out */ }
    }
    setView(null);
  }, [api]);

  const openPage = useCallback(async () => {
    const current = viewRef.current;
    if (current?.sessionId) { try { await api?.openCodexSignInPage(current.sessionId); } catch { /* shown via state */ } }
  }, [api]);

  return {
    available: Boolean(api?.startCodexSignIn),
    view,
    terminal: view ? TERMINAL.has(view.state as SignInState) || view.state === 'START_FAILED' : false,
    start,
    cancel,
    openPage,
    close: () => setView(null),
  };
}
