import React, { createContext, useContext, useState, useEffect, useMemo, ReactNode } from 'react';
import {
  SupportedLocale,
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  TranslationDictionary,
  LOCALES,
  getTranslation,
  resolveInitialLocale,
} from '../../shared/i18n';

interface I18nContextValue {
  locale: SupportedLocale;
  setLocale: (locale: SupportedLocale) => void;
  t: (path: string, params?: Record<string, string | number>) => string;
  dictionary: TranslationDictionary;
}

const I18nContext = createContext<I18nContextValue | null>(null);

const STORAGE_KEY = 'agentforge_locale';

export const I18nProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [locale, setLocaleState] = useState<SupportedLocale>(() => {
    let saved: string | null = null;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        saved = window.localStorage.getItem(STORAGE_KEY);
      }
    } catch {
      // Ignore localStorage access errors in sandboxed environments
    }
    const sysLocale = typeof navigator !== 'undefined' ? navigator.language : undefined;
    return resolveInitialLocale(saved, sysLocale);
  });

  const setLocale = (newLocale: SupportedLocale) => {
    if (!SUPPORTED_LOCALES.includes(newLocale)) return;
    setLocaleState(newLocale);
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(STORAGE_KEY, newLocale);
      }
    } catch {
      // Ignore storage errors
    }
  };

  const dictionary = useMemo(() => {
    return LOCALES[locale] || LOCALES[DEFAULT_LOCALE];
  }, [locale]);

  const t = useMemo(() => {
    return (path: string, params?: Record<string, string | number>) => {
      return getTranslation(locale, path, params);
    };
  }, [locale]);

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t,
      dictionary,
    }),
    [locale, dictionary, t]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    // Fallback if used outside provider
    return {
      locale: DEFAULT_LOCALE,
      setLocale: () => {},
      t: (path: string, params?: Record<string, string | number>) => getTranslation(DEFAULT_LOCALE, path, params),
      dictionary: LOCALES[DEFAULT_LOCALE],
    };
  }
  return context;
}
