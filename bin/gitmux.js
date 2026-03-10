#!/usr/bin/env node

import { main } from "../src/main.js";

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write((err.message || String(err)) + "\n");
    process.exit(1);
  });
