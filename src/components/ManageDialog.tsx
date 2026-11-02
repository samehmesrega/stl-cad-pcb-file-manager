import { useState } from 'react';
import { api } from '../api.ts';
import type { Meta } from '../types.ts';
import { Dialog, Icon } from './ui.tsx';
import { t, typeLabel } from '../i18n.ts';

function Row({ name, count, onRename, onDelete, child }: {
  name: string;
  count: number;
  onRename: (name: string) => Promise<unknown>;
  onDelete: () => Promise<unknown>;
  child?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);

  const commit = async () => {
    if (value.trim() && value.trim() !== name) await onRename(value.trim());
    setEditing(false);
  };

  return (
    <li className={`manage-row ${child ? 'child' : ''}`}>
      {editing ? (
        <input
          autoFocus
          dir="auto"
          value={value}
          aria-label={t('New name')}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commit();
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setValue(name);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="manage-name" dir="auto">{typeLabel(name)}</span>
      )}
      <span className="count">{count}</span>
      <button className="icon-btn" aria-label={t('Rename {name}', { name })} onClick={() => setEditing(true)}><Icon name="edit" size={15} /></button>
      <button className="icon-btn" aria-label={t('Delete {name}', { name })} onClick={() => void onDelete()}><Icon name="trash" size={15} /></button>
    </li>
  );
}

function AddRow({ placeholder, onAdd }: { placeholder: string; onAdd: (name: string) => Promise<unknown> }) {
  const [value, setValue] = useState('');
  return (
    <form
      className="manage-add"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!value.trim()) return;
        await onAdd(value.trim());
        setValue('');
      }}
    >
      <input dir="auto" value={value} placeholder={placeholder} aria-label={placeholder} onChange={(event) => setValue(event.target.value)} />
      <button className="icon-btn" aria-label={placeholder} disabled={!value.trim()}><Icon name="plus" size={16} /></button>
    </form>
  );
}

export function ManageDialog({ meta, onClose, onChanged }: {
  meta: Meta;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [error, setError] = useState('');
  const run = (work: () => Promise<unknown>) => async () => {
    setError('');
    try {
      await work();
      await onChanged();
    } catch (runError) {
      setError((runError as Error).message);
    }
  };

  return (
    <Dialog title={t('Manage projects and types')} onClose={onClose} wide>
      <div className="manage-layout">
        <section>
          <h3>{t('Projects and products')}</h3>
          <ul className="manage-list">
            {meta.projects.map((project) => (
              <li key={project.id} className="manage-group">
                <ul>
                  <Row
                    name={project.name}
                    count={project.count}
                    onRename={(name) => run(() => api.renameProject(project.id, name))()}
                    onDelete={() => run(() => api.deleteProject(project.id))()}
                  />
                  {project.products.map((product) => (
                    <Row
                      key={product.id}
                      child
                      name={product.name}
                      count={product.count}
                      onRename={(name) => run(() => api.renameProduct(product.id, name))()}
                      onDelete={() => run(() => api.deleteProduct(product.id))()}
                    />
                  ))}
                </ul>
                <AddRow placeholder={t('New product in {name}', { name: project.name })} onAdd={(name) => run(() => api.createProduct(project.id, name))()} />
              </li>
            ))}
          </ul>
          <AddRow placeholder={t('New project')} onAdd={(name) => run(() => api.createProject(name))()} />
        </section>
        <section>
          <h3>{t('Design types')}</h3>
          <ul className="manage-list">
            {meta.types.map((type) => (
              <Row
                key={type.id}
                name={type.name}
                count={type.count}
                onRename={(name) => run(() => api.renameType(type.id, name))()}
                onDelete={() => run(() => api.deleteType(type.id))()}
              />
            ))}
          </ul>
          <AddRow placeholder={t('New type')} onAdd={(name) => run(() => api.createType(name))()} />
          <p className="hint">{t('Deleting a type keeps its designs, but they are left without a type.')}</p>
        </section>
      </div>
      <footer className="dialog-foot">
        {error && <span className="field-error" role="alert">{error}</span>}
        <button className="btn" onClick={onClose}>{t('Done')}</button>
      </footer>
    </Dialog>
  );
}
