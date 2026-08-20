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
import {
  TaskStateEnum,
  AgentRoleEnum,
  DecisionAuthorityEnum,
  UIDensityModeEnum,
} from '../src/core/types/domain';
import {
  ManagerDecisionEnum,
  ManagerProtocolSchema,
  CoderProtocolSchema,
} from '../src/core/types/protocols';

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
    expect(ownerViewFiles.length).toBe(18);

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

    for (const relPath of ownerViewFiles) {
      const fullPath = path.resolve(__dirname, '..', relPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      for (const blocker of rawVisualBlockers) {
        expect(
          content.includes(blocker),
          `Found raw hard-coded visual blocker "${blocker}" in ${relPath}`
        ).toBe(false);
      }
    }
  });

  it('7. Authoritative production domain and protocol definitions contain required canonical tokens', () => {
    // 1. Production runtime enums & zod schema definitions
    const taskStates = TaskStateEnum.options;
    expect(taskStates).toContain('DISPATCHED');
    expect(taskStates).toContain('FIX_REQUIRED');
    expect(taskStates).toContain('HANDOFF_REQUIRED');
    expect(taskStates).toContain('CODING');
    expect(taskStates).toContain('VALIDATING');
    expect(taskStates).toContain('REVIEWING');
    expect(taskStates).toContain('DONE');

    const agentRoles = AgentRoleEnum.options;
    expect(agentRoles).toContain('PRIMARY_MANAGER');
    expect(agentRoles).toContain('CODER');

    const authorities = DecisionAuthorityEnum.options;
    expect(authorities).toContain('OWNER');
    expect(authorities).toContain('PRIMARY_MANAGER');
    expect(authorities).toContain('CODER');

    const densityModes = UIDensityModeEnum.options;
    expect(densityModes).toContain('OWNER');

    const managerDecisions = ManagerDecisionEnum.options;
    expect(managerDecisions).toContain('EXECUTE');
    expect(managerDecisions).toContain('FIX_REQUIRED');

    // 2. Production protocol schema literal shape
    const managerShape = ManagerProtocolSchema.shape;
    expect(managerShape.protocol.value).toBe('manager.v1');

    const coderShape = CoderProtocolSchema.shape;
    expect(coderShape.protocol.value).toBe('coder.v1');

    // 3. Adapter canonical tokens
    const adapterSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/core/adapters/ManualBridgeAdapter.ts'), 'utf-8');
    expect(adapterSource).toContain("'AWAITING_OWNER'");

    // 4. Static inspection of domain.ts, protocols.ts & ProviderRoutingService.ts source files
    const domainSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/core/types/domain.ts'), 'utf-8');
    const protocolsSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/core/types/protocols.ts'), 'utf-8');
    const routingSource = fs.readFileSync(path.resolve(__dirname, '..', 'src/core/services/ProviderRoutingService.ts'), 'utf-8');

    expect(domainSource).toContain("'DISPATCHED'");
    expect(domainSource).toContain("'PRIMARY_MANAGER'");
    expect(domainSource).toContain("'CODER'");
    expect(domainSource).toContain("'OWNER'");

    expect(routingSource).toContain("'SELECTED'");
    expect(routingSource).toContain("'MANUAL_HANDOFF_REQUIRED'");

    expect(protocolsSource).toContain("'manager.v1'");
    expect(protocolsSource).toContain("'EXECUTE'");
    expect(protocolsSource).toContain("'FIX_REQUIRED'");
    expect(protocolsSource).toContain("'coder.v1'");
  });

  it('8. Static scan verifies zero hardcoded English regression strings across all 18 Owner UI files', () => {
    const forbiddenPatterns = [
      'Paste Manager response here',
      'Paste Coder response here',
      'Routing failed without decision',
      'Authorization creation failed',
      'Dispatch execution failed',
      'Error generating authorized work order',
      'Success: Manager decision applied',
      'Verification Error:',
      'Error generating package:',
      '>Notice:<',
      '>Provider:<',
      'conf:',
      '>General Milestone<',
      'Simulating Quota Exhaustion:',
      'Simulating Process Crash:',
      'Simulating Protocol Rejection:',
    ];

    for (const relPath of ownerViewFiles) {
      const fullPath = path.resolve(__dirname, '..', relPath);
      const content = fs.readFileSync(fullPath, 'utf-8');

      for (const pattern of forbiddenPatterns) {
        expect(
          content.includes(pattern),
          `Regression: Found forbidden English copy "${pattern}" in ${relPath}`
        ).toBe(false);
      }
    }
  });

  it('9. Generic placeholder guard: Prevents hardcoded string literals inside placeholder attributes across all 18 Owner UI files', () => {
    for (const relPath of ownerViewFiles) {
      const fullPath = path.resolve(__dirname, '..', relPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      lines.forEach((line, idx) => {
        // Match placeholder="English text" or placeholder='English text' or placeholder={`English text`}
        const rawPlaceholderMatch = line.match(/placeholder=(["'`])([^"'`]+)\1/);
        if (rawPlaceholderMatch) {
          const val = rawPlaceholderMatch[2].trim();
          // Allow empty string or purely non-word characters if any
          expect(
            val,
            `Hardcoded placeholder string literal "${val}" at ${relPath}:${idx + 1}. Use placeholder={t('...')} instead.`
          ).toBe('');
        }
      });
    }
  });

  it('10. Generic Manual Bridge status/error setter guard: Enforces localized error wrappers and prevents unwrapped backend error display', () => {
    const manualBridgePath = path.resolve(__dirname, '..', 'src/ui/views/ManualBridgeView.tsx');
    const content = fs.readFileSync(manualBridgePath, 'utf-8');

    // 1. Assert old unwrapped error display patterns are absent
    expect(content.includes('setRoutingError(res?.error ||')).toBe(false);
    expect(content.includes('setAuthError(res?.error ||')).toBe(false);
    expect(content.includes('setDispatchError(res?.error || res?.result?.error ||')).toBe(false);
    expect(content.includes('setDispatchError(res?.error ||')).toBe(false);

    // 2. Assert no hardcoded English template literals passed to status/error setters
    const forbiddenSetterPatterns = [
      /setRoutingError\(\s*['"`]Routing failed/i,
      /setRoutingError\(\s*['"`]Error executing/i,
      /setAuthError\(\s*['"`]Authorization creation/i,
      /setAuthError\(\s*['"`]Error executing/i,
      /setDispatchError\(\s*['"`]Dispatch execution/i,
      /setDispatchError\(\s*['"`]Error dispatching/i,
      /setManagerApplyStatus\(\s*`Success:\s*\$\{res\.message/i,
      /setManagerApplyStatus\(\s*`Error:\s*\$\{res\.error/i,
      /setCoderApplyStatus\(\s*`Success:\s*\$\{res\.message/i,
      /setCoderApplyStatus\(\s*`Error:\s*\$\{res\.error/i,
      /setCoderApplyStatus\(\s*`Verification Error:/i,
      /setHandoffWorkOrder\(\s*`Error generating/i,
      /setOutboxContent\(\s*`Error generating/i,
    ];

    for (const pattern of forbiddenSetterPatterns) {
      expect(
        pattern.test(content),
        `Found hardcoded setter pattern ${pattern.toString()} in ManualBridgeView.tsx`
      ).toBe(false);
    }
  });
});
