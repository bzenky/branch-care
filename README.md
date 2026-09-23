# Branch Care

Branch Care is a safety-first CLI for inspecting and cleaning local Git branches.

It identifies merged, stale, current, and protected branches; previews eligible cleanup candidates; and deletes selected branches only after explicit confirmation using Git's safe `branch -d` behavior.

> [!IMPORTANT]
> Branch Care is under active development and has not been published to npm. The scoped package `@bzenky/branch-care` is intentionally marked private until the V1.0 release gate is complete. Installing it by registry name, including `npm install -g @bzenky/branch-care`, is unavailable and unsupported before V1.

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

## Reviewing a release-candidate artifact

Maintainers can manually dispatch the **Release readiness** workflow for a reviewed commit. This repository is public, while artifact download follows GitHub Actions access controls. The artifact is named `bzenky-branch-care-0.1.0-<full-commit-sha>`, is retained for 7 days, and contains only `bzenky-branch-care-0.1.0.tgz` and `bzenky-branch-care-0.1.0.tgz.sha256`. It is not an npm publication, GitHub Release asset, deployment, or secret storage: never place credentials or private content in an Actions artifact.

The workflow and artifact are review aids, not an npm release. They do not publish, tag, create a GitHub Release, or deploy anything. Node.js 22 or newer is required to review or run the candidate. After downloading both files into the same directory, verify the checksum with this cross-platform Node command:

```bash
node -e "const fs=require('node:fs'),c=require('node:crypto');const n='bzenky-branch-care-0.1.0.tgz';const expected=fs.readFileSync(n+'.sha256','utf8').split(/\\s+/)[0];const actual=c.createHash('sha256').update(fs.readFileSync(n)).digest('hex');if(actual!==expected)throw new Error('SHA-256 mismatch');console.log(actual)"
```

Install and inspect the downloaded tarball under an isolated temporary global prefix rather than installing by package name:

```bash
npm install --global --ignore-scripts --prefix ./branch-care-review ./bzenky-branch-care-0.1.0.tgz
./branch-care-review/bin/branch-care --version
./branch-care-review/bin/branch-care --help
```

On Windows, invoke `branch-care-review\\branch-care.cmd` instead of the `bin/branch-care` path. Ephemeral execution must also select the absolute tarball explicitly; replace `/absolute/path/to` with the downloaded artifact directory:

```bash
npm exec --yes --package=/absolute/path/to/bzenky-branch-care-0.1.0.tgz -- branch-care --version
npm exec --yes --package=/absolute/path/to/bzenky-branch-care-0.1.0.tgz -- branch-care --help
```

An unauthenticated npm registry query for exact name `@bzenky/branch-care` returned `E404` on 2026-09-22. This is dated, informational evidence only: it does not establish ownership, reserve the name, guarantee continued availability, or gate this non-publishing workflow.

## Commands

Running the CLI without a subcommand in an interactive terminal opens a one-shot repository menu:

```bash
branch-care
branch-care --base develop
```

The menu prints the repository and resolved base branch, then offers these actions in order:

1. `Show local status`
2. `Clean local branches`
3. `Show remote status`
4. `Prune remote-tracking references`
5. `Clean remote branches`
6. `Show repository configuration`
7. `Exit`

One selection runs one existing workflow and then exits with that workflow's status. Prune and remote cleanup automatically use a sole configured remote; when multiple remotes exist, the menu asks `Select a remote:` before any network access. Selecting Exit or cancelling the menu or remote selector prints `No action was run.` and changes nothing. Active-prompt cancellation is an exit-`0` safe no-op: it prints the command-specific no-op message to stdout and leaves repository, server, and recovery state unchanged.

When stdin or stdout is not an interactive terminal, bare `branch-care` prints help and exits without inspecting the repository or waiting for input. Scripts should continue to use explicit subcommands.

### Undo cleanup

Successful local or remote cleanup prints a rollback operation ID and an exact command. Recovery history is explicit, appears in root help, and is intentionally not added to the seven-choice root menu.

```bash
branch-care undo                         # restore the newest recoverable cleanup
branch-care undo <operation-id>          # restore one exact cleanup
branch-care undo --list                  # list history newest first
branch-care undo --discard <operation-id>
```

Restore and discard previews show the exact branches and use a confirmation whose default is No. Remote restore then requires the exact remote name. It re-resolves the configured remote, verifies every saved object and that every server branch is still absent, and performs one atomic push with an absence lease for every branch; there is no non-atomic fallback. Existing or changed remote branches block the entire batch.

Each repository keeps at most 10 recoverable cleanup operations, with no expiration and no automatic eviction. At capacity, real cleanup is blocked until `branch-care undo --discard <operation-id>` frees a slot; dry runs still show candidates and the block. Local restore never overwrites a branch. Non-conflicting branches restore independently, while conflicts, missing objects, and failed ref creation remain in a partial operation for retry.

Receipts and `history.lock` are private files under `branch-care/undo/` in the common Git directory shared by linked worktrees. Saved commits are retained by private `refs/branch-care/undo/<operation-id>/...` refs, which intentionally prevent Git garbage collection until successful undo or confirmed discard. Do not edit these files or refs manually.

Undo restores branch refs only. It does not restore or alter the working tree, index, HEAD, tags, commits created after deletion, pull requests, CI effects, hosting metadata, downstream automation, or repository configuration. It does not merge, rename, force-move, or overwrite an existing branch.

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

Dry-run prints every eligible local branch, remains non-interactive, and never mutates repository refs. It reads capacity without acquiring a creating lock and never reconciles or mutates recovery state.

### Clean merged branches

```bash
branch-care clean
```

Interactive cleanup lets you select eligible local branches, shows the final selection and count, and defaults confirmation to No. After confirmation and under the shared recovery lock, local recovery is reconciled, capacity is rechecked, and each selected branch is revalidated immediately before durable recovery preparation and deletion, including reloading repository configuration. Without `--remote`, cleanup remains local-only and performs no remote access.

Limit either local and remote cleanup to older safe candidates with the invocation-only option:

```bash
branch-care clean --older-than 30d
branch-care clean --remote origin --older-than 30d
```

`--older-than <duration>` accepts positive whole days only: a positive safe integer followed immediately by lowercase `d`. The boundary is inclusive and uses complete days, so `--older-than 30d` includes a branch aged exactly 30 complete days. Omitting the option preserves the existing cleanup behavior and output unchanged. This option only narrows branches already safe under the merged, current, base, default, and protection rules; age never makes an unsafe or unmerged branch deletable. The root interactive menu does not ask for an age and continues to run unfiltered cleanup.

### Delete merged branches from a remote server

Preview server deletion for one remote:

```bash
branch-care clean --remote origin --dry-run
```

Run the interactive flow:

```bash
branch-care clean --remote origin
```

A remote deletion candidate must use the standard one-to-one branch fetch mapping, have a live server tip exactly equal to its local remote-tracking tip, be merged into the resolved local base, and be outside current, base, live remote-default, built-in, and repository protection rules. If the remote name is omitted, Branch Care accepts only a sole configured remote; it never operates across more than one remote per invocation.

Remote candidates use full names such as `origin/feature/login`, are bytewise ordered, and are initially unchecked. After selection, Branch Care shows every selected name and count, asks a default-No confirmation such as `Delete 2 branches from 'origin'?`, and then requires exact entry at `Type 'origin' to confirm remote deletion:`. Cancellation, a decline, empty selection, or mismatched input changes nothing.

After both confirmations and under the shared recovery lock, Branch Care reconciles only applicable recovery for the selected remote against its pinned endpoint, rechecks total capacity, and final revalidation reloads configuration, current/base/default/protection facts, local tracking object IDs, and live server object IDs from the effective push destination. Branch Care then sends one push with `--atomic`, restrictive no-tags/no-submodules flags, one `--force-with-lease=refs/heads/<branch>:<expected-oid>` per branch, and explicit delete refspecs. A changed tip rejects its lease, and a server without atomic-push support fails safely with no non-atomic fallback. Multiple configured push URLs are refused because separate servers cannot form one atomic transaction.

Remote cleanup deletes only the selected exact server branch refs. It does not delete local branches, push commits or tags, update unrelated server refs, or recurse into submodules. It redacts configured remote URLs from reported errors. If local tracking data differs from the server, run `branch-care prune --remote <name>`, review the refreshed state, and retry explicitly.

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

Local cleanup does not use forced deletion, delete remote branches, fetch, or prune. Only explicit `prune` and `clean --remote` modes perform their bounded network operations described above.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Success or intentional safe no-op, including active-prompt cancellation |
| `1` | Operational, repository, Git, network, recovery, prompt, or interaction-requirement failure |
| `2` | Command grammar, option-value, or mutually-exclusive-input usage failure (exit `2`) |

Successful domain output, progress, and intentional no-op messages use stdout. Diagnostics use stderr. Failures before progress leave stdout empty; partial local cleanup or restore keeps successful progress and the final count on stdout while failed, skipped, or unresolved items use stderr and produce exit `1`. Real cleanup, prune, restore, and discard require interactive stdin and stdout; this rejection occurs before repository, Git, network, prompt, or recovery work.

## Current scope

The current V0.10 scope implements the seven-choice one-shot root menu, local and locally known remote branch status, repository configuration, remote fetch/prune preview and confirmation, local and remote cleanup dry-runs, interactive safe cleanup, exact leased atomic remote branch deletion, and the complete cleanup recovery workflow exposed by `branch-care undo`.

Forced deletion is intentionally not implemented.


## Testing

```bash
npm test
npm run package:smoke
```

The test suite compiles the TypeScript project and runs unit, CLI subprocess, interactive pseudo-terminal, and disposable Git-repository integration tests using Node's built-in test runner. The package smoke test creates the real npm tarball, inspects its contents, installs it into an isolated consumer project, and invokes the installed executable.

CI runs the complete build, test, interactive-terminal, and packed-package checks with Node.js 22 on Windows, Ubuntu/Linux, and macOS.

## Security

Please report confirmation bypasses, command injection, or unexpected branch mutations privately according to [`SECURITY.md`](SECURITY.md). Do not include credentials or private repository content in reports.

## License

Branch Care is available under the [MIT License](LICENSE).
