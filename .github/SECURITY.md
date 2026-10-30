# Security Policy

## What the package does on your machine

`@larrydarko/lint-config` runs on developer machines and in CI, with the permissions of whoever runs
it:

- **It runs your config.** `larry check` imports `larry.config.ts`, and ESLint, Prettier,
  Stylelint, commitlint and knip import their own config files. Those files are code, and running
  them is running the project.
- **It spawns processes without a shell.** Every child process — git, npm, tar, knip, jscpd, tsc —
  is started with an argument list, never a command string, so a file name cannot become a command.
- **It reaches the network only through npm.** The `audit` gate runs `npm audit`, which queries the
  registry. Nothing else in the package makes a network request, and there is no telemetry.
- **It writes only where you ask it to.** `larry init` and `larry upgrade` write into the project,
  and the `declaration-order` gate rewrites import blocks under `--fix`. The `publish` and
  `duplication` gates work in a temporary directory and delete it afterwards.
- **It truncates what it finds.** The `secrets` gate prints the first few characters of a match,
  never the whole value, so a CI log does not become a second copy of the secret.

## Reporting a Vulnerability

**Do not open a public issue.** Email the maintainer at <hello@larrydarko.dev> instead. Email is the
only private channel, so a report sent any other way risks being public.

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if applicable)

Expect an acknowledgement within a week. The package is maintained by one person, so a fix timeline
depends on severity; you will be told which release carries the fix, and credited in it unless you
ask not to be.

## Scope

**The files in a repository are untrusted input.** The gates read source, lockfiles, workflows,
`.env` files and manifests, and people run them on code they did not write: a pull request in CI, a
cloned project. Anything a crafted file can make the package do beyond reporting on it is in scope.

In scope:

- A source file, lockfile, workflow or manifest that makes a rule, a gate or the CLI run code,
  spawn a process, or read or write a file it otherwise would not
- `larry init`, `larry upgrade` or a gate's `--fix` writing or deleting a file outside the project
- A gate printing a secret in full, or copying repository contents anywhere but its own output
- An advisory in a dependency that is reachable through this package's own code

Out of scope: anything that needs write access to the project's config files. `larry.config.ts`,
`eslint.config.js` and the rest are code by design, and whoever can edit them can already run
anything the person running the check can.

Also out of scope: a gate that misses something. The gates are static checks, and each one prints
what it does not machine-check. A secret shape the `secrets` gate does not know, or a workflow the
`pipeline` gate should have rejected, is a bug — open an issue.

## Supported Versions

Security issues are fixed in the latest release only. There are no backports — upgrading is the
remediation path, and `npx larry upgrade` migrates `larry.config.ts` across releases.
