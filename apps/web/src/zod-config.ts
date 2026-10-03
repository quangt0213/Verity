import { z } from "zod";

// Zod 4 probes `new Function` to JIT-compile parsers. The production CSP
// forbids eval (script-src has no 'unsafe-eval'), so use the interpreter.
// Imported first in main.tsx, before any schema parses.
z.config({ jitless: true });
