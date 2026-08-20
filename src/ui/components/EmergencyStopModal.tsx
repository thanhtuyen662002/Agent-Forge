import React, { useState } from 'react';
import { useOrchestrator } from '../context/OrchestratorContext';
import { useI18n } from '../context/I18nContext';
import { ShieldAlert, AlertTriangle, X, Check } from 'lucide-react';

export const EmergencyStopModal: React.FC = () => {
  const { isEmergencyStopOpen, setIsEmergencyStopOpen, triggerEmergencyStop } = useOrchestrator();
  const { t } = useI18n();
  const [reason, setReason] = useState<string>('Manual Owner Emergency Stop');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [stopResult, setStopResult] = useState<any>(null);

  if (!isEmergencyStopOpen) return null;

  const handleConfirm = async () => {
    setIsProcessing(true);
    try {
      const res = await triggerEmergencyStop(reason);
      setStopResult(res);
    } catch (err) {
      console.error('Emergency stop error:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleClose = () => {
    setStopResult(null);
    setIsEmergencyStopOpen(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div className="bg-surface border-2 border-rose-600/80 rounded-xl shadow-2xl max-w-lg w-full overflow-hidden glow-rose">
        {/* Modal Header */}
        <div className="bg-rose-950/40 border-b border-rose-800/40 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-3 text-rose-400">
            <ShieldAlert className="w-6 h-6 shrink-0" />
            <h2 className="font-mono font-bold text-lg tracking-wide uppercase">{t('emergencyStop.modalTitle')}</h2>
          </div>
          <button
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
              <div className="flex items-start space-x-3 p-3.5 bg-rose-950/20 border border-rose-900/40 rounded-lg text-xs text-rose-200">
                <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <p>
                  {t('emergencyStop.modalDesc')}
                </p>
              </div>

              <div>
                <label className="block text-xs font-mono text-slate-400 mb-1.5">{t('emergencyStop.reasonLabel')}:</label>
                <input
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
                  onClick={handleClose}
                  disabled={isProcessing}
                  className="px-4 py-2 bg-surface-card hover:bg-surface-border text-slate-300 text-xs font-semibold rounded-lg transition"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleConfirm}
                  disabled={isProcessing}
                  className="px-5 py-2 bg-rose-600 hover:bg-rose-700 text-white font-mono font-bold text-xs rounded-lg shadow-lg shadow-rose-950/80 flex items-center space-x-2 transition"
                >
                  <ShieldAlert className="w-4 h-4" />
                  <span>{isProcessing ? t('emergencyStop.terminating') : t('emergencyStop.confirm').toUpperCase()}</span>
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center space-x-3 text-emerald-400 p-3 bg-emerald-950/30 border border-emerald-800/40 rounded-lg">
                <Check className="w-5 h-5 shrink-0" />
                <span className="font-semibold text-xs">{t('emergencyStop.successNotice')}</span>
              </div>

              <div className="bg-surface-card p-4 rounded-lg border border-surface-border space-y-2 text-xs font-mono">
                <div>{t('emergencyStop.processesTerminated')}: <strong className="text-white">{stopResult.processesTerminated}</strong></div>
                <div>{t('emergencyStop.tasksPaused')}: <strong className="text-white">{stopResult.tasksPaused?.length || 0}</strong></div>
                <div>{t('emergencyStop.projectsPaused')}: <strong className="text-white">{stopResult.projectsPaused?.length || 0}</strong></div>
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
      </div>
    </div>
  );
};
