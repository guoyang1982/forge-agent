import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
const api = Function(`${readFileSync(new URL('./draft-store.js', import.meta.url), 'utf8')}\nreturn ForgeDraftStore;`)();
function fixture() {
  const rows = new Map();
  const storage = { getItem: (key) => rows.get(key) || null, setItem: (key, value) => rows.set(key, value), removeItem: (key) => rows.delete(key) };
  return { rows, storage, store: () => api.createDraftStore(() => storage, 'work') };
}
describe('persistent company drafts', () => {
  it('restores after a new app instance and isolates company/task keys', () => {
    const fx = fixture();
    fx.store().set(JSON.stringify(['a', 'task']), { spec: '未提交', plan: '' });
    expect(fx.store().get(JSON.stringify(['a', 'task']))).toEqual({ spec: '未提交', plan: '' });
    expect(fx.store().get(JSON.stringify(['b', 'task']))).toBeUndefined();
    fx.store().delete(JSON.stringify(['a', 'task']));
    expect(fx.store().get(JSON.stringify(['a', 'task']))).toBeUndefined();
  });
  it('keeps separate tasks when another window saves and handles corrupt data', () => {
    const fx = fixture(); const first = fx.store(); const second = fx.store();
    first.set('a', { spec: 'A' }); second.set('b', { spec: 'B' });
    expect(first.get('b')).toEqual({ spec: 'B' });
    second.delete('a'); expect(first.get('a')).toBeUndefined();
    fx.rows.set('forgeCompany.draft.v1:work:broken', '{invalid');
    expect(first.get('broken')).toBeUndefined();
  });
  it('reports storage failure while retaining current-session edits', () => {
    const store = api.createDraftStore(() => { throw new Error('unavailable'); }, 'work');
    expect(store.set('a', { spec: 'recover me' })).toBe(false);
    expect(store.get('a')).toEqual({ spec: 'recover me' });
    expect(store.delete('a')).toBe(false);
    expect(store.get('a')).toBeUndefined();
  });
});
