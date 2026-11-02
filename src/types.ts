import type { Category } from '../shared/formats.ts';

export interface DesignFile {
  /** Null for the design's primary file. */
  id: number | null;
  rel_path: string;
  name: string;
  ext: string;
  size: number;
  url: string;
}

export interface Design {
  id: number;
  name: string;
  project_id: number;
  product_id: number | null;
  type_id: number | null;
  design_date: string;
  notes: string;
  original_name: string;
  ext: string;
  category: Category;
  size: number;
  extra_files: number;
  total_size: number;
  /** Only on responses for a single design, not on list pages. */
  files?: DesignFile[];
  duplicate_of?: { id: number; name: string } | null;
  thumb_state: 'none' | 'ok' | 'failed';
  thumb_version: number;
  created_at: string;
  updated_at: string;
  project_name: string;
  product_name: string | null;
  type_name: string | null;
}

export interface Product {
  id: number;
  project_id: number;
  name: string;
  count: number;
}

export interface Project {
  id: number;
  name: string;
  count: number;
  products: Product[];
}

export interface DesignType {
  id: number;
  name: string;
  slug: string | null;
  count: number;
}

export interface Meta {
  projects: Project[];
  types: DesignType[];
  categories: { category: Category; count: number }[];
  exts: { ext: string; count: number }[];
  total: number;
  duplicates: number;
  can_open: boolean;
}

export interface DuplicateItem {
  design: Design;
  file_id: number | null;
  file_name: string;
  removable: boolean;
}

export interface DuplicateGroup {
  sha256: string;
  size: number;
  items: DuplicateItem[];
}

/** Everything the bulk edit can change. A field left out stays as it is on each design. */
export interface BulkPatch {
  project_id?: number;
  product_id?: number | null;
  type_id?: number | null;
  design_date?: string;
}

export interface Filters {
  q: string;
  project: number | null;
  /** A product id, or 'none' for files on the project with no product. */
  product: number | 'none' | null;
  /** Type ids as strings, plus 'none' for designs with no type. */
  types: string[];
  cats: Category[];
  ext: string;
  from: string;
  to: string;
  sort: string;
}

export const EMPTY_FILTERS: Filters = {
  q: '',
  project: null,
  product: null,
  types: [],
  cats: [],
  ext: '',
  from: '',
  to: '',
  sort: 'date',
};
