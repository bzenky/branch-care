# Branch Care

Branch Care is a safety-first CLI for inspecting and cleaning local Git branches.

It identifies merged, stale, current, and protected branches; previews eligible cleanup candidates; and deletes selected branches only after explicit confirmation using Git's safe `branch -d` behavior.

> [!IMPORTANT]
> Branch Care is under active development and has not been published to npm. The package is intentionally marked private until the V1.0 release gate is complete.

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

Running the CLI without a subcommand prints the available commands and options:

```bash
branch-care
```

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
2. Repository `baseBranch` from `.branch-care.json`
3. Local branch referenced by `origin/HEAD`
4. `main`
5. `master`
6. `develop`

### Preview cleanup

```bash
branch-care clean --dry-run
```

Dry-run prints every eligible local branch and never mutates repository refs.

### Clean merged branches

```bash
branch-care clean
```

Interactive cleanup lets you select eligible branches, shows the final selection and count, and defaults confirmation to No. Each selected branch is revalidated immediately before deletion, including reloading repository configuration.

## Repository configuration

Branch Care reads an optional `.branch-care.json` file from the Git repository root, even when you run a command from a nested directory. Inspect the canonical effective configuration with:

```bash
branch-care config
```

A complete repository file has this shape:

```json
{
  "baseBranch": "main",
  "staleAfterDays": 60,
  "protectedBranches": [
    "main",
    "master",
    "develop",
    "staging",
    "production",
    "release/*",
    "team/*"
  ]
}
```

All three keys are optional when editing the file manually:

- `baseBranch` must be a non-empty string naming an existing local branch.
- `staleAfterDays` must be a safe integer greater than or equal to `1`.
- `protectedBranches` must be an array of non-empty strings.

Repository protections are additive: `protectedBranches` can add exact names or patterns but cannot remove the six built-in protections. In a pattern, `*` matches zero or more characters, including `/`; every other character is literal. Duplicate patterns are collapsed, with built-ins first and additions in bytewise ascending order.

An explicit CLI `--base <branch>` takes precedence over repository `baseBranch`, followed by local `origin/HEAD`, `main`, `master`, and `develop`. Configuration inspection leaves `baseBranch` as `null` when the file does not configure it; it does not report an automatically detected branch.

Set or update the repository base with:

```bash
branch-care config --base develop
```

This command validates the existing file and branch, preserves the effective stale threshold and additional protected patterns, and atomically writes a complete canonical `.branch-care.json` at the repository root.

Malformed JSON, unknown keys, invalid values, or a missing configured base are configuration errors. Branch Care prints the configuration path and actionable error to stderr, exits with exit code `1`, and performs no branch mutation. It never silently falls back from invalid repository intent.

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

Branch age alone never makes a branch eligible for deletion. By default, a branch is reported as stale after 60 complete days; `staleAfterDays` can change that reporting threshold, but an unmerged stale branch is not a cleanup candidate.

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

The current MVP supports local branch status, repository configuration, dry-run, and interactive safe cleanup.

Not yet implemented:

- Remote branch analysis or deletion
- Fetch/prune
- JSON output
- A no-subcommand interactive dashboard
- Forced deletion


## Testing

```bash
npm test
npm run package:smoke
```

The test suite compiles the TypeScript project and runs unit, CLI subprocess, interactive pseudo-terminal, and disposable Git-repository integration tests using Node's built-in test runner. The package smoke test creates the real npm tarball, inspects its contents, installs it into an isolated consumer project, and invokes the installed executable.

CI runs these checks on Linux and macOS with Node.js 22.

## Security

Please report confirmation bypasses, command injection, or unexpected branch mutations privately according to [`SECURITY.md`](SECURITY.md). Do not include credentials or private repository content in reports.

## License

Branch Care is available under the [MIT License](LICENSE).
