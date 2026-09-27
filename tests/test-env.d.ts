// The tests run under Bun. Only the test typecheck loads Bun's globals, so app
// code that runs on Node cannot use them by mistake.
/// <reference types="bun-types" />

// Build and release scripts are plain .mjs files with no type declarations.
declare module '*.mjs';
