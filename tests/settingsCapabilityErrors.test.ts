import { describe, expect, it } from 'vitest';
import { capabilityErrorText } from '../src/ui/views/SettingsView';
import { getTranslation } from '../src/shared/i18n';

const vi = (key: string, params?: Record<string, string | number>) => getTranslation('vi-VN', key, params);
const en = (key: string, params?: Record<string, string | number>) => getTranslation('en-US', key, params);

/** #267: the owner sees why a test command was refused and what works instead. */
describe('verification command save errors', () => {
  it('explains a refused command with working alternatives in both languages', () => {
    expect(capabilityErrorText('INVALID_VERIFICATION_CAPABILITY', vi)).toContain('node --test');
    expect(capabilityErrorText('INVALID_VERIFICATION_CAPABILITY', en)).toContain('npm test');
    expect(capabilityErrorText('OWNER_APPROVAL_REQUIRED', vi)).toContain('Approve');
    expect(capabilityErrorText('CAPABILITY_PATH_ESCAPE', en)).toContain('inside the project folder');
  });

  it('keeps unknown codes visible and passes through plain messages', () => {
    expect(capabilityErrorText('SOMETHING_NEW', en)).toBe('The command could not be saved (SOMETHING_NEW).');
    expect(capabilityErrorText('Project "P" not found.', en)).toBe('Project "P" not found.');
    expect(capabilityErrorText(undefined, en)).toBeNull();
  });
});
