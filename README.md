# reprokit

Zero-dependency Node 24 ESM CLI for scaffolding GitHub issue reproductions and recording before/after verification proof blocks.

## Requirements

- Node.js 24+
- GitHub CLI (`gh`) authenticated for live `reprokit init` calls

> Windows PowerShell note: use `npm.cmd` (for example `npm.cmd test`) when PowerShell execution policy blocks `npm.ps1`. `reprokit check` automatically normalizes leading `npm` / `npx` commands to `.cmd` on Windows.

## Usage

```bash
# Scaffold reproduction files from owner/repo#num or a GitHub issue URL
node ./bin/reprokit.js init owner/repo#123 --repo-dir .
node ./bin/reprokit.js init https://github.com/owner/repo/issues/123 --repo-dir . --json

# Record failing reproduction before applying fix (expects non-zero exit -> REPRODUCED)
node ./bin/reprokit.js check .reprokit/repro-123.mjs --phase before --repo-dir .

# Record passing reproduction after applying fix (expects zero exit -> VERIFIED_FIXED)
node ./bin/reprokit.js check .reprokit/repro-123.mjs --phase after --repo-dir .

# Emit a PR-ready Markdown proof block
node ./bin/reprokit.js summary --repo-dir .
```

## Artifacts

`reprokit` stores workspace artifacts in `<repoDir>/.reprokit/`:

- `issue-<num>.json` - Structured issue metadata, stack trace file/line refs, code blocks, and matching repo tests
- `repro-<num>.mjs` - Runnable Node ESM reproduction script scaffold
- `issue-<num>.md` - Markdown triage summary
- `proof.json` - Recorded `before` and `after` command runs, exit codes, and outputs

## Testing

```bash
node --test
# or on Windows PowerShell:
npm.cmd test
```
