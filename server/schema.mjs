import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const schema = vm.createContext({});
vm.runInContext(readFileSync(new URL('../src/Schema.gs', import.meta.url), 'utf8'), schema);
export const fields = JSON.parse(JSON.stringify(schema.SHEET_SCHEMAS));
export const keys = JSON.parse(JSON.stringify(schema.SHEET_PRIMARY_KEYS));
export const tables = Object.freeze({ Equipment: 'equipment', Users: 'users', Borrow: 'borrow',
  Categories: 'categories', IncludedItems: 'included_items', BorrowItems: 'borrow_items',
  History: 'history', Operations: 'operations', Settings: 'settings', Sequences: 'sequences', SchemaMigrations: 'schema_migrations' });
