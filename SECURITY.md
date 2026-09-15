# Security policy

## Supported versions

Branch Care is under active development and has not reached its first npm release. Security fixes are applied to the latest revision of the `main` branch.

## Reporting a vulnerability

Please do not report security vulnerabilities in a public issue.

Use GitHub's private vulnerability reporting for this repository:

https://github.com/bzenky/branch-care/security/advisories/new

Include:

- The affected command and options
- The Git and operating-system versions
- A minimal disposable-repository reproduction
- The expected and observed branch or ref changes
- Any evidence that a protected, current, base, unmerged, or remote branch can be changed unexpectedly

Do not include credentials, access tokens, or private repository contents.

## Safety scope

Branch Care invokes local Git commands and can delete local branches after interactive confirmation. Reports involving command injection, confirmation bypass, incorrect eligibility classification, unexpected remote mutation, or forced deletion are treated as security-sensitive.
