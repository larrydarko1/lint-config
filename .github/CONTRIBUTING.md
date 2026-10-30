# Contributing to @larrydarko/lint-config

This is a personal project, maintained by one person, and its defaults are that person's. **It is
not open to outside contributions**.

The code is MIT licensed. Forking it, learning from it, and publishing your own variant are all
explicitly fine — that is what the license is for.

## Reporting a security vulnerability

**Do not open a public issue.** Email <hello@larrydarko.dev> instead. See
[SECURITY.md](SECURITY.md) for what to include, what is in scope, and what to expect.

## Reporting a bug

Bug reports are welcome even though code contributions are not — use
[GitHub Issues](https://github.com/larrydarko1/lint-config/issues) and include the package version,
your Node version, the project family, and the smallest config and file that reproduce it. For a
gate, the output of `npx larry check <gate>` helps. There is no service-level promise attached:
issues are read, and fixed when they are worth fixing.

## Building it yourself

Building, testing and the release checks are documented in the
[README](../README.md#working-on-this-package). `npm run ci:check` runs everything the CI workflow
runs.
