import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { currentTheme, saveTheme } from '../theme.ts';
import type { Theme } from '../theme.ts';
import { t, language, switchLanguage } from '../i18n.ts';

const ICONS: Record<string, ReactNode> = {
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></>,
  upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M4 20h16" /></>,
  download: <><path d="M12 4v12m0 0 5-5m-5 5-5-5" /><path d="M4 20h16" /></>,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  trash: <><path d="M4 7h16M9 7V4h6v3" /><path d="M6.5 7 7.5 20h9l1-13" /></>,
  edit: <path d="M4 20h4L19 9l-4-4L4 16v4Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  next: <path d="m9 6 6 6-6 6" />,
  prev: <path d="m15 6-6 6 6 6" />,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  gear: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  sun: <><circle cx="12" cy="12" r="3.5" /><path d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.4m0-12.8L17 7M7 17l-1.4 1.4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  open: <><path d="M14 4h6v6" /><path d="M20 4 11 13" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>,
  folder: <path d="M4 7a1 1 0 0 1 1-1h4l2 2h8a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7Z" />,
  merge: <><path d="M7 4v5a5 5 0 0 0 5 5h5" /><path d="M7 20v-6" /><path d="m14 11 3 3-3 3" /></>,
  split: <><path d="M12 20v-7L6 7" /><path d="m12 13 6-6" /><path d="M6 11V7h4M18 11V7h-4" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.6 2.4 3.9 5.2 3.9 8.5s-1.3 6.1-3.9 8.5c-2.6-2.4-3.9-5.2-3.9-8.5s1.3-6.1 3.9-8.5Z" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="1.5" /><path d="M5 15H4V5a1 1 0 0 1 1-1h10v1" /></>,
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      className="theme-toggle"
      onClick={() => {
        saveTheme(next);
        setTheme(next);
      }}
    >
      <Icon name={next === 'dark' ? 'moon' : 'sun'} size={16} />
      {next === 'dark' ? t('Dark') : t('Light')}
    </button>
  );
}

export function LanguageToggle() {
  const next = language === 'ar' ? 'en' : 'ar';
  return (
    <button className="theme-toggle" lang={next} dir={next === 'ar' ? 'rtl' : 'ltr'} onClick={() => switchLanguage(next)}>
      <Icon name="globe" size={16} />
      {next === 'ar' ? 'العربية' : 'English'}
    </button>
  );
}

export function Icon({ name, size = 18 }: { name: keyof typeof ICONS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {ICONS[name]}
    </svg>
  );
}

export function Dialog({ title, onClose, children, wide, locked }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  /** Blocks Esc and the close button, for example during an upload. */
  locked?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    if (!dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'dialog-wide' : ''}`}
      onCancel={(event) => {
        event.preventDefault();
        if (!locked) onClose();
      }}
    >
      <header className="dialog-head">
        <h2>{title}</h2>
        <button className="icon-btn" onClick={onClose} disabled={locked} aria-label={t('Close')}>
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog title={title} onClose={onCancel}>
      <div className="dialog-body">
        <p dir="auto">{message}</p>
      </div>
      <footer className="dialog-foot">
        <button className="btn" onClick={onCancel}>{t('Back')}</button>
        <button className="btn btn-danger" onClick={onConfirm}>{confirmLabel}</button>
      </footer>
    </Dialog>
  );
}

/** A select with a built-in "add new" row that creates the item on the spot. */
export function PickOrCreate({ label, value, options, onChange, onCreate, emptyLabel, disabled, addLabel }: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  onCreate?: (name: string) => Promise<string>;
  emptyLabel?: string;
  disabled?: boolean;
  addLabel: string;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!name.trim() || !onCreate) return;
    setBusy(true);
    setError('');
    try {
      onChange(await onCreate(name.trim()));
      setAdding(false);
      setName('');
    } catch (createError) {
      setError((createError as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {adding ? (
        <div className="inline-add">
          <input
            autoFocus
            dir="auto"
            value={name}
            placeholder={addLabel}
            aria-label={addLabel}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void save();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setAdding(false);
              }
            }}
          />
          <button className="btn btn-ink" type="button" disabled={busy || !name.trim()} onClick={save}>{t('Add')}</button>
          <button className="icon-btn" type="button" aria-label={t('Cancel')} onClick={() => setAdding(false)}><Icon name="close" /></button>
        </div>
      ) : (
        <select
          aria-label={label}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === '__new') {
              setAdding(true);
              setError('');
            } else {
              onChange(event.target.value);
            }
          }}
        >
          {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          {onCreate && <option value="__new">+ {addLabel}</option>}
        </select>
      )}
      {error && <span className="field-error" role="alert">{error}</span>}
    </div>
  );
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function toLocalDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
