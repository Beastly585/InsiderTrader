// worker/lib/sql.js
// Pure, dependency-free — extracted from neon-proxy.js specifically so the
// SQL-escaping logic (the injection-safety boundary for every query built in
// the Worker) can be unit tested in isolation.

export function sqlVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(v);
  return `'${String(v).replace(/'/g, "''")}'`; // same escaping convention used throughout neon-proxy.js
}
