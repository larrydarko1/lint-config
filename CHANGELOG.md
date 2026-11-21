# Changelog

All notable changes to `@larrydarko/lint-config` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before 1.0, a minor version may break, and each one that does says how to upgrade.

## [Unreleased]

### Upgrading

1. If the project has no `CHANGELOG.md`, add one: `# Changelog`, a line saying the format is based
   on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), then `## [Unreleased]`. Rename one
   kept under another name (`changelog.md`, `CHANGES.md`) with `git mv`.
2. Give every release its own `## [version] - YYYY-MM-DD` heading, newest first. A heading that
   groups several versions (`## 1.4.0 – 1.4.9 - …`) becomes one for the last of them, with the
   range said in the text under it.
3. Name the version scheme in the changelog's intro, beside the format: [Semantic
   Versioning](https://semver.org/spec/v2.0.0.html) in an `electron`, `tauri`, `vs-extension` or
   `library` project, [calendar versioning](https://calver.org/) in an `api`, `fullstack` or `spa`
   one. In a calendar-versioned project, set every `package.json` `version` to the root's, in
   `YYYY.M.PATCH` (or `0.0.0` before the first release).
4. In a base project, say how its releases are numbered in `larry.config.ts`: `versioning: 'semver'`
   if someone can stay on an old copy, `versioning: 'calver'` if everyone gets the latest.
5. A script that calls `checkChangelog` or `checkPackageJson` itself passes the scheme:
   `checkChangelog({ versioning: 'semver' })`.
6. Run `npx larry check`. If it names an option a gate does not take, remove that line from
   `larry.config.ts`, or fix its spelling. Before, such an option was ignored without a word, so
   the gate ran on its default.

### Added

- This changelog, with the steps to upgrade to each release that breaks something. The README's
  upgrade section points to it.
- **Breaking:** the `changelog` gate, in every family. `CHANGELOG.md` opens with `# Changelog` and
  an intro naming Keep a Changelog, then `## [Unreleased]`, then one `## [version] - YYYY-MM-DD`
  per release: a real date that isn't after today, no version twice, newest first. `larry init`
  writes one.
- **Breaking:** each family fixes how its releases are numbered: semver for `electron`, `tauri`,
  `vs-extension` and `library`, calendar versioning (`YYYY.M.PATCH`) for `api`, `fullstack` and
  `spa`. A base project names its own with `versioning`, and must. The README's Versioning section
  says why.
- **Breaking:** the `changelog` gate checks that the intro names the scheme and that every release
  is numbered by it. Under calendar versioning, a release's year and month are the ones in its date.
- **Breaking:** the `package-json` gate holds the root's `version` to the scheme, and under calendar
  versioning every workspace's to the root's. A semver version with a leading zero (`1.08.0`) now
  fails too.
- `larry init base` takes `--versioning semver` or `calver`, and asks for it at a terminal. The
  changelog init writes names the project's scheme.
- **Breaking:** `larry check` refuses a gate option the gate does not take, such as one a release
  removed (`refactoring`'s `tracker`) or a misspelt one, and lists the options it does take. It
  used to pass the option to the gate, which never read it.

## [0.2.0] - 2026-11-19

A new family for VS Code extensions, one brace style, and three things the `refactoring` gate
now refuses.

### Upgrading

Run each step, then `npm run ci:check` at the end. Lint before and after the upgrade and read the
difference: most of it comes from the brace style.

1. Install it: `npm i -D @larrydarko/lint-config@0.2.0`.
2. Apply the brace style: `npx eslint . --fix`, then `npx prettier --write .`, then `npx eslint .`
   to confirm nothing is left. A second run changes nothing. Most files get shorter, so lower their
   `code-style` `baseline` entries and remove the ones now under the softcap.
3. If a `todo.md` is committed, move its items to wherever you track work outside the repo and
   delete the file. Remove `tracker` and `requireCheckboxes` from the `refactoring` options: they
   are no longer read.
4. If `CLAUDE.md`, `CLAUDE.local.md` or anything in `.claude/` is committed, untrack it with
   `git rm --cached <file>` and add it to `.gitignore`. The file stays on your disk.
5. If a workflow publishes a GitHub release, give it `cancel-in-progress: false`, and group its
   `concurrency` by `github.workflow` (or by `github.ref` for a tag-triggered release), not by commit.
6. In the `spa` and `fullstack` families, delete the `overrides` blocks that set
   `no-restricted-syntax` or `no-restricted-imports` for an area the family now covers. A later
   block replaces the family's list instead of adding to it, so keeping yours switches the family's
   rules off. If you need an extra selector, spread the exported ones into your block.
7. Rename single-letter variables in test suites (`$` included; `i`, `j` and `_` stay allowed),
   and replace `fileURLToPath(import.meta.url)` there with `import.meta.dirname`.
8. In the `fullstack` family, move each service's `new MongoClient` into that service's
   `src/lib/db.ts`.

### Added

- The `vs-extension` family, for a VS Code extension: `preset: 'vs-extension'`,
  `vsExtensionStandards()` from `/eslint/vs-extension`, and `larry init` can set one up. The
  source may not make a blocking `fs` or `child_process` call (`larry/no-sync-io`) or drop a
  Disposable (`larry/no-floating-disposable`), and `src/lib/` never loads `vscode`, so Vitest can
  run it.
- The `extension-manifest` gate: an extension's `package.json` agrees with its source (commands,
  views, settings), and its activation, workspace trust and packaging are declared.
- `testing` options: `otherRunners`, for suites another runner finds and runs, and
  `e2e.runner: 'vscode-test'`, for an E2E suite that runs inside a real editor.
- `code-style` headers of kind `owns`: the file's opening comment names what it owns
  (`Owns:`) and what it doesn't (`Does NOT own:`). In TypeScript and in Rust.
- `pipeline` rule 20: a workflow that publishes a GitHub release is one queue that never cancels
  and isn't grouped by commit.
- `refactoring` refuses `CLAUDE.md`, `CLAUDE.local.md` and `.claude/` in anything git would
  commit. With `claudeCode: true`, it also holds the local, gitignored copies to one layout.
- At a terminal, `larry check` shows a spinner with the running gate, its progress and the time
  taken. In a pipe or CI the output is unchanged.

### Changed

- **Breaking:** `larry/curly-inline` sets one brace style, and `--fix` applies it. A body that is
  one plain statement goes beside its `if` or loop without braces when the line fits in Prettier's
  width; every other body gets braces, and the branches of one `if` match. It comes last, so
  `overrides` can't switch it off.
- **Breaking:** `refactoring` refuses a committed `todo.md`, in any casing, and its `tracker` and
  `requireCheckboxes` options are gone. Deferred work is tracked outside the repo.
- **Breaking:** the `spa` family wires `no-restricted-syntax` and `no-restricted-imports` for each
  area (the app's source, `utils/`, the tests), and `fullstack` is now composed from the `spa` and
  `api` areas, so neither needs hand-written `overrides` to be complete.
- **Breaking:** test suites get the source's naming rules: no single-letter variables and no
  `fileURLToPath`.
- **Breaking:** in `fullstack`, each service builds its one database client in its own
  `src/lib/db.ts`, and a shared package loads no Vue, server framework or driver.
- A layering ban (a shared package on a driver, `utils/` on `lib/`, `lib/` on `services/`) now
  lets `import type` through, because a type import is erased before anything runs.
- lint-staged runs Prettier, then `eslint --fix`, then Prettier again on `.ts` and `.vue` files,
  so the brace rule measures the line Prettier laid out, as CI does.

### Fixed

- `larry doctor` names the config file the project actually has when it suggests leaving the
  `base` family, instead of always saying `larry.config.ts`.

## [0.1.0] - 2026-11-02

The first stable release, after eleven pre-releases (0.1.0-beta.0 to 0.1.0-beta.10, published as
`latest` from 2026-09-28 to 2026-10-26).

### Added

- `larry()`, a flat ESLint config built from a family preset: `fullstack`, `api`, `electron`,
  `library`, `spa`, `tauri`, or `base` for anything else. Each family exports its standards blocks,
  and the selectors and banned-import lists they are built from.
- Shared configs for Prettier, Stylelint, commitlint, lint-staged and knip.
- The `larry` CLI: `check` runs the CI gates named in `larry.config.ts`, `init` sets up a project,
  `doctor` explains what is wrong with a setup, and `upgrade` moves an older setup to the current
  one.
- The CI gates, from `audit`, `secrets` and `licenses` to the family-specific ones for the API
  contract, the database, Electron, Tauri and the pipeline. The README lists them all.
- Response schemas, the API and job contracts, and the response-leak and server-error tripwires.
- Every tool and plugin is a dependency pinned to an exact version, so projects don't install
  their own. Node 24 or later.

[Unreleased]: https://github.com/larrydarko1/lint-config/compare/0.2.0...HEAD
[0.2.0]: https://github.com/larrydarko1/lint-config/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/larrydarko1/lint-config/releases/tag/0.1.0
