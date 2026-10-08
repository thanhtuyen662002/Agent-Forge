import React, { useState, useEffect, useRef } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { ShieldAlert, AlertTriangle, X, Check } from 'lucide-react';
import { AccessibleDialog } from './AccessibleDialog';
import { UiEmergencyObservation, UiActionFailure, normalizeObservationResult, isEmergencyObservation, uiActionFailureKey } from '../actionState';

export const EmergencyStopModal: React.FC = () => {
  const { isEmergencyStopOpen, setIsEmergencyStopOpen, triggerEmergencyStop, isElectron, pendingActions } = useOrchestrator();
  const { t } = useI18n();
  const [reason, setReason] = useState<string>('Manual Owner Emergency Stop');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [stopResult, setStopResult] = useState<UiEmergencyObservation | null>(null);
  const [failure, setFailure] = useState<UiActionFailure | null>(null);
  const inFlight = useRef(false);
  const session = useRef(0);
  const currentOpen = useRef(isEmergencyStopOpen);
  if (currentOpen.current !== isEmergencyStopOpen) {
    currentOpen.current = isEmergencyStopOpen;
    session.current += 1;
  }
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setStopResult(null); setFailure(null); }, [isEmergencyStopOpen]);
  const processing = isProcessing || (pendingActions ?? []).includes('emergencyStop');

  if (!isEmergencyStopOpen) return null;

  const handleConfirm = async () => {
    if (inFlight.current || processing) return;
    if (!isElectron) { setFailure('DESKTOP_REQUIRED'); return; }
    const requestedSession = session.current;
    inFlight.current = true;
    setIsProcessing(true);
    setFailure(null);
    try {
      const result = normalizeObservationResult(await triggerEmergencyStop(reason), isEmergencyObservation);
      if (mounted.current && currentOpen.current && requestedSession === session.current) {
        if (result.success) setStopResult(result.data);
        else setFailure(result.code);
      }
    } catch {
      if (mounted.current && currentOpen.current && requestedSession === session.current) setFailure('IPC_REJECTED');
    } finally {
      inFlight.current = false;
      if (mounted.current) setIsProcessing(false);
    }
  };

  const handleClose = () => {
    if (processing || inFlight.current) return;
    setStopResult(null);
    setFailure(null);
    setIsEmergencyStopOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <AccessibleDialog onDismiss={handleClose} dismissible={!processing} aria-busy={processing} aria-labelledby="emergency-stop-title" className="bg-surface border-2 border-rose-600/80 rounded-xl shadow-2xl max-w-lg w-full overflow-hidden glow-rose">
        {/* Modal Header */}
        <div className="bg-rose-950/40 border-b border-rose-800/40 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3 text-rose-400">
            <ShieldAlert className="w-6 h-6 shrink-0" />
            <h2 id="emergency-stop-title" className="font-mono font-bold text-lg tracking-wide uppercase">{t('emergencyStop.modalTitle')}</h2>
          </div>
          <button
            type="button"
            aria-label={t('common.close')}
            disabled={processing}
            onClick={handleClose}
            className="text-slate-400 hover:text-white p-1 rounded-md transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-6 space-y-4 text-sm text-slate-200">
          {!stopResult ? (
            <>
              {!isElectron && <p id="emergency-availability" className="text-xs text-slate-400">{t('actions.desktopRequired')}</p>}
              {failure && <p role="alert" className="text-xs text-rose-300">{t(uiActionFailureKey(failure))}</p>}
              <div className="flex items-start space-x-3 p-3.5 bg-rose-950/20 border border-rose-900/40 rounded-lg text-xs text-rose-200">
                <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <p>
                  {t('emergencyStop.modalDesc')}
                </p>
              </div>

              <div>
                <label htmlFor="emergency-stop-reason" className="block text-xs font-mono text-slate-400 mb-1.5">{t('emergencyStop.reasonLabel')}:</label>
                <input
                  id="emergency-stop-reason"
                  disabled={processing}
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  className="w-full bg-surface-card border border-surface-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-rose-500 font-mono"
                  placeholder={t('emergencyStop.reasonPlaceholder')}
                />
              </div>

              <div className="text-xs text-slate-400 space-y-1 font-mono">
                <div>• {t('emergencyStop.bulletSigkill')}</div>
                <div>• {t('emergencyStop.bulletPreserveDb')}</div>
                <div>• {t('emergencyStop.bulletResume')}</div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-end space-x-3 pt-4 border-t border-surface-border">
                <button
                  data-dialog-initial-focus
                  type="button"
                  onClick={handleClose}
                  disabled={processing}
                  className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 text-xs font-semibold rounded-lg transition"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={handleConfirm}
                  disabled={processing || !isElectron}
                  aria-busy={processing}
                  aria-describedby={!isElectron ? 'emergency-availability' : undefined}
                  className="px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white font-mono font-bold text-xs rounded-lg shadow-lg shadow-rose-950/80 flex items-center space-x-2 transition"
                >
                  <ShieldAlert className="w-4 h-4" />
                  <span>{processing ? t('emergencyStop.terminating') : t('emergencyStop.confirm').toUpperCase()}</span>
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div role={stopResult.allTerminatedProven ? 'status' : 'alert'} className="flex items-center space-x-3 p-3 bg-surface-card border border-surface-border rounded-lg">
                {stopResult.allTerminatedProven ? <Check className="w-5 h-5 shrink-0 text-emerald-400" /> : <AlertTriangle className="w-5 h-5 shrink-0 text-amber-400" />}
                <span className="font-semibold text-xs">{t(stopResult.allTerminatedProven ? 'emergencyStop.successNotice' : 'emergencyStop.unconfirmedNotice', { count: stopResult.unprovenProcesses })}</span>
              </div>

              <div className="bg-surface-card p-4 rounded-lg border border-surface-border space-y-2 text-xs font-mono">
                <div>{t('emergencyStop.processesTerminated')}: <strong className="text-white">{stopResult.processesTerminated}</strong></div>
                <div>{t('emergencyStop.tasksPaused')}: <strong className="text-white">{stopResult.tasksPaused}</strong></div>
                <div>{t('emergencyStop.projectsPaused')}: <strong className="text-white">{stopResult.projectsPaused}</strong></div>
                <div>{t('emergencyStop.unprovenProcesses')}: <strong className="text-white">{stopResult.unprovenProcesses}</strong></div>
                <div>{t('emergencyStop.timestamp')}: <span className="text-slate-400">{stopResult.timestamp}</span></div>
              </div>

              <div className="flex justify-end pt-2">
                <button
                  onClick={handleClose}
                  className="px-5 py-2 bg-surface-card hover:bg-surface-border text-white text-xs font-semibold rounded-lg transition"
                >
                  {t('common.close')}
                </button>
              </div>
            </div>
          )}
        </div>
      </AccessibleDialog>
    </div>
  );
};
