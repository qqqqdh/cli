#!/usr/bin/env node
import { main } from '../src/index.js';

main(process.argv.slice(2)).catch((e) => {
  console.error(e?.stack ?? e);
  process.exit(1);
});
