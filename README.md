# Branch Care

Branch Care is a safety-first CLI for inspecting and cleaning local Git branches.

It identifies merged, stale, current, and protected branches; previews eligible cleanup candidates; and deletes selected branches only after explicit confirmation using Git's safe `branch -d` behavior.

## Requirements

- Node.js 22 or newer
- Git

## Development setup

```bash
npm install
npm run build
npm test
```

To make the development build available as `branch-care`:

```bash
npm link
```

You can also invoke the compiled entry point directly:

```bash
node dist/src/index.js --help
```

## Commands

### Inspect local branches

```bash
branch-care status
```

Use a specific local base branch:

```bash
branch-care status --base develop
```

Base detection uses this precedence:

1. `--base <branch>`
2. Local branch referenced by `origin/HEAD`
3. `main`
4. `master`
5. `develop`

### Preview cleanup

```bash
branch-care clean --dry-run
```

Dry-run prints every eligible local branch and never mutates repository refs.

### Clean merged branches

```bash
branch-care clean
```

Interactive cleanup lets you select eligible branches, shows the final selection and count, and defaults confirmation to No. Each selected branch is revalidated immediately before deletion.

## Safety model

A deletion candidate must be:

- A local branch
- Merged into the resolved base branch
- Different from the current branch
- Different from the base branch
- Outside the protected branch rules

Built-in protected branches are:

```text
main
master
develop
staging
production
release/*
```

Branch age alone never makes a branch eligible for deletion. A branch is reported as stale after 60 complete days, but an unmerged stale branch is not a cleanup candidate.

Branch Care uses the equivalent of:

```bash
git branch -d -- <branch-name>
```

It does not use forced deletion, delete remote branches, fetch, or prune.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Success, cancellation, or safe no-op |
| `1` | Repository, analysis, interaction, or deletion failure |
| `2` | Invalid command or option |

## Current scope

The current MVP supports local branch status, dry-run, and interactive safe cleanup.

Not yet implemented:

- Configuration files and custom protected patterns
- Remote branch analysis or deletion
- Fetch/prune
- JSON output
- A no-subcommand interactive dashboard
- Forced deletion


## Testing

```bash
npm test
```

The test suite compiles the TypeScript project and runs unit, CLI subprocess, interactive pseudo-terminal, and disposable Git-repository integration tests using Node's built-in test runner.
