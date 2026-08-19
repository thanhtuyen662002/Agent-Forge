import { SupportedLocale, SUPPORTED_LOCALES, DEFAULT_LOCALE, TranslationDictionary } from './types';
import { enUS } from './locales/en-US';
import { viVN } from './locales/vi-VN';

export * from './types';
export { enUS } from './locales/en-US';
export { viVN } from './locales/vi-VN';

export const LOCALES: Record<SupportedLocale, TranslationDictionary> = {
  'en-US': enUS,
  'vi-VN': viVN,
};

/**
 * Safely retrieve a translation string by dot-separated path (e.g. 'nav.dashboard')
 */
export function getTranslation(
  locale: SupportedLocale,
  path: string,
  params?: Record<string, string | number>
): string {
  const catalog = LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
  const keys = path.split('.');
  let current: any = catalog;

  for (const k of keys) {
    if (current && typeof current === 'object' && k in current) {
      current = current[k];
    } else {
      // Fallback to default locale if path missing
      const fallbackCatalog = LOCALES[DEFAULT_LOCALE];
      let fallbackCurrent: any = fallbackCatalog;
      for (const fk of keys) {
        if (fallbackCurrent && typeof fallbackCurrent === 'object' && fk in fallbackCurrent) {
          fallbackCurrent = fallbackCurrent[fk];
        } else {
          return path; // Return raw path if missing everywhere
        }
      }
      current = fallbackCurrent;
      break;
    }
  }

  if (typeof current !== 'string') {
    return path;
  }

  if (!params) {
    return current;
  }

  let formatted = current;
  for (const [paramKey, paramValue] of Object.entries(params)) {
    formatted = formatted.replace(new RegExp(`\\{${paramKey}\\}`, 'g'), String(paramValue));
  }
  return formatted;
}

/**
 * Determines initial locale following project policy:
 * 1. Saved preference if valid ('en-US' | 'vi-VN')
 * 2. System locale (if starts with 'vi' -> 'vi-VN')
 * 3. Default fallback ('en-US')
 */
export function resolveInitialLocale(
  savedPreference?: string | null,
  systemLocale?: string | null
): SupportedLocale {
  if (savedPreference && (SUPPORTED_LOCALES as string[]).includes(savedPreference)) {
    return savedPreference as SupportedLocale;
  }

  if (systemLocale) {
    const lower = systemLocale.toLowerCase();
    if (lower.startsWith('vi')) {
      return 'vi-VN';
    }
  }

  return DEFAULT_LOCALE;
}

/**
 * Deep parity check between two translation dictionaries.
 * Returns a list of paths missing in target compared to source.
 */
export function validateKeyParity(
  source: Record<string, any>,
  target: Record<string, any>,
  prefix = ''
): string[] {
  const missing: string[] = [];

  for (const key of Object.keys(source)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (!(key in target)) {
      missing.push(fullPath);
      continue;
    }

    const sourceVal = source[key];
    const targetVal = target[key];

    if (typeof sourceVal === 'object' && sourceVal !== null) {
      if (typeof targetVal !== 'object' || targetVal === null) {
        missing.push(`${fullPath} (type mismatch)`);
      } else {
        missing.push(...validateKeyParity(sourceVal, targetVal, fullPath));
      }
    }
  }

  return missing;
}
