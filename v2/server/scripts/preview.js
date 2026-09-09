// A separate local server and database. Never loads production data or .env.
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '../../..');
const web = path.join(root, 'v2/web/dist-preview');
if (!fs.existsSync(path.join(web, 'index.html'))) {
  console.error(
    'Build the preview first: cd v2/web && pnpm exec tsc -b && pnpm exec vite build --outDir dist-preview',
  );
  process.exit(1);
}
const port = Number(process.env.PULSAR_PREVIEW_PORT || 8891);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid preview port');
process.env.PORT = String(port);
process.env.PULSAR_HOST = '127.0.0.1';
process.env.PULSAR_ORIGIN = `http://127.0.0.1:${port}`;
process.env.PULSAR_WEB_DIST = web;
process.env.PULSAR_DATA_DIR = path.join(root, 'v2/server/.preview-data');
process.env.PULSAR_V1_POINTS = path.join(
  process.env.PULSAR_DATA_DIR,
  'no-legacy-import.json',
);
console.log(`Pulsar local preview: ${process.env.PULSAR_ORIGIN}/connect`);
console.log('Database: v2/server/.preview-data — separate from production');
require('../src/index');
