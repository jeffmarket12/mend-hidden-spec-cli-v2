# Progress: Clean-room rewrite of `mend`

## Status
- [x] Section 1: Types & small utilities
- [x] Section 2: Argument parsing, CLI, errors, exit codes
- [x] Section 3: Patch format detection & unified-diff parser
- [x] Section 4: SEARCH/REPLACE + V4A + JSON parsers
- [x] Section 5: Matching engine (exact, whitespace-insensitive, indent-insensitive)
- [x] Section 6: Apply logic (edits, create/delete/rename, EOF chunks, strict, --check)
- [x] Section 7: Main flow & invocation
- [x] Testing & Iteration (`node check.ts practice.json`)
- [x] Fix JSON detection in detectFormat and S/R creation in parseSearchReplace
