// src/server/loadEnv.ts
//
// Must be the FIRST import in server.ts. In an ESM project, all `import`
// statements in a file are hoisted and their target modules are fully
// evaluated, in dependency order, before any of the importing file's own
// top-level statements run. That means a `dotenv.config()` call sitting in
// server.ts's own body — even textually above other imports — actually runs
// AFTER every imported module (including pipeline.ts) has already finished
// evaluating. Any module-top-level `process.env.X` read (like
// USE_SINGLE_CALL_GENERATION in pipeline.ts) would see env vars as
// undefined.
//
// By putting dotenv.config() inside its own module and importing THAT module
// first, the config() call becomes part of the import-graph evaluation phase
// itself, so it runs before sibling imports like pipeline.ts are evaluated.

import dotenv from "dotenv";

// Exported (rather than left as a bare side-effect import) so consumers use
// a normal named import. This also sidesteps TS 6's noUncheckedSideEffectImports
// check (TS2882), which can misfire on bare `import "./x"` side-effect imports
// under moduleResolution: "bundler" even when the file resolves fine at runtime.
export function loadEnv(): void {
  dotenv.config({ path: ".env.local" });
}

// Still run immediately on import, so timing is identical to before —
// callers don't have to remember to invoke it.
loadEnv();