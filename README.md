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

Human status includes both `upstream: <name-or-none>` and `upstream state: <state>` for each displayed branch. The upstream state is `none` when no upstream is configured, `tracking` when the configured full ref exists locally, and `gone` when that configured ref is absent locally.

#### Versioned JSON status

Use schema-version-1 machine-readable status for scripts:

```bash
branch-care status --json
```

A complete schema-version-1 document has this shape:

```json
{
  "schemaVersion": 1,
  "repository": "example-repository",
  "baseBranch": {
    "name": "main",
    "source": "main"
  },
  "currentBranch": "main",
  "detachedHead": false,
  "staleAfterDays": 60,
  "branches": [
    {
      "name": "main",
      "lastCommitAt": "2025-03-01T12:00:00.000Z",
      "daysSinceLastCommit": 0,
      "author": "Example Author",
      "upstream": "origin/main",
      "upstreamState": "tracking",
      "isCurrent": true,
      "isMerged": true,
      "isStale": false,
      "isProtected": true,
      "isDeletionCandidate": false
    }
  ]
}
```

`baseBranch.source` is exactly one of `cli`, `repository`, `originHead`, `main`, `master`, or `develop`, identifying the winning precedence source. `upstreamState` is exactly one of `none`, `tracking`, or `gone`. State `none` always has `upstream: null`; `tracking` and `gone` retain the configured short upstream name. A detached HEAD is represented by `currentBranch: null` and `detachedHead: true`.

The `branches` array contains every local branch, including current, base, and protected branches, in bytewise ascending branch-name order. Successful output is two-space-indented JSON on stdout with one trailing newline. Failures print the existing actionable message to stderr, leave stdout empty, and use exit code `1`; command-line usage errors use exit code `2` and also emit no JSON document.

Status is a local, read-only view: it performs no fetch and no prune, does not push or delete refs, and does not modify repository configuration or working-tree files. Consequently, `tracking` and `gone` describe Git's current local knowledge rather than network freshness.

### Inspect locally known remote branches

```bash
branch-care remote
```

The remote command is a read-only inspection of concrete remote-tracking refs currently present in the local `refs/remotes/` namespace. It keeps the full short name, such as `origin/feature/login`, and reports the commit timestamp, age, author, and whether the ref is merged into the resolved local base branch.

Symbolic refs such as `origin/HEAD` are pointers rather than remote branches and are excluded. The command also lists local branches whose configured upstream state is `gone`; this means the configured upstream ref is absent from the local ref namespace, not that the server branch has definitely been deleted. Branches with no configured upstream (`none`) are not included in that missing-upstream section.

Remote inspection performs no `fetch`, `fetch --prune`, `prune`, `push`, local deletion, remote deletion, or other ref update. It reports local Git knowledge only. To refresh that knowledge from a server, a later explicit fetch or prune operation is required; that operation is not part of `branch-care remote`.

Remote output is human-readable and deterministic. It does not add a remote JSON document in this slice; `status --json` remains the versioned machine-readable contract.

### Refresh and prune remote-tracking refs

Preview the fetch/prune operation for a repository with one configured remote:

```bash
branch-care prune --dry-run
```

Select a remote explicitly:

```bash
branch-care prune --remote origin --dry-run
branch-care prune --remote origin
```

Each invocation operates on exactly one remote. Without `--remote`, Branch Care selects the sole configured remote, reports a safe no-op when none exist, and requires `--remote <name>` when multiple remotes exist. Fetch refspecs must write only beneath that remote's `refs/remotes/<name>/` namespace; configurations that could update local branches, tags, or another namespace are rejected before network access.

A dry run contacts the selected remote and displays Git's advisory preview without changing refs. A non-dry-run invocation requires an interactive terminal, shows the preview, and asks `Apply fetch and prune for '<remote>'?`; the default is No. There is no unattended confirmation-bypass option.

The bounded operation uses the equivalent of `git fetch --prune --atomic --no-tags --no-recurse-submodules --no-write-fetch-head --no-progress`. It can create or refresh remote-tracking refs as well as remove stale ones and may download Git objects. It does not update or prune tags, recurse into submodules, write `FETCH_HEAD`, modify local branches or working-tree files, or push. It does not delete branches from the server. Configured remote URLs are redacted from displayed Git reports and errors.

The preview is advisory rather than a frozen server snapshot: server state can change between preview and confirmed execution. Run `branch-care remote` afterward to inspect the refreshed local remote-tracking state.

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

Local cleanup does not use forced deletion, delete remote branches, fetch, or prune. Only the explicit `prune` command performs the bounded network fetch/prune operation described above.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Success, cancellation, or safe no-op |
| `1` | Repository, analysis, interaction, or deletion failure |
| `2` | Invalid command or option |

## Current scope

The current MVP supports local and locally known remote branch status, repository configuration, remote fetch/prune preview and confirmation, local cleanup dry-run, and interactive safe cleanup.

Not yet implemented:

- Remote branch deletion or `clean --remote`
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
