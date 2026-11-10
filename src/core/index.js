'use strict';
// One entry point for the readers: the kind comes from the file name or the language id.
const { parseDbml } = require('./dbml');
const { parseSql } = require('./sql');
const { parsePrisma } = require('./prisma');
const { summary } = require('./model');

function kindOf(fileName, languageId) {
  const f = String(fileName || '').toLowerCase();
  if (languageId === 'dbml' || f.endsWith('.dbml')) return 'dbml';
  if (languageId === 'prisma' || f.endsWith('.prisma')) return 'prisma';
  if (/^(sql|mysql|pgsql|postgres|plsql|tsql|sqlite|mssql|oraclesql|sql-bigquery)$/.test(String(languageId || '')) || /\.(sql|ddl|psql|pgsql|mysql)$/.test(f)) return 'sql';
  return '';
}

function parse(text, kind) {
  if (kind === 'sql') return parseSql(text);
  if (kind === 'prisma') return parsePrisma(text);
  return parseDbml(text);
}

/** Cheap test for the SQL editor title button: does the text create a table? */
function hasCreateTable(text) { return /\bcreate\s+(?:or\s+replace\s+)?(?:(?:global|local)\s+)?(?:temp(?:orary)?\s+|unlogged\s+)?table\b/i.test(String(text || '').slice(0, 4 * 1024 * 1024)); }

module.exports = { parse, kindOf, hasCreateTable, summary };
