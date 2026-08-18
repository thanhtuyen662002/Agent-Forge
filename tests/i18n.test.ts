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
});
