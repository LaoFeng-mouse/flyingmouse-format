#!/usr/bin/env node

const path = require('node:path');
const { inspectPeFile } = require('../pe-metadata');

const USAGE = 'Usage: node scripts/inspect-pe.js <path-to-exe>';

function main(argv = process.argv.slice(2), streams = {}) {
  const stdout = streams.stdout || process.stdout;
  const stderr = streams.stderr || process.stderr;

  if (argv.length !== 1) {
    stderr.write(`${USAGE}\n`);
    return 1;
  }

  const absolutePath = path.resolve(argv[0]);
  try {
    const metadata = inspectPeFile(absolutePath);
    stdout.write(`${JSON.stringify({ path: absolutePath, ...metadata }, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr.write(`Failed to inspect PE file: ${message}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { main };
