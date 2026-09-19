'use strict';
require('./lib/env');
const env = require('./lib/env');
const { createApp } = require('./app');
const users = require('./lib/users');
const auth = require('./lib/auth');
const scheduler = require('./lib/scheduler');
const { DB_PATH } = require('./db');

async function main() {
  await users.bootstrapIfEmpty();
  auth.pruneSessions();
  const app = createApp();
  const server = app.listen(env.PORT, env.HOST, () => {
    console.log(`[stars] ${env.TROOP_NAME} Service Stars on http://${env.HOST}:${env.PORT}`);
    console.log(`[stars] database ${DB_PATH}`);
    if (env.PUBLIC_URL) console.log(`[stars] public at ${env.PUBLIC_URL}`);
  });
  scheduler.start();
  // Expired sessions accumulate otherwise; once an hour is plenty.
  const prune = setInterval(() => auth.pruneSessions(), 3600e3);
  if (prune.unref) prune.unref();
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { server.close(() => process.exit(0)); });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
