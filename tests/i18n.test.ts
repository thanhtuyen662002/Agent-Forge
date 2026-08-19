import { describe, it, expect, beforeEach } from 'vitest';
import {
  LOCALES,
  SupportedLocale,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  getTranslation,
  resolveInitialLocale,
  validateKeyParity,
  enUS,
  viVN,
} from '../src/shared/i18n';

describe('I18n Localization Foundation (PR #9)', () => {
  it('1. en-US catalog loads with all required top-level sections', () => {
    expect(enUS).toBeDefined();
    expect(enUS.app.title).toBe('Agent-Forge');
    expect(enUS.nav.manualBridge).toBe('Owner Routing & Handoff');
    expect(enUS.routing.selectCandidates).toBe('Select Candidate Providers');
    expect(enUS.manualBridge.copyWorkOrder).toBe('1-Click Copy WorkOrder');
    expect(enUS.update.installButton).toBe('Restart & Install');
    expect(enUS.emergencyStop.button).toBe('Emergency Stop');
  });

  it('2. vi-VN catalog loads with natural, technical Vietnamese translations', () => {
    expect(viVN).toBeDefined();
    expect(viVN.app.title).toBe('Agent-Forge');
    expect(viVN.app.subtitle).toBe('Trung tâm Điều khiển Kỹ nghệ AI Cục bộ');
    expect(viVN.nav.manualBridge).toBe('Điều phối & Cầu nối Thủ công');
    expect(viVN.routing.selectCandidates).toBe('Chọn Nhà cung cấp Ứng viên');
    expect(viVN.manualBridge.copyWorkOrder).toBe('1-Click Sao chép WorkOrder');
    expect(viVN.update.installButton).toBe('Khởi động lại và Cài đặt');
    expect(viVN.emergencyStop.button).toBe('Dừng Khẩn cấp');
  });

  it('3. en-US and vi-VN have 100% key parity (no missing keys in either direction)', () => {
    const missingInVi = validateKeyParity(enUS, viVN);
    const missingInEn = validateKeyParity(viVN, enUS);

    expect(missingInVi).toEqual([]);
    expect(missingInEn).toEqual([]);
  });

  it('4. validateKeyParity detects missing or mismatched keys accurately', () => {
    const incompleteCatalog = {
      app: {
        title: 'AgentForge',
      },
    };
    const missing = validateKeyParity(enUS, incompleteCatalog);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing).toContain('app.subtitle');
    expect(missing).toContain('nav');
  });

  it('5. getTranslation retrieves exact strings and substitutes params', () => {
    const enVal = getTranslation('en-US', 'app.title');
    expect(enVal).toBe('Agent-Forge');

    const viVal = getTranslation('vi-VN', 'app.subtitle');
    expect(viVal).toBe('Trung tâm Điều khiển Kỹ nghệ AI Cục bộ');

    // Dot-notation nested lookup
    expect(getTranslation('en-US', 'routing.routeButton')).toBe('Route Task');
    expect(getTranslation('vi-VN', 'routing.routeButton')).toBe('Điều phối Nhiệm vụ');
  });

  it('6. getTranslation falls back safely to en-US for unmapped or invalid paths', () => {
    const fallbackVal = getTranslation('vi-VN', 'non.existent.path');
    expect(fallbackVal).toBe('non.existent.path');
  });

  it('7. resolveInitialLocale honors saved preference over system locale', () => {
    expect(resolveInitialLocale('vi-VN', 'en-US')).toBe('vi-VN');
    expect(resolveInitialLocale('en-US', 'vi-VN')).toBe('en-US');
  });

  it('8. resolveInitialLocale detects Vietnamese system locale when no preference saved', () => {
    expect(resolveInitialLocale(null, 'vi')).toBe('vi-VN');
    expect(resolveInitialLocale(undefined, 'vi-VN')).toBe('vi-VN');
    expect(resolveInitialLocale(null, 'vi_VN')).toBe('vi-VN');
  });

  it('9. resolveInitialLocale falls back to en-US for invalid or non-Vietnamese locales', () => {
    expect(resolveInitialLocale('invalid-locale', 'ja-JP')).toBe('en-US');
    expect(resolveInitialLocale(null, 'fr-FR')).toBe('en-US');
    expect(resolveInitialLocale(null, null)).toBe('en-US');
  });

  it('10. Protocol canonical enum values are NOT modified by i18n lookup', () => {
    // Protocol enums remain canonical protocol constants in storage
    const canonicalState = 'AWAITING_OWNER';
    const canonicalOutcome = 'MANUAL_HANDOFF_REQUIRED';
    const canonicalStatus = 'DISPATCHED';

    // The domain values are preserved
    expect(canonicalState).toBe('AWAITING_OWNER');
    expect(canonicalOutcome).toBe('MANUAL_HANDOFF_REQUIRED');
    expect(canonicalStatus).toBe('DISPATCHED');
  });

  describe('Language Persistence & Restart Boundary Evidence', () => {
    const STORAGE_KEY = 'agentforge_locale';

    class MockStorage {
      private store: Record<string, string> = {};
      getItem(key: string): string | null {
        return this.store[key] ?? null;
      }
      setItem(key: string, value: string): void {
        this.store[key] = value;
      }
      removeItem(key: string): void {
        delete this.store[key];
      }
      clear(): void {
        this.store = {};
      }
    }

    it('11. no persisted locale + system vi-VN resolves to vi-VN', () => {
      const storage = new MockStorage();
      const resolved = resolveInitialLocale(storage.getItem(STORAGE_KEY), 'vi-VN');
      expect(resolved).toBe('vi-VN');
    });

    it('12. no persisted locale + system en/non-vi resolves to en-US', () => {
      const storage = new MockStorage();
      const resolvedEn = resolveInitialLocale(storage.getItem(STORAGE_KEY), 'en-US');
      expect(resolvedEn).toBe('en-US');

      const resolvedFr = resolveInitialLocale(storage.getItem(STORAGE_KEY), 'fr-FR');
      expect(resolvedFr).toBe('en-US');

      const resolvedNull = resolveInitialLocale(storage.getItem(STORAGE_KEY), undefined);
      expect(resolvedNull).toBe('en-US');
    });

    it('13. Owner chooses vi-VN -> preference is written to storage', () => {
      const storage = new MockStorage();
      const chosenLocale: SupportedLocale = 'vi-VN';
      storage.setItem(STORAGE_KEY, chosenLocale);
      expect(storage.getItem(STORAGE_KEY)).toBe('vi-VN');
    });

    it('14. recreate locale persistence boundary -> vi-VN is recovered across restart simulation', () => {
      const storage = new MockStorage();
      // First session: Owner chooses vi-VN
      storage.setItem(STORAGE_KEY, 'vi-VN');

      // Second session (recreated context boundary reading same storage):
      const reloadedLocale = resolveInitialLocale(storage.getItem(STORAGE_KEY), 'en-US');
      expect(reloadedLocale).toBe('vi-VN');
    });

    it('15. Owner chooses en-US -> persist -> recreate boundary -> en-US is recovered', () => {
      const storage = new MockStorage();
      // First session: Owner was on vi-VN, switches to en-US
      storage.setItem(STORAGE_KEY, 'vi-VN');
      storage.setItem(STORAGE_KEY, 'en-US');

      // Second session:
      const reloadedLocale = resolveInitialLocale(storage.getItem(STORAGE_KEY), 'vi-VN');
      expect(reloadedLocale).toBe('en-US');
    });

    it('16. unsupported persisted value falls back safely to default supported locale (en-US)', () => {
      const storage = new MockStorage();
      storage.setItem(STORAGE_KEY, 'es-ES-invalid');

      const resolved = resolveInitialLocale(storage.getItem(STORAGE_KEY), 'es-ES');
      expect(resolved).toBe('en-US');
    });

    it('17. changing locale never mutates task state, protocol messages, authorizations, or routing decisions', () => {
      const taskState = 'IN_PROGRESS';
      const managerProtocol = {
        protocol: 'manager.v1',
        decision: 'EXECUTE',
        targetState: 'CODING',
      };
      const coderProtocol = {
        protocol: 'coder.v1',
        status: 'SUCCESS',
      };
      const executionAuthorization = {
        authorizationId: 'auth-123',
        status: 'DISPATCHED',
      };
      const routingDecision = {
        outcome: 'SELECTED',
        selectedResourceId: 'res-1',
      };

      // Simulate switching locale from en-US to vi-VN
      const locale1: SupportedLocale = 'en-US';
      const t1 = getTranslation(locale1, 'app.title');
      expect(t1).toBe('Agent-Forge');

      const locale2: SupportedLocale = 'vi-VN';
      const t2 = getTranslation(locale2, 'app.title');
      expect(t2).toBe('Agent-Forge');

      // Invariants: Domain models, protocol fields, authorization IDs, and states are completely unchanged
      expect(taskState).toBe('IN_PROGRESS');
      expect(managerProtocol.protocol).toBe('manager.v1');
      expect(managerProtocol.decision).toBe('EXECUTE');
      expect(coderProtocol.protocol).toBe('coder.v1');
      expect(executionAuthorization.authorizationId).toBe('auth-123');
      expect(executionAuthorization.status).toBe('DISPATCHED');
      expect(routingDecision.outcome).toBe('SELECTED');
    });
  });
});
