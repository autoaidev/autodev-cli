#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const compiled = path.join(__dirname, '..', 'out', 'cli.js');
if (!fs.existsSync(compiled)) {
  console.error('autodev-cli: missing compiled output.');
  console.error('Run `npm run build` inside the autodev-cli directory and try again.');
  process.exit(1);
}
require(compiled);
