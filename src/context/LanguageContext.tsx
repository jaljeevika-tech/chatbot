import { createContext, useContext, useState, type ReactNode } from 'react';
import { translations, LANGUAGES, type LangCode, type TranslationKeys } from '../i18n/translations';

interface LanguageContextType {
  lang: LangCode;
  setLang: (l: LangCode) => void;
  t: TranslationKeys;
  languages: typeof LANGUAGES;
}

const LanguageContext = createContext<LanguageContextType | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const stored = (localStorage.getItem('lang') ?? 'en') as LangCode;
  const [lang, setLangState] = useState<LangCode>(
    LANGUAGES.some(l => l.code === stored) ? stored : 'en'
  );

  function setLang(l: LangCode) {
    setLangState(l);
    localStorage.setItem('lang', l);
  }

  return (
    <LanguageContext.Provider value={{ lang, setLang, t: translations[lang], languages: LANGUAGES }}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error('useLanguage must be used inside LanguageProvider');
  return ctx;
}
