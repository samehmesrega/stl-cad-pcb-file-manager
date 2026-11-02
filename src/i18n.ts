// The language of the page. Changing it reloads the page, so strings can be read once when a module loads.
import { DEFAULT_TYPES } from '../shared/formats.ts';
import { translate } from '../shared/i18n.ts';
import type { Language, MessageKey, MessageValues } from '../shared/i18n.ts';

const KEY = 'design-library-language';

function storedLanguage(): Language | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'en' || value === 'ar' ? value : null;
  } catch {
    return null;
  }
}

/** The saved choice wins. Before the user picks one, the language follows the system. */
export const language: Language = storedLanguage() ?? (navigator.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en');
export const isRtl = language === 'ar';

export const t = (key: MessageKey, values?: MessageValues) => translate(language, key, values);

/** For text that was decided elsewhere, such as an error from a worker, which may or may not have a translation. */
export const tr = (text: string) => translate(language, text);

export const plural = (n: number, one: MessageKey, many: MessageKey) => t(n === 1 ? one : many, { n });

export function applyLanguage() {
  document.documentElement.lang = language;
  document.documentElement.dir = isRtl ? 'rtl' : 'ltr';
  document.title = t('Design Library');
}

export function switchLanguage(next: Language) {
  try {
    localStorage.setItem(KEY, next);
  } catch {}
  window.location.reload();
}

/** The types every library starts with follow the language. Names the user chose stay as they typed them. */
export function typeLabel(name: string): string {
  const known = DEFAULT_TYPES.find((type) => type.name === name || type.arabic === name);
  if (!known) return name;
  return isRtl ? known.arabic : known.name;
}
