#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { main } from './main.js';

// `claude-usage --json | head -1`: the reader left, so there is nothing left to say.
process.stdout.on('error', (error) => {
  if ('code' in error && error.code === 'EPIPE') process.exit(0);
  throw error;
});

main(process.argv.slice(2), { entry: fileURLToPath(import.meta.url) }).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`claude-usage: erro inesperado: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
