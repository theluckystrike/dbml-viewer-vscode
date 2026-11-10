'use strict';
// Synthetic schemas for the tests, built in code (no fixture files).

/** A DBML schema with n tables in a chain plus a few cross references. */
function bigDbml(n, cols = 3) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(`Table t${i} {`, '  id integer [pk, increment]');
    for (let c = 1; c < cols; c++) out.push(`  c${c} varchar(40)`);
    if (i) out.push(`  parent_id integer [ref: > t${i - 1}.id]`);
    out.push('}');
  }
  return out.join('\n');
}

/** The same in PostgreSQL DDL */
function bigSql(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`CREATE TABLE t${i} (id serial PRIMARY KEY, name text${i ? `, parent_id int REFERENCES t${i - 1}(id)` : ''});`);
  return out.join('\n');
}

const XSS = '<img src=x onerror=alert(1)>';

module.exports = { bigDbml, bigSql, XSS };
