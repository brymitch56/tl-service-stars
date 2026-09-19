'use strict';
// Apply every server/migrations/*.sql that has not run yet, in name order.
require('../lib/env');
const fs = require('fs');
const path = require('path');
const { db, DB_PATH } = require('../db');

const dir = path.join(__dirname, '..', 'migrations');
db.exec('CREATE TABLE IF NOT EXISTS migration (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');

const done = new Set(db.prepare('SELECT name FROM migration').all().map((r) => r.name));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
let applied = 0;
for (const f of files) {
  if (done.has(f)) continue;
  const sql = fs.readFileSync(path.join(dir, f), 'utf8');
  db.transaction(() => {
    db.exec(sql);
    db.prepare('INSERT INTO migration (name, applied_at) VALUES (?, ?)').run(f, new Date().toISOString());
  })();
  console.log(`applied ${f}`);
  applied += 1;
}
console.log(applied ? `${applied} migration(s) applied to ${DB_PATH}` : `up to date (${files.length} migrations) at ${DB_PATH}`);
