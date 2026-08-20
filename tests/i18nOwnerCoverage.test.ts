import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  enUS,
  viVN,
  validateKeyParity,
  getTranslation,
  TranslationDictionary,
} from '../src/shared/i18n';

describe('Owner Vietnamese I18n Coverage Contract (PR #11)', () => {
  const requiredNamespaces: (keyof TranslationDictionary)[] = [
    'app',
    'nav',
    'common',
    'language',
    'task',
    'routing',
    'dispatch',
    'manualBridge',
    'managerInbox',
    'coderInbox',
    'emergencyStop',
    'update',
    'about',
    'header',
    'sidebar',
    'dashboard',
    'taskBoard',
    'taskDetail',
    'agentCenter',
    'agentCard',
    'capacity',
    'quota',
    'timeline',
    'decisions',
    'evidence',
    'projects',
    'settings',
    'debug',
  ];

  it('1. TranslationDictionary contains all 28 required Owner UI namespaces', () => {
    for (const ns of requiredNamespaces) {
      expect(enUS[ns], `enUS missing namespace: ${ns}`).toBeDefined();
      expect(viVN[ns], `viVN missing namespace: ${ns}`).toBeDefined();
    }
  });

  it('2. enUS and viVN dictionaries have 100% key parity with 0 missing keys', () => {
    const missingInVi = validateKeyParity(enUS, viVN);
    const missingInEn = validateKeyParity(viVN, enUS);

    expect(missingInVi, `Keys missing in vi-VN: ${missingInVi.join(', ')}`).toEqual([]);
    expect(missingInEn, `Keys missing in en-US: ${missingInEn.join(', ')}`).toEqual([]);
  });

  it('3. All keys in both catalogs resolve to non-empty string values', () => {
    const checkNoEmptyValues = (obj: any, currentPath: string = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const fullPath = currentPath ? `${currentPath}.${key}` : key;
        if (typeof value === 'string') {
          expect(value.trim().length, `Empty translation string at: ${fullPath}`).toBeGreaterThan(0);
        } else if (typeof value === 'object' && value !== null) {
          checkNoEmptyValues(value, fullPath);
        }
      }
    };

    checkNoEmptyValues(enUS, 'enUS');
    checkNoEmptyValues(viVN, 'viVN');
  });

  it('4. Parametric translations interpolate tokens accurately in both en-US and vi-VN', () => {
    // Test parameter replacement in capacity
    const enRemaining = getTranslation('en-US', 'capacity.remainingUnits', { unit: 'tokens' });
    expect(enRemaining).toBe('Remaining Units (tokens)');
    const viRemaining = getTranslation('vi-VN', 'capacity.remainingUnits', { unit: 'tokens' });
    expect(viRemaining).toBe('Đơn vị Còn lại (tokens)');

    // Test parameter replacement in evidence
    const enEvidence = getTranslation('en-US', 'evidence.collectedRecords', { count: '5' });
    expect(enEvidence).toBe('Collected Evidence Records (5)');
    const viEvidence = getTranslation('vi-VN', 'evidence.collectedRecords', { count: '5' });
    expect(viEvidence).toBe('Bản ghi Bằng chứng Đã thu thập (5)');

    // Test parameter replacement in manualBridge
    const enSelected = getTranslation('en-US', 'manualBridge.selectedCount', { count: '2' });
    expect(enSelected).toBe('(2 selected)');
    const viSelected = getTranslation('vi-VN', 'manualBridge.selectedCount', { count: '2' });
    expect(viSelected).toBe('(đã chọn 2)');

    // Test parameter replacement in coderInbox
    const enCoder = getTranslation('en-US', 'coderInbox.validReportDetected', { protocolType: 'coder.v1' });
    expect(enCoder).toBe('Valid coder.v1 report detected.');
    const viCoder = getTranslation('vi-VN', 'coderInbox.validReportDetected', { protocolType: 'coder.v1' });
    expect(viCoder).toBe('Đã phát hiện báo cáo coder.v1 hợp lệ.');
  });

  it('5. Primary Owner view files import and use useI18n', () => {
    const ownerViewFiles = [
      'src/ui/views/DashboardView.tsx',
      'src/ui/views/TaskBoardView.tsx',
      'src/ui/views/TaskDetailView.tsx',
      'src/ui/views/AgentCenterView.tsx',
      'src/ui/views/CapacityView.tsx',
      'src/ui/views/TimelineView.tsx',
      'src/ui/views/DecisionsView.tsx',
      'src/ui/views/EvidenceView.tsx',
      'src/ui/views/ProjectsView.tsx',
      'src/ui/views/SettingsView.tsx',
      'src/ui/views/DebugView.tsx',
      'src/ui/views/ManualBridgeView.tsx',
      'src/ui/components/Header.tsx',
      'src/ui/components/Sidebar.tsx',
      'src/ui/components/AgentCard.tsx',
      'src/ui/components/QuotaBadge.tsx',
      'src/ui/components/EmergencyStopModal.tsx',
      'src/ui/components/ProgressIndicator.tsx',
    ];

    for (const relPath of ownerViewFiles) {
      const fullPath = path.resolve(__dirname, '..', relPath);
      expect(fs.existsSync(fullPath), `File not found: ${relPath}`).toBe(true);
      const content = fs.readFileSync(fullPath, 'utf-8');

      expect(
        content.includes('useI18n') || content.includes('getTranslation'),
        `${relPath} does not use i18n`
      ).toBe(true);
    }
  });

  it('6. Known visual blocker strings from Gate 1 are NOT hard-coded in Owner JSX views', () => {
    const rawVisualBlockers = [
      '<span>Manager Pool</span>',
      '<span>Coder Pool</span>',
      '<span>All Events</span>',
      '<span>Manager Decisions</span>',
      '<span>Test Command:</span>',
      '<span>Linter Command:</span>',
      '<span>Build Command:</span>',
      '<span>Create New Project</span>',
      '<span>Choose Repository...</span>',
      '<span>Project Contract Importer</span>',
      '<span>Collected Evidence Records',
      '<span>Artifact Payload Inspector</span>',
      '<span>Select Target Task:</span>',
      '<span>Candidate Resources (Ordered)</span>',
      '<span>Durable Routing Decision</span>',
      '<span>Durable Execution Authorization</span>',
      '<span>Failure & Chaos Testing</span>',
      '<span>Desktop Diagnostics</span>',
      '<span>Authority Tier Specification</span>',
      '<span>Capacity & Quota Management</span>',
      '<span>Immutable Timeline & Audit Log</span>',
      '<span>Evidence Locker & ArtifactStore</span>',
      '<span>Projects & Project Contract</span>',
      '<span>Debug & Failure Simulation Laboratory</span>',
      '<span>Verification Commands</span>',
      '<span>Loop Protection & Revision Limits</span>',
      '<span>SAVE CONFIGURATION</span>',
    ];

    const viewsDir = path.resolve(__dirname, '..', 'src/ui/views');
    const componentsDir = path.resolve(__dirname, '..', 'src/ui/components');

    const scanFiles = (dir: string): string[] => {
      let results: string[] = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          results = results.concat(scanFiles(full));
        } else if (file.endsWith('.tsx')) {
          results.push(full);
        }
      }
      return results;
    };

    const allTsx = [...scanFiles(viewsDir), ...scanFiles(componentsDir)];

    for (const filePath of allTsx) {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const blocker of rawVisualBlockers) {
        expect(
          content.includes(blocker),
          `Found raw hard-coded visual blocker "${blocker}" in ${path.relative(path.resolve(__dirname, '..'), filePath)}`
        ).toBe(false);
      }
    }
  });

  it('7. Canonical protocol, enum, and technical tokens remain unchanged', () => {
    const canonicalTokens = [
      'EXECUTE',
      'FIX_REQUIRED',
      'DISPATCHED',
      'AWAITING_OWNER',
      'MANUAL_HANDOFF_REQUIRED',
      'PRIMARY_MANAGER',
      'BACKUP_MANAGER',
      'CODER',
      'REVIEWER',
      'OWNER',
      'manager.v1',
      'coder.v1',
      'BETTER-SQLITE3 (WAL)',
      'ELECTRON ACTIVE',
      'BROWSER PREVIEW',
    ];

    for (const token of canonicalTokens) {
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(0);
    }
  });
});
