// Counting wrappers for the Cloudflare bindings the server code uses, so a test (or tools/measure-hot-paths.mjs) can state EXACTLY how many
// KV / D1 / Durable Object operations a request costs. Nothing here changes behaviour: every call is passed straight through.
//   kv   : get, getWithMetadata (counted as `get`), put, delete, list
//   d1   : `roundTrips` = one per prepare().run/all/first/raw and one per batch() (a batch is ONE network round trip on D1);
//          `statements` = SQL statements sent (a batch of 80 counts 80).
//   do   : `calls` per Durable Object stub fetch, by path
export function countKV(kv) {
  const c = { get: 0, put: 0, delete: 0, list: 0, keys: [] };
  const wrap = { ...kv };
  wrap.get = async (k, o) => { c.get++; c.keys.push('get ' + k); return kv.get(k, o); };
  if (kv.getWithMetadata) wrap.getWithMetadata = async (k, o) => { c.get++; c.keys.push('get ' + k); return kv.getWithMetadata(k, o); };
  wrap.put = async (k, v, o) => { c.put++; c.keys.push('put ' + k); return kv.put(k, v, o); };
  wrap.delete = async (k) => { c.delete++; return kv.delete(k); };
  wrap.list = async (o) => { c.list++; return kv.list(o); };
  const total = () => c.get + c.put + c.delete + c.list;
  const reset = () => { c.get = c.put = c.delete = c.list = 0; c.keys = []; };
  return { kv: wrap, counts: c, total, reset };
}

export function countD1(db) {
  const c = { roundTrips: 0, statements: 0, batches: 0, sql: [] };
  const wrapStmt = (s) => {
    const w = {
      sql: s.sql, args: s.args,
      bind: (...a) => wrapStmt(s.bind(...a)),
      run: () => { c.roundTrips++; c.statements++; return s.run(); },
      all: () => { c.roundTrips++; c.statements++; return s.all(); },
      first: (col) => { c.roundTrips++; c.statements++; return s.first(col); },
      raw: () => { c.roundTrips++; c.statements++; return s.raw(); },
    };
    return w;
  };
  const wrap = {
    ...db,
    prepare: (sql) => wrapStmt(db.prepare(sql)),
    batch: (stmts) => { c.roundTrips++; c.batches++; c.statements += stmts.length; return db.batch(stmts.map((x) => (x && x.sql !== undefined ? { sql: x.sql, args: x.args } : x))); },
  };
  const reset = () => { c.roundTrips = c.statements = c.batches = 0; c.sql = []; };
  return { db: wrap, counts: c, reset };
}

export function countDO(binding) {
  const c = { calls: 0, byPath: {} };
  const wrap = {
    ...binding,
    idFromName: (n) => binding.idFromName(n),
    get: (id) => { const stub = binding.get(id); return { fetch: (url, o) => { c.calls++; const p = new URL(String(url)).pathname; c.byPath[p] = (c.byPath[p] || 0) + 1; return stub.fetch(url, o); } }; },
  };
  const reset = () => { c.calls = 0; c.byPath = {}; };
  return { binding: wrap, counts: c, reset };
}
