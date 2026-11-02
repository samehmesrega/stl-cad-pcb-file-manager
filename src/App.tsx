import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CATEGORY_LABELS } from '../shared/formats.ts';
import type { Category } from '../shared/formats.ts';
import { api, filtersToParams } from './api.ts';
import { BulkEditDialog, MAX_MERGE, MergeDialog } from './components/BulkDialogs.tsx';
import { DesignCard } from './components/DesignCard.tsx';
import { DetailView } from './components/DetailView.tsx';
import { DuplicatesDialog } from './components/DuplicatesDialog.tsx';
import { ManageDialog } from './components/ManageDialog.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { UploadDialog } from './components/UploadDialog.tsx';
import { ConfirmDialog, Icon } from './components/ui.tsx';
import { EMPTY_FILTERS } from './types.ts';
import type { Design, Filters, Meta } from './types.ts';
import { sourcesFromDrop } from './uploadSources.ts';
import type { UploadSource } from './uploadSources.ts';
import { t, plural, typeLabel, isRtl } from './i18n.ts';

const SORTS: [string, string][] = [
  ['date', t('Newest first')],
  ['date_asc', t('Oldest first')],
  ['added', t('Recently added')],
  ['name', t('Name')],
  ['size', t('Largest first')],
];

function readUrl(): { filters: Filters; designId: number | null } {
  const params = new URLSearchParams(window.location.search);
  const product = params.get('product');
  return {
    designId: Number(params.get('d')) || null,
    filters: {
      q: params.get('q') ?? '',
      project: Number(params.get('project')) || null,
      product: product === 'none' ? 'none' : Number(product) || null,
      types: params.get('type')?.split(',').filter(Boolean) ?? [],
      cats: (params.get('cat')?.split(',').filter(Boolean) ?? []) as Category[],
      ext: params.get('ext') ?? '',
      from: params.get('from') ?? '',
      to: params.get('to') ?? '',
      sort: params.get('sort') ?? 'date',
    },
  };
}

function writeUrl(filters: Filters, designId: number | null, push: boolean) {
  const params = filtersToParams(filters);
  if (designId) params.set('d', String(designId));
  const query = params.toString();
  const url = query ? `?${query}` : window.location.pathname;
  if (push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

export function App() {
  const initial = useMemo(readUrl, []);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [filters, setFilters] = useState<Filters>(initial.filters);
  const [items, setItems] = useState<Design[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [openId, setOpenId] = useState<number | null>(initial.designId);
  const [openDesign, setOpenDesign] = useState<Design | null>(null);
  const [upload, setUpload] = useState<{ sources: UploadSource[] } | null>(null);
  const [manage, setManage] = useState(false);
  const [duplicates, setDuplicates] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [selectAnchor, setSelectAnchor] = useState<number | null>(null);
  const [bulk, setBulk] = useState<'edit' | 'merge' | 'delete' | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [windowDrag, setWindowDrag] = useState(false);
  const [listVersion, setListVersion] = useState(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const showToast = useCallback((text: string, error = false) => setToast({ text, error }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), toast.error ? 6000 : 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const refreshMeta = useCallback(async () => {
    setMeta(await api.meta());
  }, []);

  useEffect(() => {
    refreshMeta().catch((error) => setLoadError(error.message));
  }, [refreshMeta]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      api
        .designs(filters, 1, controller.signal)
        .then((result) => {
          setItems(result.items);
          setTotal(result.total);
          setPage(1);
          setLoadError('');
          setLoading(false);
        })
        .catch((error) => {
          if (error.name === 'AbortError') return;
          setLoadError(error.message);
          setLoading(false);
        });
    }, filters.q ? 180 : 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [filters, listVersion]);

  useEffect(() => {
    writeUrl(filters, openId, false);
    // A selection made under other filters would act on designs the user can no longer see.
    setSelected(new Set());
    setSelectAnchor(null);
  }, [filters]);

  useEffect(() => {
    const onPop = () => {
      const state = readUrl();
      setFilters(state.filters);
      setOpenId(state.designId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // The open design may not be in the loaded page, for example after following a link.
  useEffect(() => {
    if (!openId) {
      setOpenDesign(null);
      return;
    }
    const known = items.find((item) => item.id === openId);
    if (known) {
      setOpenDesign(known);
      return;
    }
    let cancelled = false;
    api
      .design(openId)
      .then((design) => !cancelled && setOpenDesign(design))
      .catch(() => !cancelled && setOpenId(null));
    return () => {
      cancelled = true;
    };
  }, [openId, items]);

  const hasMore = items.length < total;
  const loadMore = useCallback(async () => {
    const next = page + 1;
    setPage(next);
    try {
      const result = await api.designs(filters, next);
      setItems((current) => {
        const seen = new Set(current.map((item) => item.id));
        return [...current, ...result.items.filter((item) => !seen.has(item.id))];
      });
    } catch (error) {
      showToast((error as Error).message, true);
    }
  }, [filters, page, showToast]);

  useEffect(() => {
    if (!hasMore || !sentinel.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void loadMore();
    }, { rootMargin: '600px' });
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  const updateItem = useCallback((design: Design) => {
    setItems((current) => current.map((item) => (item.id === design.id ? { ...item, ...design } : item)));
    setOpenDesign((current) => (current?.id === design.id ? { ...current, ...design } : current));
  }, []);

  const patchFilters = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const openDetail = useCallback((design: Design) => {
    setOpenId(design.id);
    writeUrl(filters, design.id, true);
  }, [filters]);

  const closeDetail = useCallback(() => {
    setOpenId(null);
    writeUrl(filters, null, false);
  }, [filters]);

  const toggleSelected = useCallback((design: Design, range: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      const anchorIndex = range && selectAnchor !== null ? items.findIndex((item) => item.id === selectAnchor) : -1;
      const index = items.findIndex((item) => item.id === design.id);
      if (anchorIndex >= 0 && index >= 0) {
        const [from, to] = anchorIndex < index ? [anchorIndex, index] : [index, anchorIndex];
        for (const item of items.slice(from, to + 1)) next.add(item.id);
      } else if (next.has(design.id)) {
        next.delete(design.id);
      } else {
        next.add(design.id);
      }
      return next;
    });
    setSelectAnchor(design.id);
  }, [items, selectAnchor]);

  const clearSelection = useCallback(() => {
    setSelected(new Set());
    setSelectAnchor(null);
  }, []);

  useEffect(() => {
    if (!selected.size) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) clearSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size, clearSelection]);

  const selectAllResults = async () => {
    try {
      setSelected(new Set(await api.matchingIds(filters)));
    } catch (error) {
      showToast((error as Error).message, true);
    }
  };

  const afterBulk = (text: string) => {
    setBulk(null);
    clearSelection();
    void refreshMeta();
    setListVersion((v) => v + 1);
    showToast(text);
  };

  const deleteSelected = async () => {
    const count = selected.size;
    try {
      await api.bulkDelete([...selected]);
      afterBulk(plural(count, '{n} design deleted', '{n} designs deleted'));
    } catch (error) {
      setBulk(null);
      showToast((error as Error).message, true);
    }
  };

  const openIndex = openDesign ? items.findIndex((item) => item.id === openDesign.id) : -1;
  const stepTo = (index: number) => {
    const target = items[index];
    if (!target) return;
    setOpenId(target.id);
    writeUrl(filters, target.id, false);
  };

  // Dropping files anywhere on the page opens the upload dialog with them.
  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files');
    const onOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (!document.querySelector('dialog[open]')) setWindowDrag(true);
    };
    const onLeave = (event: DragEvent) => {
      if (!event.relatedTarget) setWindowDrag(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event) || !event.dataTransfer) return;
      event.preventDefault();
      setWindowDrag(false);
      if (document.querySelector('dialog[open]')) return;
      void sourcesFromDrop(event.dataTransfer).then((sources) => {
        if (sources.length) setUpload({ sources });
      });
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  const activeChips = useMemo(() => {
    const chips: { key: string; label: string; clear: Partial<Filters> }[] = [];
    if (!meta) return chips;
    const project = meta.projects.find((p) => p.id === filters.project);
    if (project) chips.push({ key: 'project', label: project.name, clear: { project: null, product: null } });
    if (filters.product === 'none') chips.push({ key: 'product', label: t('No product'), clear: { product: null } });
    else if (filters.product) {
      const product = project?.products.find((p) => p.id === filters.product);
      if (product) chips.push({ key: 'product', label: product.name, clear: { product: null } });
    }
    for (const id of filters.types) {
      const label = id === 'none' ? t('No type') : typeLabel(meta.types.find((type) => String(type.id) === id)?.name ?? '');
      if (label) chips.push({ key: `type-${id}`, label, clear: { types: filters.types.filter((t) => t !== id) } });
    }
    for (const cat of filters.cats) {
      chips.push({ key: `cat-${cat}`, label: CATEGORY_LABELS[cat], clear: { cats: filters.cats.filter((c) => c !== cat) } });
    }
    if (filters.ext) chips.push({ key: 'ext', label: filters.ext.toUpperCase(), clear: { ext: '' } });
    if (filters.from || filters.to) {
      chips.push({
        key: 'date',
        label: `${filters.from || '…'} ${isRtl ? '←' : '→'} ${filters.to || t('today')}`,
        clear: { from: '', to: '' },
      });
    }
    return chips;
  }, [filters, meta]);

  const hasFilters = activeChips.length > 0 || filters.q.trim().length > 0;
  const libraryEmpty = meta !== null && meta.total === 0;

  return (
    <div className="app">
      <Sidebar
        meta={meta}
        filters={filters}
        onChange={patchFilters}
        onManage={() => setManage(true)}
        onDuplicates={() => setDuplicates(true)}
        open={sidebarOpen}
      />
      {sidebarOpen && <button className="scrim" aria-label={t('Close filters')} onClick={() => setSidebarOpen(false)} />}

      <main className="main">
        <header className="topbar">
          <button className="icon-btn filter-toggle" aria-label={t('Filters')} onClick={() => setSidebarOpen(true)}>
            <Icon name="filter" />
          </button>
          <label className="search">
            <Icon name="search" size={16} />
            <input
              type="search"
              dir="auto"
              placeholder={t('Search by design or file name')}
              aria-label={t('Search by name')}
              value={filters.q}
              onChange={(event) => patchFilters({ q: event.target.value })}
            />
          </label>
          <button className="btn btn-accent btn-upload" disabled={!meta} onClick={() => setUpload({ sources: [] })}>
            <Icon name="plus" />{t('Add designs')}</button>
        </header>

        <div className="resultbar">
          <p className="result-count" aria-live="polite">
            {total === 1 ? t('{n} design', { n: 1 }) : t('{n} designs', { n: total.toLocaleString('en-US') })}
          </p>
          <div className="active-chips">
            {activeChips.map((chip) => (
              <button key={chip.key} className="chip on" onClick={() => patchFilters(chip.clear)} aria-label={t('Remove filter {name}', { name: chip.label })}>
                <span dir="auto">{chip.label}</span> <Icon name="close" size={12} />
              </button>
            ))}
            {hasFilters && (
              <button className="link-btn" onClick={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort })}>{t('Clear all')}</button>
            )}
          </div>
          <label className="sort">
            <span>{t('Sort')}</span>
            <select value={filters.sort} onChange={(event) => patchFilters({ sort: event.target.value })}>
              {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>

        {loadError && (
          <div className="empty" role="alert">
            <h2>{t('Could not load the library')}</h2>
            <p dir="auto">{loadError}</p>
            <button
              className="btn"
              onClick={() => {
                setLoadError('');
                refreshMeta().catch((error) => setLoadError(error.message));
                setListVersion((v) => v + 1);
              }}
            >{t('Try again')}</button>
          </div>
        )}

        {!loadError && libraryEmpty && (
          <div className="empty">
            <h2>{t('Your library is empty')}</h2>
            <p>{t('Drag design files anywhere on this page, or use the button. You choose the project and product while uploading, and you can create them in the same step.')}</p>
            <button className="btn btn-accent" onClick={() => setUpload({ sources: [] })}><Icon name="plus" />{t('Add your first design')}</button>
            <p className="format-line" dir="ltr">STL · STEP · IGES · 3MF · OBJ · SCAD · DWG · DXF · RD · PLT · G-CODE · GERBER · KICAD · PDF · AI · PSD · TIFF · PNG · JPG · SVG</p>
          </div>
        )}

        {!loadError && !libraryEmpty && !loading && items.length === 0 && (
          <div className="empty">
            <h2>{t('No results')}</h2>
            <p>{t('Try another word or remove some filters.')}</p>
            <button className="btn" onClick={() => setFilters({ ...EMPTY_FILTERS, sort: filters.sort })}>{t('Clear filters')}</button>
          </div>
        )}

        {items.length > 0 && !loadError && (
          <div className={`grid ${loading ? 'grid-loading' : ''}`}>
            {items.map((design) => (
              <DesignCard
                key={design.id}
                design={design}
                selected={selected.has(design.id)}
                selecting={selected.size > 0}
                onOpen={openDetail}
                onUpdate={updateItem}
                onToggle={toggleSelected}
              />
            ))}
          </div>
        )}
        <div ref={sentinel} className="sentinel" />
      </main>

      {selected.size > 0 && !openDesign && (
        <div className="bulk-bar" role="toolbar" aria-label={t('Actions for the selected designs')}>
          <span className="bulk-count">{t('{n} selected', { n: selected.size })}</span>
          {selected.size < total && (
            <button className="link-btn" onClick={selectAllResults}>{t('Select all results ({n})', { n: total })}</button>
          )}
          <span className="bulk-actions">
            <button className="btn" onClick={() => setBulk('edit')}><Icon name="edit" size={16} />{t('Edit')}</button>
            <button
              className="btn"
              disabled={selected.size < 2 || selected.size > MAX_MERGE}
              title={selected.size > MAX_MERGE ? t('You can merge up to {n} designs at a time', { n: MAX_MERGE }) : t('Merge them into one design')}
              onClick={() => setBulk('merge')}
            >
              <Icon name="merge" size={16} />{t('Merge')}</button>
            <button className="btn btn-quiet-danger" onClick={() => setBulk('delete')}><Icon name="trash" size={16} />{t('Delete')}</button>
          </span>
          <button className="icon-btn" aria-label={t('Clear selection')} onClick={clearSelection}><Icon name="close" /></button>
        </div>
      )}

      {bulk === 'edit' && meta && (
        <BulkEditDialog
          ids={[...selected]}
          meta={meta}
          onClose={() => setBulk(null)}
          onDone={() => afterBulk(plural(selected.size, '{n} design updated', '{n} designs updated'))}
        />
      )}
      {bulk === 'merge' && (
        <MergeDialog
          ids={[...selected]}
          onClose={() => setBulk(null)}
          onDone={(design) => afterBulk(t('Merged into "{name}"', { name: design.name }))}
        />
      )}
      {bulk === 'delete' && (
        <ConfirmDialog
          title={t('Delete selected designs')}
          message={plural(selected.size, '{n} design and its files will be permanently deleted. This cannot be undone.', '{n} designs and their files will be permanently deleted. This cannot be undone.')}
          confirmLabel={t('Delete permanently')}
          onConfirm={deleteSelected}
          onCancel={() => setBulk(null)}
        />
      )}
      {duplicates && (
        <DuplicatesDialog
          onClose={() => setDuplicates(false)}
          onChanged={() => {
            void refreshMeta();
            setListVersion((v) => v + 1);
          }}
        />
      )}

      {openDesign && meta && (
        <DetailView
          design={openDesign}
          meta={meta}
          onClose={closeDetail}
          onChange={(design) => {
            updateItem(design);
            void refreshMeta();
          }}
          onDeleted={(id) => {
            setOpenId(null);
            writeUrl(filters, null, false);
            setItems((current) => current.filter((item) => item.id !== id));
            setTotal((current) => current - 1);
            void refreshMeta();
            showToast(t('Design deleted'));
          }}
          onFilesChanged={() => {
            void refreshMeta();
            setListVersion((v) => v + 1);
          }}
          onPrev={openIndex > 0 ? () => stepTo(openIndex - 1) : undefined}
          onNext={openIndex >= 0 && openIndex < items.length - 1 ? () => stepTo(openIndex + 1) : undefined}
          onError={(message) => showToast(message, true)}
        />
      )}

      {upload && meta && (
        <UploadDialog
          meta={meta}
          filters={filters}
          initialSources={upload.sources}
          onClose={() => setUpload(null)}
          onMetaChange={refreshMeta}
          onUploaded={(count, duplicateFiles) => {
            void refreshMeta();
            setListVersion((v) => v + 1);
            const uploaded = plural(count, '{n} design uploaded', '{n} designs uploaded');
            showToast(duplicateFiles
              ? `${uploaded}${isRtl ? '، ' : '. '}${plural(duplicateFiles, '{n} file already has an identical copy in the library', '{n} files already have an identical copy in the library')}`
              : uploaded);
          }}
        />
      )}

      {manage && meta && (
        <ManageDialog
          meta={meta}
          onClose={() => setManage(false)}
          onChanged={async () => {
            await refreshMeta();
            setListVersion((v) => v + 1);
          }}
        />
      )}

      {windowDrag && (
        <div className="drop-overlay" aria-hidden>
          <div>{t('Drop files to add them to the library')}</div>
        </div>
      )}

      {toast && <div className={`toast ${toast.error ? 'toast-error' : ''}`} role="status" dir="auto">{toast.text}</div>}
    </div>
  );
}
