import { CATEGORY_LABELS } from '../../shared/formats.ts';
import type { Category } from '../../shared/formats.ts';
import type { Filters, Meta } from '../types.ts';
import { Icon, LanguageToggle, ThemeToggle, toLocalDate } from './ui.tsx';
import { t, typeLabel } from '../i18n.ts';

const CATEGORIES = Object.keys(CATEGORY_LABELS) as Category[];

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return toLocalDate(date);
}

const PERIODS: { label: string; range: () => [string, string] }[] = [
  { label: t('Last 7 days'), range: () => [daysAgo(7), ''] },
  { label: t('Last 30 days'), range: () => [daysAgo(30), ''] },
  { label: t('Last 3 months'), range: () => [daysAgo(91), ''] },
  { label: t('This year'), range: () => [`${new Date().getFullYear()}-01-01`, ''] },
];

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

export function Sidebar({ meta, filters, onChange, onManage, onDuplicates, open }: {
  meta: Meta | null;
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  onManage: () => void;
  onDuplicates: () => void;
  open: boolean;
}) {
  const categoryCount = (category: Category) => meta?.categories.find((c) => c.category === category)?.count ?? 0;
  const presentCategories = CATEGORIES.filter((category) => categoryCount(category) > 0 || filters.cats.includes(category));

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label={t('Filters')}>
      <div className="brand">
        <svg className="brand-mark" width="26" height="26" viewBox="0 0 26 26" aria-hidden>
          <rect width="26" height="26" rx="7" fill="currentColor" />
          <path d="M7.5 18.5v-8l5.5-3 5.5 3v8l-5.5 3-5.5-3Zm0-8 5.5 3 5.5-3M13 13.5v8" fill="none" stroke="var(--on-accent)" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
        <h1>{t('Design Library')}</h1>
      </div>

      <div className="side-scroll">
      <section className="side-section">
        <header className="side-head">
          <h3>{t('Projects')}</h3>
          <button className="link-btn" onClick={onManage}><Icon name="gear" size={14} />{t('Manage')}</button>
        </header>
        <div className="tree">
          <button
            className={`tree-row ${!filters.project ? 'active' : ''}`}
            aria-pressed={!filters.project}
            onClick={() => onChange({ project: null, product: null })}
          >
            <span>{t('All projects')}</span>
            <span className="count">{meta?.total ?? 0}</span>
          </button>
          {meta?.projects.map((project) => {
            const selected = filters.project === project.id;
            return (
              <div key={project.id} className="tree-group">
                <button
                  className={`tree-row ${selected && !filters.product ? 'active' : ''}`}
                  aria-pressed={selected && !filters.product}
                  onClick={() => onChange({ project: project.id, product: null })}
                >
                  <span dir="auto">{project.name}</span>
                  <span className="count">{project.count}</span>
                </button>
                {selected && project.products.length > 0 && (
                  <div className="tree-children">
                    {project.products.map((product) => (
                      <button
                        key={product.id}
                        className={`tree-row child ${filters.product === product.id ? 'active' : ''}`}
                        aria-pressed={filters.product === product.id}
                        onClick={() => onChange({ project: project.id, product: product.id })}
                      >
                        <span dir="auto">{product.name}</span>
                        <span className="count">{product.count}</span>
                      </button>
                    ))}
                    <button
                      className={`tree-row child muted ${filters.product === 'none' ? 'active' : ''}`}
                      aria-pressed={filters.product === 'none'}
                      onClick={() => onChange({ project: project.id, product: 'none' })}
                    >
                      <span>{t('General files with no product')}</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {meta && !meta.projects.length && <p className="side-empty">{t('No projects yet.')}</p>}
        </div>
      </section>

      <section className="side-section">
        <header className="side-head"><h3>{t('Design type')}</h3></header>
        <div className="checks">
          {meta?.types.map((type) => (
            <label key={type.id}>
              <input
                type="checkbox"
                checked={filters.types.includes(String(type.id))}
                onChange={() => onChange({ types: toggle(filters.types, String(type.id)) })}
              />
              <span dir="auto">{typeLabel(type.name)}</span>
              <span className="count">{type.count}</span>
            </label>
          ))}
          <label>
            <input
              type="checkbox"
              checked={filters.types.includes('none')}
              onChange={() => onChange({ types: toggle(filters.types, 'none') })}
            />
            <span>{t('No type')}</span>
          </label>
        </div>
      </section>

      <section className="side-section">
        <header className="side-head"><h3>{t('Time period')}</h3></header>
        <div className="periods">
          {PERIODS.map((period) => {
            const [from, to] = period.range();
            const active = filters.from === from && filters.to === to;
            return (
              <button
                key={period.label}
                className={`chip ${active ? 'on' : ''}`}
                aria-pressed={active}
                onClick={() => onChange(active ? { from: '', to: '' } : { from, to })}
              >
                {period.label}
              </button>
            );
          })}
        </div>
        <div className="date-range">
          <label>
            <span>{t('From')}</span>
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={(event) => onChange({ from: event.target.value })} />
          </label>
          <label>
            <span>{t('To')}</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={(event) => onChange({ to: event.target.value })} />
          </label>
        </div>
      </section>

      {(presentCategories.length > 0 || (meta?.exts.length ?? 0) > 0) && (
        <section className="side-section">
          <header className="side-head"><h3>{t('File type')}</h3></header>
          <div className="checks">
            {presentCategories.map((category) => (
              <label key={category}>
                <input
                  type="checkbox"
                  checked={filters.cats.includes(category)}
                  onChange={() => onChange({ cats: toggle(filters.cats, category) })}
                />
                <span>{t(CATEGORY_LABELS[category])}</span>
                <span className="count">{categoryCount(category)}</span>
              </label>
            ))}
          </div>
          <div className="ext-grid" dir="ltr">
            {meta?.exts.map(({ ext, count }) => (
              <button
                key={ext}
                className={`ext-chip ${filters.ext === ext ? 'on' : ''}`}
                aria-pressed={filters.ext === ext}
                title={`${count}`}
                onClick={() => onChange({ ext: filters.ext === ext ? '' : ext })}
              >
                {ext ? ext.toUpperCase() : '—'}
              </button>
            ))}
          </div>
        </section>
      )}
      </div>

      <div className="side-foot">
        {(meta?.duplicates ?? 0) > 0 && (
          <button className="theme-toggle" onClick={onDuplicates}>
            <Icon name="copy" size={16} />
            {t('Duplicate files')}
            <span className="count">{meta?.duplicates}</span>
          </button>
        )}
        <div className="side-switches">
          <ThemeToggle />
          <LanguageToggle />
        </div>
      </div>
    </aside>
  );
}
