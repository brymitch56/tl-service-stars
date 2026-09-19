'use strict';
// The database handle. One file, WAL, foreign keys on.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const env = require('./lib/env');

const dataDir = env.DATA_DIR;
fs.mkdirSync(dataDir, { recursive: true });
const DB_PATH = process.env.DB_PATH || path.join(dataDir, 'stars.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

module.exports = { db, DB_PATH, dataDir };
