// In-memory KV that behaves like Cloudflare KV for the parts the server code uses: get / put with metadata /
// getWithMetadata / delete / list (prefix, metadata, cursor paging).
export function makeKV() {
  const data = new Map();   // key -> { value, metadata }
  return {
    data,
    async get(k) { return data.has(k) ? data.get(k).value : null; },
    async getWithMetadata(k) { return data.has(k) ? { value: data.get(k).value, metadata: data.get(k).metadata ?? null } : { value: null, metadata: null }; },
    async put(k, v, opts = {}) { data.set(k, { value: v, metadata: opts.metadata }); },
    async delete(k) { data.delete(k); },
    async list({ prefix = '', cursor, limit = 2 } = {}) {   // tiny page size so paging is exercised
      const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const slice = keys.slice(start, start + limit);
      const next = start + limit;
      return { keys: slice.map((name) => ({ name, metadata: data.get(name).metadata })), list_complete: next >= keys.length, cursor: next >= keys.length ? undefined : String(next) };
    },
  };
}
export function seedShop(kv, id = 'C1', extra = {}) {
  kv.data.set(`license:${id}`, { value: JSON.stringify({ id, type: 'permanent', slug: 'shop-' + id, label: 'Shop ' + id, ...extra }) });
  const idx = JSON.parse(kv.data.get('license-index:v1')?.value || '[]');
  idx.push({ id, slug: 'shop-' + id, type: 'permanent', label: 'Shop ' + id, businessName: 'Biz ' + id });
  kv.data.set('license-index:v1', { value: JSON.stringify(idx) });
}
