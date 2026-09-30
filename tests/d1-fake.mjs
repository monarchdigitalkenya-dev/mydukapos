// A Cloudflare D1 stand-in on node:sqlite, so the ledger's SQL (constraints, triggers, transactions) is REALLY executed in tests.
// Implements the D1 surface the server code uses: prepare().bind().run/first/all/raw, batch() (ONE transaction: all or nothing), exec().
import { DatabaseSync } from 'node:sqlite';
process.removeAllListeners('warning'); process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
export function makeD1(opts = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const st = { failNext: 0, failOnSql: null, calls: 0 };
  const maybeFail = (sql) => {
    if (st.failNext > 0) { st.failNext--; throw new Error('D1_ERROR: simulated outage'); }
    if (st.failOnSql && st.failOnSql.test(sql)) throw new Error('D1_ERROR: simulated failure on ' + sql.slice(0, 40));
  };
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  const run1 = (sql, args) => {
    maybeFail(sql); st.calls++;
    if (globalThis.__D1_SQL_LOG) globalThis.__D1_SQL_LOG.push({ sql, args });      // tools/audit-d1-queries.mjs --live: the statements a real request sent, with their real bindings
    const s = db.prepare(sql);
    const a = args.map(norm);
    if (/^\s*(select|with|pragma)/i.test(sql) || /\breturning\b/i.test(sql)) { const rows = s.all(...a); return { rows, meta: { changes: 0, rows_read: rows.length } }; }
    const r = s.run(...a);
    return { rows: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  const stmt = (sql, args = []) => ({
    sql, args,
    bind(...a) { return stmt(sql, a); },
    async run() { const r = run1(sql, args); return { success: true, results: r.rows, meta: r.meta }; },
    async all() { const r = run1(sql, args); return { success: true, results: r.rows, meta: r.meta }; },
    async first(col) { const r = run1(sql, args); const row = r.rows[0] || null; return row && col ? row[col] : row; },
    async raw() { const r = run1(sql, args); return r.rows.map((x) => Object.values(x)); },
  });
  return {
    _db: db, _state: st,
    prepare: (sql) => stmt(sql),
    async exec(sql) { maybeFail(sql); db.exec(sql); return { count: 1 }; },
    async batch(stmts) {
      db.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) { const r = run1(s.sql, s.args); out.push({ success: true, results: r.rows, meta: r.meta }); }
        db.exec('COMMIT');
        return out;
      } catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* already rolled back */ } throw e; }
    },
    query(sql, ...a) { return db.prepare(sql).all(...a); },
  };
}
