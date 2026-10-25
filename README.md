# @larrydarko/lint-config

Formatting, linting, commit rules and CI quality gates for my projects, kept in one package so a
rule is changed once and every project picks it up on its next update.

It is opinionated and built for six kinds of project:

- **fullstack**: a Vue frontend and an Express API as npm workspaces, with a worker, a database
  and a websocket gateway.
- **api**: an Express API in one package, with its clients in other repositories.
- **electron**: a Vue desktop app split into main, preload and renderer.
- **library**: a TypeScript package published to npm, tested with `node --test`. This package is one.
- **spa**: a Vue app built by Vite, in one package, with no server of its own.
- **tauri**: a Vue app in a Tauri webview, with a Rust side.

You are welcome to use it, but expect the defaults to be mine. Every setting that varies between
projects is an option, and everything else is fixed.

> **Status:** pre-1.0. Releases go out under the `beta` dist-tag, and any minor version may break.

## Contents

- [Install](#install)
- [Config files](#config-files)
- [Git hooks](#git-hooks)
- [ESLint](#eslint)
- [Stylelint, commitlint, lint-staged](#stylelint-commitlint-lint-staged)
- [CI gates](#ci-gates)
- [Response schemas](#response-schemas)
- [The API contract](#the-api-contract)
- [The job contract](#the-job-contract)
- [Response-leak tripwire](#response-leak-tripwire)
- [Server-error tripwire](#server-error-tripwire)
- [The toolchain](#the-toolchain)
- [Working on this package](#working-on-this-package)

## Install

Requires Node 24 or later and an ESM project (`"type": "module"`).

```bash
npm i -D @larrydarko/lint-config@beta
```

Install only this package. ESLint, Prettier, Stylelint, commitlint, lint-staged, husky, knip,
jscpd and every plugin come with it. See [The toolchain](#the-toolchain) for why you should not
list them yourself.

## Config files

Each tool gets one small file that contains only what differs in this project:

```js
// prettier.config.js
export { default } from '@larrydarko/lint-config/prettier';

// commitlint.config.js
import { commitlint } from '@larrydarko/lint-config/commitlint';
export default commitlint();

// .stylelintrc.mjs
import { stylelint } from '@larrydarko/lint-config/stylelint';
export default stylelint({ spacingUnit: 'rem', mobileFirst: true });

// lint-staged.config.js
import { lintStaged } from '@larrydarko/lint-config/lint-staged';
export default lintStaged({ stylelint: true });

// knip.config.js
import { knip } from '@larrydarko/lint-config/knip';
export default knip({ entry: ['src/main.ts'], project: ['src/**/*.{ts,vue}'] });
```

Prettier takes no options. To change one value, spread `prettier` from the package root and
override that key, so the change is visible in the project's own config.

Use `knip()` rather than a plain `knip.json`. knip turns on its ESLint, Prettier and lint-staged
support only for packages the project lists itself, and a project using this package lists none
of them. Without the helper, knip reports every config file above as unused. `knip()` turns that
support back on and tells knip which CLIs are installed. Options you pass win.

A library's entry points are the files behind its `exports`. `packageEntries()` reads them back
from `package.json` (`./dist/gates/audit.js` is `src/gates/audit.ts`), so the list can't drift
from the manifest. The `!` keeps each one an entry under `--production`:

```js
// knip.config.js
import { knip, packageEntries } from '@larrydarko/lint-config/knip';
export default knip({ entry: packageEntries().map((file) => `${file}!`), project: ['src/**/*.ts!'] });
```

## Git hooks

```json
"scripts": { "prepare": "husky" }
```

```sh
# .husky/pre-commit
npx --no -- lint-staged

# .husky/commit-msg
npx --no -- commitlint --edit "$1"
```

`--no` makes a broken install fail. Without it, npx would download the latest version from the
registry and run that instead of the pinned one.

## ESLint

```js
// eslint.config.js
import { larry } from '@larrydarko/lint-config/eslint';
import { electronStandards } from '@larrydarko/lint-config/eslint/electron';

export default larry({
    preset: 'electron', // or 'api', 'fullstack', 'library', 'spa' or 'tauri'
    rootDir: import.meta.dirname,
    standards: electronStandards(),
    overrides: [/* this project's own blocks */],
});
```

`larry()` sets up the parts every project shares:

- the JavaScript, TypeScript and Vue presets
- which globals apply where
- the strict type-aware rules
- naming, return types and test relaxations
- Prettier compatibility, applied last

`preset` chooses a family's folder layout, and `paths` overrides any part of it. The family
modules (`/eslint/api`, `/eslint/electron`, `/eslint/fullstack`, `/eslint/library`, `/eslint/spa` and `/eslint/tauri`) export the standards blocks.
They also export the selectors, banned-import lists and rule plugins those blocks are built from,
so the project's own per-folder blocks can reuse them in `overrides`.

Most standards are the same in every family. Security, TypeScript, env, Vue, HTML and a11y,
i18n, refactoring, testing and the function contracts are one implementation each, applied to
that family's folders. Only the rules about a family's architecture differ: process or
workspace boundaries, its logger, and the api, database and websocket rules. The four
standards functions with a frontend accept the same options: `security.vHtmlAllowed`,
`html.globalStylesheet`, `refactoring.markerFiles` and `i18n` (or `i18n: false`).
`fullstackStandards()`, `spaStandards()`, `apiStandards()` and `libraryStandards()` also accept `logging.consoleAllowed`.

**The SPA family is the full-stack frontend on its own.** It applies the shared standards to
`src/` and nothing for a backend, since it has none. Its layout follows the full-stack frontend:
tests in a `__tests__/` folder beside the code they test (`src/composables/__tests__/useTheme.test.ts`),
locale files in `src/i18n/locales/`, Node scripts in `scripts/` with their own tsconfig, and
`public/` left unlinted because Vite copies it into the build untouched.

```js
// eslint.config.js
import { larry } from '@larrydarko/lint-config/eslint';
import { spaStandards } from '@larrydarko/lint-config/eslint/spa';

export default larry({
    preset: 'spa',
    rootDir: import.meta.dirname,
    standards: spaStandards({ i18n: { ignoreText: ['Acme'] } }),
});
```

**The API family is the full-stack api on its own.** It applies the full-stack api, database,
logging and websocket rules to `src/`, and nothing for a frontend or a shared package, since it
has neither. Its layout is the full-stack `api` workspace at the root of its own repository:
routes in `src/routes/`, the socket gateway in `src/gateway/`, `src/lib/config.ts`,
`src/lib/db.ts` and `src/middleware/error-handler.ts`, tests in a `__tests__/` folder beside the
code, and forward-only migrations in `db/migrations/`. Everything runs in Node, so there are no
browser globals and `vue` defaults to `false`.

`no-restricted-syntax` and `no-restricted-imports` are last-match-wins, so `apiStandards()` names
each area's whole list itself: a route gets the AppError and wire rules, the routes-only rules, the
logger, Mongo and TypeScript selectors together. The family needs no `overrides` to be complete. A
project that adds a selector to one area names that area's whole list again, from the selectors the
module exports. Messages point at this layout's files: the index manifest is `src/db/indexes.ts`
and the document types are in `src/db/collections.ts`.

MongoDB, Redis and a socket gateway are assumed. Each is a switch that defaults to on:

| Option  | Off means                                                                           |
| ------- | ----------------------------------------------------------------------------------- |
| `mongo` | no ODM ban, collection typing, client singleton or migration rules                  |
| `redis` | in-process caches and fixed-window limiters are allowed; `compression` stays banned |
| `ws`    | no `src/gateway/` rules                                                             |

```js
// eslint.config.js
import { larry } from '@larrydarko/lint-config/eslint';
import { apiStandards } from '@larrydarko/lint-config/eslint/api';

export default larry({
    preset: 'api',
    rootDir: import.meta.dirname,
    standards: apiStandards({ ws: false }),
});
```

The backend gates take their paths as options rather than assuming the workspace folders. Two of
them also check a frontend in the same repository: pass `frontend: false` to
`error-handling/fullstack` and `ws-standards`, and each skips its frontend half (the interceptor
that translates codes, the one socket client), which lives in the client's repository.

**The Tauri family is an SPA in a webview, plus one boundary.** ESLint sees only the webview. It
never walks `src-tauri/`, where the Rust side is linted by Clippy. So `tauriStandards()` applies the
shared standards to `src/`, plus two bridge rules. Only `src/bridge/` may import `@tauri-apps/api` or
a `@tauri-apps/plugin-*`, or touch the `__TAURI__` globals (`larry/no-tauri-outside-bridge`). In the
bridge, where Rust's rejections arrive, `larry/no-caught-message-leak` keeps their English out of what
it returns. The app is one package, so tests mirror `src/` in `tests/`, as in the Electron family.
`webviewBannedImports` (Node built-ins, Electron), `loggerCallSelectors` and `errorHandlingSelectors`
(no log-and-rethrow) are exported for the project's own blocks. The standard behind the family is `prompts/7_security/tauri.instructions.md` in
the workflow repo. Three gates cover what ESLint cannot see: the config and the capabilities
(`tauri-security`), the command chain from Rust to the bridge (`tauri-commands`), and the Rust side's
error handling (`error-handling/tauri`).

```js
// eslint.config.js
import { larry } from '@larrydarko/lint-config/eslint';
import { aliasOnlyImportPatterns, tauriStandards, webviewBannedImports } from '@larrydarko/lint-config/eslint/tauri';

export default larry({
    preset: 'tauri',
    rootDir: import.meta.dirname,
    standards: tauriStandards({ i18n: false }),
    overrides: [
        {
            files: ['src/**/*.{ts,vue}'],
            rules: {
                'no-restricted-imports': [
                    'error',
                    { patterns: [...webviewBannedImports.patterns, ...aliasOnlyImportPatterns] },
                ],
            },
        },
    ],
});
```

**The library family is code that runs in someone else's process.** Its layout is TypeScript in
`src/`, compiled to `dist/` (which is ignored), and suites in `test/`, run by `node --test`.
Everything runs in Node, so there are no browser globals and `vue` defaults to `false`. A suite
may be plain JavaScript importing the `.ts` sources, which Node strips itself; it gets the untyped
rules, and a TypeScript suite gets the typed ones as well.

`libraryStandards()` applies the shared security, TypeScript, env and refactoring standards to
`src/`, and adds two rules for a library. It does not print (`no-console`), because the terminal
and the logs belong to the caller. It does not exit (`process.exit()`), because that ends the
process it was imported into, and can cut off output still buffered on a pipe. A library reads
`process.env` only where it says so, since a setting it reads behind the caller's back is one the
caller can't see or pass.

| Option                    | What it is for                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `logging.consoleAllowed`  | files whose job is printing: a CLI the package ships, a report a script asked for   |
| `env.processEnvAllowed`   | source files that read `process.env` on purpose, such as a CLI honouring `NO_COLOR` |
| `defaultExportAllowed`    | shareable configs a tool loads by their default export                              |
| `refactoring.markerFiles` | the files that quote the deferral markers, as in the other families                 |

The vitest rules recognise only calls imported from `vitest`, so none of them reach a `node:test`
suite. The library family has its own: no `.only`, `.skip` or `.todo` on `test`, `it`, `describe`
or `suite`, neither as a property nor as an option (`{ skip: true }`), no commented-out cases,
and `node:assert/strict` rather than the legacy `node:assert`, whose `equal` compares with `==`.
For the same reason the `testing` gate, which reads a Vitest config, is not one of the family's
gates. `publish` is: it packs the tarball and installs it the way a registry would (see
[CI gates](#ci-gates)).

```js
// eslint.config.js
import { larry } from '@larrydarko/lint-config/eslint';
import { libraryStandards } from '@larrydarko/lint-config/eslint/library';

export default larry({
    preset: 'library',
    rootDir: import.meta.dirname,
    standards: libraryStandards({ logging: { consoleAllowed: ['src/cli.ts'] } }),
});
```

**No `any`, no unchecked casts, tests included.** `no-explicit-any`, the `no-unsafe-*` family and
`no-unsafe-type-assertion` are errors in every typed file. A cast that narrows (`as never`, `as unknown as T`,
`event.target as HTMLInputElement`) labels a value with a type nothing checked; in a test, that is how a fake
with the wrong shape compiles. Narrow with a check (`instanceof`, a type guard, a Zod parse) or type the fake
in full. The typed rules read a Vue file's `<script>` only, so `vue/no-restricted-syntax` refuses `as` in
its `<template>` too.

**One notification channel.** `larry/no-native-dialog` keeps the browser's dialogs out; `noToastLibraryPatterns`
keeps a notification library out, so every message goes through the one component the app owns. Like the
other banned-import lists, it is composed into the project's own `no-restricted-imports` block for the frontend,
because that rule is last-match-wins:

```js
'no-restricted-imports': ['error', { patterns: [...noStoreLibraryPatterns, ...noToastLibraryPatterns, ...aliasOnlyImportPatterns] }],
```

**Every disable comment names its rule and says why**: `// eslint-disable-next-line rule -- reason`.
`@eslint-community/eslint-comments` enforces it (`require-description`, `no-unlimited-disable`,
`disable-enable-pair`), everywhere, typed or not. A block disable needs its enable, unless it is a
whole-file exception at the very top.

**A rule of the package's own**, under the `larry/` prefix, needs no wiring:

- `larry/no-caught-message-leak` — a caught error's `message` or `stack` may reach a logger, an error's message
  argument or AppError's `logContext`, and nothing else: not a return value, a call, or a property write. On in
  the full-stack api and services, the Electron main and preload processes, and the Tauri bridge. AppError takes its message
  third; pass `{ messageArgs: { MyError: 1 } }` for another class that does not take it first.
- `larry/no-inline-svg` — an `<svg>` that draws a fixed picture belongs in `components/icons/`; one drawn from
  data (a binding, a `v-for`, an interpolation, a `<slot>`) stays inline. On every component in every family.
- `larry/icon-component` — a file in `components/icons/` is one root `<svg>`, `aria-hidden="true"`, with no
  static `id`. `duplication` adds the cross-file half: no two icon files draw the same picture.
- `larry/no-native-dialog` — no `alert()`, `confirm()` or `prompt()`, bare or through `window`, `globalThis` or
  `self`. They freeze the window and ignore the app's theme, and Electron does not implement `prompt()`. The
  user is told through the app's notification function, and asked through its own dialog. A binding the module
  declares or imports under one of those names is not the browser's, and passes. On everything that runs in the
  Vue app, in every family.
- `larry/no-tauri-outside-bridge` — `@tauri-apps/*` is imported in `src/bridge/` and nowhere else, types
  included, and nothing else reads `window.__TAURI__` or `__TAURI_INTERNALS__`, or tests for them with `in`. A local
  module whose path merely contains `tauri` passes. On the Tauri webview outside its bridge.

**Full-stack workspaces are roles.** The full-stack rules are written against four roles, not
folder names: `frontend` (the Vue app), `api` (the HTTP service), `services` (Node processes
outside the request cycle: a queue consumer, a feed ingestor) and `shared` (packages the others
import). The defaults are `frontend`, `api`, `['worker']` and `['packages/shared']`. A project
with another workspace names it once, and every rule for that role reaches it:

```js
export default larry({
    preset: 'fullstack',
    rootDir: import.meta.dirname,
    workspaces: { services: ['worker', 'ingestor'] },
    standards: fullstackStandards(),
});
```

`larry()` builds the preset's paths and the standards from the same `workspaces`, and holds them
to `package.json`. A workspace with a `src/` and no role fails the config, and so does a role
naming a folder with no `src/`. So adding a workspace without giving it a role is an error, not a
workspace that silently gets only the base rules. `fullstackLayout(workspaces)` returns each
role's globs for the project's own blocks in `overrides`.

**`rootDir` is required.** It becomes `tsconfigRootDir` and must be the project's directory. A
default taken from inside this package would point at the package, and every type-aware rule would
quietly find no tsconfig.

| Option             | Default      | What it is for                                                           |
| ------------------ | ------------ | ------------------------------------------------------------------------ |
| `preset`           | —            | `'api'`, `'electron'`, `'fullstack'`, `'library'`, `'spa'` or `'tauri'`  |
| `rootDir`          | —            | the project root; **required**                                           |
| `workspaces`       | the four     | full-stack only: which workspace plays which role                        |
| `paths`            | the preset's | override `source`, `tests`, `browser`, `node`, `ignores`, …              |
| `vue`              | `true`       | load the Vue plugin and parse `.vue` files; `false` for `api`, `library` |
| `importExtensions` | `false`      | enforce import specifiers; `{ nodeRun }` for folders Node runs directly  |
| `testProject`      | none         | a dedicated tsconfig for tests, such as `./tsconfig.test.json`           |
| `testRules`        | `{}`         | extra relaxations for tests                                              |
| `rules`            | `{}`         | extra rules on typed source                                              |
| `standards`        | `[]`         | the family's standards blocks                                            |
| `overrides`        | `[]`         | the project's own blocks, appended last before Prettier                  |

Order matters. In flat config the last matching block wins, and a block with no `files` matches
everything. That is why the catch-all block comes first and the test relaxations come after the
standards. The tests check this order against ESLint's own resolver.

## Stylelint, commitlint, lint-staged

**Stylelint.** The base rules apply everywhere. Each option below turns on or off one rule that
some projects follow and others do not.

| Option                    | Default     | Turn it on when                                                |
| ------------------------- | ----------- | -------------------------------------------------------------- |
| `spacingUnit`             | `'em'`      | set to `'rem'` for a UI that must not scale with its font size |
| `tokenProperties`         | colour only | more scales (type, radius, …) are tokenised                    |
| `ignoreZero`              | `false`     | `0` is a reset, not a design value waiting to be named         |
| `lowercaseCurrentColor`   | `false`     | `value-keyword-case` should rewrite `currentColor`             |
| `unknownCustomProperties` | `true`      | **off** where custom properties are generated by a SCSS loop   |
| `bem`                     | `false`     | class names are `block__element--modifier`                     |
| `noScssColorFunctions`    | `false`     | `$color-*` aliases resolve to `var(--color-*)` at runtime      |
| `noScssImport`            | `false`     | the project is fully on `@use`/`@forward`                      |
| `mobileFirst`             | `false`     | breakpoints only ever layer up with `min-width`                |
| `duplicateFallbacks`      | `false`     | `100vh` then `100dvh` is a fallback, not a mistake             |
| `variablesOverride`       | `false`     | `_variables.scss` declares the aliases                         |
| `referenceFiles`          | `[]`        | globs for token/theme files read for context but not linted    |
| `vue`                     | `true`      | leave on to lint `<style>` blocks in SFCs                      |
| `rules` / `overrides`     | `{}` / `[]` | anything else, merged last                                     |

**commitlint.** It uses Conventional Commits with these types: `feat`, `fix`, `perf`, `refactor`,
`test`, `security`, `docs`, `style`, `chore`, `bump` and `revert`.

| Option              | Default  | What it does                                                         |
| ------------------- | -------- | -------------------------------------------------------------------- |
| `subjectSingleWhy`  | `true`   | warns, without blocking, when a subject describes two pieces of work |
| `types`             | the list | replaces the allowed types                                           |
| `headerMaxLength`   | `200`    | longest allowed header                                               |
| `bodyMaxLineLength` | `400`    | longest allowed body line                                            |
| `rules`             | `{}`     | extra commitlint rules, merged last                                  |

**lint-staged.** It runs ESLint and Prettier on staged `.ts` and `.vue` files, and Prettier on
`.scss`, `.json` and `.md` files. Pass `stylelint: true` to also run Stylelint on `.scss` and `.vue`
files, and `tasks` to add more glob → command entries.

## CI gates

The gates check what a linter cannot see: a whole file, several files together, or files ESLint
never opens, such as manifests, workflows, Dockerfiles and locale files. Each gate is a function
that reads the repository and reports every failure with a reason and a fix. It sets a non-zero
exit code when anything fails, and a passing run lists what the gate does _not_ check.

A project runs each gate from a short script:

```ts
// scripts/check/check-error-handling.ts
import { checkElectronErrorHandling } from '@larrydarko/lint-config/gates/error-handling/electron';

checkElectronErrorHandling({
    cleanupRequired: [['fsService', 'holds a file watcher that must close on quit']],
});
```

```json
"scripts": { "error:check": "node scripts/check/check-error-handling.ts" }
```

Every option is typed and documented in the gate's declarations, so your editor lists them. Every
gate also exports an `inspect*` function that returns the failures instead of printing them, for
use in tests. Most gates run with no options. Options exist for things only the project knows:
its source roots, its services, and exceptions it has approved, each with a stated reason.

| Gate                       | Family          | Checks                                                                             |
| -------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `audit`                    | all             | `npm audit`, with a reviewed allowlist that expires                                |
| `code-style`               | all             | file names, file length, SFC block order, stale size baselines; Rust headers       |
| `contrast`                 | all with a UI   | every text token clears AA on every background, in every theme; no dimmed text     |
| `dead-code`                | all             | unused code and dependencies, undeclared imports, import cycles (knip)             |
| `declaration-order`        | all             | the order of imports, types, constants and functions; Rust items and `use`s        |
| `duplication`              | all             | copy-paste ceilings and a clone-size cap (jscpd); no icon drawn twice              |
| `html-standards`           | all with a UI   | `index.html`: shell, CSP, entry module, remote resources, reduced motion           |
| `i18n`                     | all with a UI   | two-letter locale files; plurals, placeholders and arrays agree; options           |
| `package-json`             | all             | manifest fields, version ranges, and the toolchain rule below                      |
| `pipeline`                 | all             | every gate runs in CI; timeouts, permissions, SHA-pinned actions, …                |
| `refactoring`              | all             | no deferral markers left in code                                                   |
| `scss-standards`           | all with a UI   | the entry, Vite injection, theme parity, self-hosted fonts                         |
| `testing`                  | all but library | suite layout, `.only`/`.skip`, coverage ratchet, E2E server-error wiring           |
| `tsconfigs`                | all             | compiler flags stay at the standard                                                |
| `electron-security`        | electron        | `webPreferences`, navigation, permissions, `v-html`, TLS overrides                 |
| `error-handling/electron`  | electron        | IPC handlers contain failures, process backstops, cleanup on quit                  |
| `ipc-standards`            | electron        | channels, docs and preload agree; the renderer uses every bridge member            |
| `tauri-security`           | tauri           | CSP, security flags, the capability list, one capability per window, grants        |
| `tauri-commands`           | tauri           | commands, `build.rs`, grants, `invoke`s, events and error codes agree              |
| `error-handling/tauri`     | tauri           | failing commands log once, a panic hook, Rust and webview swallows have reasons    |
| `publish`                  | library         | the packed tarball installs: no TS source, every entry point loads and type-checks |
| `api-standards`            | api, fullstack  | route map, middleware order, rate limits, response schemas, the contract           |
| `db-drift`                 | api, fullstack  | collection registry, indexes, migrations, drain order, ops scripts                 |
| `docker`                   | api, fullstack  | image rules that need no Docker daemon, including no secrets in layers             |
| `env-drift`                | api, fullstack  | the env schema and `.env.example` files agree; secrets have no default             |
| `error-handling/fullstack` | api, fullstack  | the status policy, error codes and their translations                              |
| `metrics`                  | api, fullstack  | scrape config, probes, metric cardinality                                          |
| `security-drift`           | api, fullstack  | security controls whose failure is silent                                          |
| `ws-standards`             | api, fullstack  | one socket server, one client, and the handshake order                             |

`contrast` takes the same `themes` object as `scss-standards`, so both read the palettes from one
description. It measures `text` tokens against `backgrounds` tokens in every palette, and with
`scan` it also fails a rule that colours text and then lowers its `opacity`. An ornament that is
hidden from assistive tech opts out with `/* contrast-exempt: <reason> */` above its rule.

`publish` packs the package with `npm pack`, which runs `prepack` and so the build. It unpacks the
tarball under a real `node_modules`, links the dependencies in from the project's own install, then
imports every entry point in Node and type-checks them all with `skipLibCheck` off. The test suite
runs the sources, and a `file:` install is a symlink, so neither of them sees a copy that only breaks
once published: a `.ts` file Node refuses to strip under `node_modules`, a file `exports` names that
`files` left out, a `bin` with no `#!` line, or a declaration that can't resolve. With `skipLibCheck`
on, as a project runs, that last one quietly becomes `any`.

**Rust.** `code-style` and `declaration-order` read `.rs` files too, never under `target/`. Name the
crate's sources in `scan` or `sourceRoots` (`src-tauri/src`, and `src-tauri/build.rs`: a file is read
as itself). `declaration-order` checks the item order of `prompts/0_standards/rust.instructions.md`
(a type followed by its `impl`s, the tests last) and the `use` groups: std, external crates, this
crate through `crate::`. `--fix` leaves Rust to rustfmt. `code-style` requires `//!` on `lib.rs`, and
elsewhere where a `headers` rule says `rustdoc`; it also checks that a doc comment's first paragraph
is one sentence, and that there are no section labels, `get_` getters or acronyms in capitals.

`dead-code` takes the same list as `publicApi` in a library: `checkDeadCode({ publicApi: packageEntries() })`.
A published package's exports are used outside the repository, so with it the gate reports neither
an entry export that only the tests import nor a public type that only its own file names.

`dead-code` and `duplication` accept `--all`, which prints the tool's own full report instead of
pass or fail. List `vue` in `.jscpd.json` and jscpd reports template markup as `html` on its own.
Don't list `html` there, because jscpd rejects it.

`gates/lib/repo-root`, `gates/lib/strip-comments`, `gates/lib/source`, `gates/lib/files`,
`gates/lib/report`, `gates/lib/swallowed-errors` and `gates/lib/rust` are the helpers the gates are built from, and
they are exported for your own gates.

## Response schemas

An API response should carry only the fields the frontend uses. The reliable way to get that is
an allowlist that runs on every response: a Zod schema per response, parsed just before the data
is sent. A Zod object drops every key it does not declare, so a whole database document passed by
mistake, or a field added to the collection next month, never reaches the wire. The frontend
infers its types from the same schemas, so the two sides cannot drift.

The project owns the helper, because it runs in production and this package is a dev dependency:

```ts
// api/src/lib/send.ts
export function send<TSchema extends z.ZodType>(res: Response, schema: TSchema, data: z.input<TSchema>): void {
    const parsed = schema.safeParse(data);
    // A server bug, not a bad request: never let it reach a ZodError → 422 handler.
    if (!parsed.success) throw new AppError(500, 'INTERNAL', 'Response did not match its schema');
    // A field the schema does not declare is a bug too. Off the wire either way; the question is
    // who finds out: outside production the answer fails, in production it is logged by name.
    const dropped = droppedKeys(data, parsed.data);
    if (dropped.length > 0) {
        if (config.isDev) throw new AppError(500, 'INTERNAL', 'Response carried undeclared fields');
        res.req.log.error({ dropped }, 'Response carried undeclared fields');
    }
    res.json(parsed.data);
}

// a route
send(res, videoMetaSchema, video);
send(res.status(202), uploadAcceptedSchema, result);
```

`api-standards` enforces it once the project states `responses`:

```ts
checkApiStandards({
    // ...the other paths
    responses: {
        helper: 'api/src/lib/send.ts',
        schemasDir: 'packages/shared/src/responses',
        devFlag: 'config.isDev',
        pending: {
            'api/src/routes/admin.ts': 'moderation shapes not migrated yet',
        },
    },
});
```

- **No raw responses in route files.** `res.json(…)`, `res.send(…)` and `res.end(…)` with a payload
  fail, each at its line. `{ error: CODE }` bodies and an empty `res.status(204).end()` are fine,
  since they carry no data.
- **The helper parses.** It must exist and call `.parse(` or `.safeParse(`.
- **No loose response schemas.** Every file under `schemasDir` is checked for `z.looseObject`,
  `.passthrough()`, `.loose()`, `.catchall()`, `z.any()`, `z.unknown()`, `z.json()`,
  `z.custom()` and a record of strings. Each of these lets through a field nobody declared.
- **A dropped field is loud** (`devFlag`). The helper must call `droppedKeys(`, throw when the
  stated expression holds (outside production), and log at error level otherwise. Without it a
  schema that is quietly wrong stays wrong: nothing leaks, but nobody learns the mapper hands over a
  field nobody listed.
- **`pending` only shrinks.** It lists the route files not migrated yet, each with a reason. A
  listed file with no raw response left fails, and so does an entry naming no route file. When the
  list is empty, delete the key.

A project adopting this lists every route file with a raw response in `pending` on day one, so the
gate passes. It then migrates one area at a time. With `exactOptionalPropertyTypes`, declare
optional fields with `.exactOptional()`: `.optional()` infers `?: T | undefined`.

The gate reads text, so it does not see a response parameter named something other than `res`,
or a schema helper imported under another name.

## The API contract

Response schemas stop the API sending a field it should not. They do not stop the frontend and
the API disagreeing about what a route takes or answers: the frontend's mocks, its request types
and its socket listeners are each a second, hand-written copy of the API, and any of them can
drift while every test stays green. The contract is one table in the shared package, one entry
per route, naming the schemas the router validates and answers with:

```ts
// packages/shared/src/contract.ts
export const API_ROUTES = {
    'GET /api/videos/:id': { response: videoMetaSchema },
    'PUT /api/videos/:id': { body: updateVideoBody, response: videoMetaSchema },
    'GET /api/videos': { query: ownVideosQuery, response: ownMediaPageSchema },
    'DELETE /api/videos/:id': { response: null }, // no body
    'GET /api/videos/:id/download': { response: 'raw' }, // a file
} as const satisfies Record<string, Endpoint>;
```

Everything else reads it: the frontend's one caller types the body, query and answer from the key
(`call('PUT /api/videos/:id', { params: { id }, body })`); the frontend's test server checks every
mocked exchange against it, and the API's route tests check every answer a router gives. Both
sides are strict: a key a schema does not declare is a problem, and the API's validator refuses it
with a 422 rather than dropping it.

`api-standards` enforces the parts a test cannot, once the project states `contract`:

```ts
checkApiStandards({
    // ...the other paths
    requestId: 'requestId',
    contract: {
        file: 'packages/shared/src/contract.ts',
        sharedPackage: '@acme/shared',
        caller: { instance: 'api', dir: 'frontend/src' },
        validator: 'api/src/middleware/validate.ts',
        testChecks: ['frontend/src/__tests__/server.ts', 'api/src/__tests__/test-app.ts'],
        handlers: { validate: 'validated', send: 'send', objects: ['api/src/lib/schemas.ts'] },
    },
});
```

- **The keys are the served routes, both ways.** Each router's `mounted at` header plus its
  declared paths must match the contract's keys exactly: a route missing from the table fails, and
  so does a key no router serves.
- **Request schemas come from the shared package.** A `params:`, `body:` or `query:` handed to the
  validator must be an identifier imported from `sharedPackage`; a schema written in the router is a
  second definition the frontend and the contract never see.
- **The frontend calls through its typed caller.** Outside `apiClient` and tests, a direct
  `api.get(…)` (or any method) on the axios instance fails at its line.
- **The validator refuses unknown keys** (`validator`). It must import `droppedKeys` from
  `sharedPackage` and call it: a Zod object alone strips the key and the request answers 2xx, which
  tells a client sending a renamed or stale field that its change was saved.
- **Each route uses exactly what its entry names** (`handlers`). Read from each route declaration:
  the `params`, `body` and `query` it hands `handlers.validate` (an object literal, a spread, or a
  named object declared in the router or in one of `objects`) must be the ones the entry names. A
  route that checks its path itself, to answer a bad one as a probe rather than a 422, passes when
  it calls the entry's `params` schema's `.safeParse(` or `.parse(`. Every schema it answers
  through `handlers.send` with (second argument, in the route or in the handler it names) must
  appear in the entry's `response`, a `null` response must never call `send`, and the multer
  fields (`.single`, `.array`, `.fields`) must be the entry's `files`, by name and by count. Without it a router can validate or answer with a schema the contract does not name, and
  only a test that happens to send the difference notices.
- **The test setups check against the contract** (`testChecks`). Each listed file, typically the
  frontend's mock server and the API's test app, must import and call `requestProblems`,
  `responseProblems` and `errorProblems` from `sharedPackage`. Unchecked, a mock is a second API
  that drifts from the real one while every test stays green; a mock refusing with a code the API
  does not have tests a path no user can reach.
- **The request id comes before the body parser** (`requestId`). A body that will not parse
  otherwise reaches the error handler with no logger, crashes it, and becomes a bare 500.

The checks only see the exchanges a suite makes, so a route no test calls is never checked and
its schemas can be wrong while every test stays green. `contract.coverage` closes that: each test
setup records the routes it held to the contract, and a full run with coverage fails on the routes
nobody did, with the list.

```ts
contract: {
    // ...as above
    coverage: {
        module: '@acme/shared/contract-coverage',
        suites: [
            { config: 'api/vitest.config.ts', setup: 'api/src/__tests__/contract-coverage.ts' },
            { config: 'frontend/vitest.config.ts', setup: 'frontend/src/__tests__/contract-coverage.ts' },
        ],
    },
},
```

- **Every test setup records.** Each `testChecks` file must import and call `recordCheckedRoute`
  from `module`, with `inject('<key>')` as its log, and sit inside a listed suite.
- **Every suite reads it back and fails.** Each `setup` must call `openCoverageLog` and
  `uncheckedRoutes`, `provide` the key its suite's recorders inject, and `throw` on what is left;
  its `config` must register it as a `globalSetup`.

A route the frontend never calls (a webhook, a file URL the browser loads, an admin route called
from a shell) goes in the frontend setup's exemption map with the reason, never quietly.

The mock server can only check what reaches it. `testing` takes
`apiClient: { module: '@/api/client', exports: ['call', 'api'] }`, the exports every request
goes through, and fails a suite that replaces any of them: a `vi.mock`/`vi.doMock` of the module
with no factory or with a factory returning that name, or a `vi.spyOn` on it. A stand-in answers
whatever the test hands it, so the code under test is never held to the API. Replacing the
module's other exports, around the real request path, is fine.

Both suites test against doubles. `contract.fuzz` holds the third check, a fuzz run against the
real API: [Schemathesis](https://schemathesis.readthedocs.io) reads an OpenAPI document built from
the contract, sends thousands of generated requests, and fails on a 5xx or an answer the contract
refuses. The run is only as good as the document it reads and the exceptions its config allows, so
the gate checks both:

```ts
contract: {
    // ...as above
    fuzz: {
        document: { file: 'packages/shared/src/openapi.ts', name: 'openApiDocument' },
        runner: 'e2e/fuzz/run.ts',
        config: 'e2e/fuzz/schemathesis.toml',
        requirements: 'e2e/fuzz/requirements.txt',
        outputs: ['e2e/fuzz/.venv', 'e2e/fuzz/report'],
        isolate: ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_URL'],
    },
},
```

- **The document is built from the contract.** `document.file` exports `document.name`, reads the
  contract table, and writes no route string of its own. Each operation's id is its contract key
  (`'GET /api/videos/:id'`), which is how the config names one.
- **Every run builds it afresh and hands the fuzzer its config.** The runner calls `document.name`
  and passes `--config-file` with `config`. Schemathesis otherwise looks for `schemathesis.toml`
  only where it starts and above, and started anywhere else it runs with no exceptions at all,
  fuzzing the routes the config kept out.
- **Every exception says why, and none forgives a crash.** Each `[[operations]]` group and each
  setting turned off carries a comment directly above it, or at the end of its line.
  `not_a_server_error` and `response_schema_conformance` stay on everywhere, and no
  `expected-statuses` lists a 5xx.
- **Every route the config names exists.** An operation id, a path or a path pattern that matches
  nothing in the contract is a route that was renamed under its exception. A pattern only Python's
  `re` can read is left to Schemathesis.
- **Everything the run installs is pinned with `==`.** Every line of `requirements` (the fuzzer,
  and a stand-in such as moto), each unpinned one reported at its line. A new release changes how
  requests are generated or answered, so an unpinned run changes colour for a reason in no diff,
  and a printed seed no longer replays it.
- **The API it starts gets the run's own services** (`isolate`). The runner must set each listed
  env key itself (`KEY: …` in an env object, or `process.env['KEY'] = …`). The API fills a key it
  is not given from its dev env file, so a run that leaves one out stores its uploads in the dev
  buckets and queues its jobs in the dev Redis, where they outlive it. The run's own services
  (moto, a `redis-server` that saves nothing) start and stop with it.
- **What a run writes is git-ignored.** Each of `outputs`, and the `.schemathesis/` crash cache at
  the root and beside `config`: its manifest records the absolute path of the document it read.

Socket pushes have the same problem and the same fix: `ws-standards` takes
`events: { file, table }`, the shared table of outbound events and their payload schemas, and fails
when the gateway emits an event the table does not list, the table lists one nothing emits, or the
gateway never reads the table.

## The job contract

A job crosses a process boundary and waits in Redis, so a type shared between the API and the
worker proves nothing at run time: a job queued by an older API can reach a newer worker. The
registry is one table in the shared package, each job's queue name beside the schema of the data it
carries, and both ends parse against it:

```ts
// packages/shared/src/jobs.ts
export const JOBS = {
    transcode: { queue: 'transcode', data: z.object({ videoId, rawObjectKey }) },
    accountCleanup: { queue: 'account-cleanup', data: z.object({ userId }) },
} as const satisfies Record<string, { queue: string; data: z.ZodObject }>;
```

The producer is strict and the worker tolerant: the API refuses a field the schema would drop,
and the worker ignores one it does not know, so an API that adds a field can deploy before the
worker that reads it. `api-standards` checks it once the project states `jobs`:

```ts
jobs: {
    file: 'packages/shared/src/jobs.ts',
    table: 'JOBS',
    producer: 'api/src/lib/queue.ts',
    processor: { file: 'worker/src/lib/jobs.ts', name: 'jobProcessor' },
    workers: ['worker/src/index.ts'],
},
```

- **The registry pairs every queue with a schema, and none is strict.** `.strict()` or
  `z.strictObject` would fail every job a newer API queued during a rolling deploy.
- **The producer parses and refuses.** It reads `table`, calls `.safeParse`/`.parse`, and calls
  `droppedKeys`. No other file in its workspace builds a `new Queue(`.
- **The processor parses and gives up once.** `processor.name` must parse the job's data and throw
  an `UnrecoverableError` when it does not fit: a retry would read the same bytes.
- **Every worker uses both.** In each `workers` file, a `new Worker(` or `new Queue(` names its
  queue from `table`, never a string, and a `Worker` runs its jobs through `processor.name(`.

## Response-leak tripwire

`@larrydarko/lint-config/response-leaks` checks every JSON response an E2E suite receives from the
API for fields that must never leave the server. The project lists those fields per collection,
and every response is checked two ways:

- **by key**: a property with one of those names, at any depth.
- **by value**: a string equal to what one of those fields holds in the test database at that
  moment, under any name. `{ ref: user.stripeCustomerId }` passes the key check and fails this one.

It is a test fixture, not a gate, because it needs the real API and database running: route tests
that mock the service layer only ever see the data the test made up. Plug it into the Playwright
fixtures every test imports:

```ts
// e2e/support/fixtures.ts
import { createLeakRecorder, type LeakRecorder } from '@larrydarko/lint-config/response-leaks';

const SENSITIVE_FIELDS = {
    Users: ['password', 'totpSecret', 'emailEncrypted', 'stripeCustomerId'],
    Media: ['rawObjectKey'],
};

export const test = base.extend<{ noResponseLeaks: void }, { leaks: LeakRecorder }>({
    leaks: [
        async ({}, use) => {
            const client = await new MongoClient(MONGO_URI).connect();
            await use(createLeakRecorder({ sensitive: SENSITIVE_FIELDS, db: client.db(MONGO_DB) }));
            await client.close();
        },
        { scope: 'worker' },
    ],
    noResponseLeaks: [
        async ({ leaks }, use) => {
            await use();
            expect(await leaks.drain(), 'API responses carried server-only fields').toEqual([]);
        },
        { auto: true },
    ],
    context: async ({ context, leaks }, use) => {
        leaks.watch(context);
        await use(context);
    },
});
```

A failure names the route, the JSON path and how it matched:
`GET /api/profile/alice → $.user.emailIndex (key of Users.emailIndex)`. A dotted field name
(`billing.customerId`) reaches into a subdocument. Values are read when `drain()` runs, so a user
the test registered is covered. Strings shorter than `minValueLength` (default 8) are not
value-matched, since they collide with ordinary text. Leave out `db` and only names are checked.

Leave out any field that is sent on purpose to one audience, such as recovery codes shown once,
or a ban reason shown to staff. Both checks are denylists, so [response schemas](#response-schemas)
are still the real defence. The tripwire catches what a schema cannot: a secret under a field
name the schema does list, on the routes the suite visits.
The module has no dependencies. It accepts any object shaped like a MongoDB `Db` and a Playwright
`BrowserContext`.

## Server-error tripwire

`@larrydarko/lint-config/server-errors` fails an E2E test that received a 5xx from the API, and
says why. A test that checks what it came to check walks straight past a 500 on the side: the page
still renders, a spinner just never stops. The recorder watches every API response; on a 5xx it
reads the API's JSON log (the API writes one when `LOG_FILE` is set) for the lines carrying the
response's `x-request-id`, so the failure arrives with its cause:

```
POST /api/auth/login → 500 (request 4892a4bd-…)
    error: Unhandled error {"requestId":"4892a4bd-…","err":"TypeError: x is undefined (at load (/app/src/a.ts:3:1))"}
```

```ts
// e2e/support/fixtures.ts
import { createServerErrorRecorder, type ServerErrorRecorder } from '@larrydarko/lint-config/server-errors';

serverErrors: [async ({}, use) => use(createServerErrorRecorder({ logFile: API_LOG })), { scope: 'worker' }],
noServerErrors: [
    async ({ serverErrors }, use) => {
        await use();
        expect(await serverErrors.drain(), 'API requests failed with a server error').toEqual([]);
    },
    { auto: true },
],
context: async ({ context, serverErrors }, use) => {
    serverErrors.watch(context);
    await use(context);
},
```

Point the API the suite boots at the log (`webServer.env: { LOG_FILE: API_LOG }`), empty it in the
global setup, and read it once more in the global teardown with `logErrors(API_LOG)`: every
error-level line of the run, including the ones no response showed, such as a socket push its
schema refused, a job that died in the background, or an error logged inside a request that still
answered 2xx. The logger may write a line after the response leaves, so `drain()` waits up to
`logWaitMs` (default 2000) for it. Without `logFile`, an entry still names the route, the status
and the request id.

`testing` checks the wiring once the project states `serverErrors` (next to `e2e`):

```ts
checkTesting({
    // ...the other options
    e2e: { dir: 'e2e', config: 'e2e/playwright.config.ts' },
    serverErrors: { fixtures: 'e2e/support/fixtures.ts', teardown: 'e2e/support/global-teardown.ts' },
});
```

- **The fixtures record and drain.** `fixtures` must call `createServerErrorRecorder(` with a
  `logFile`, `.watch(` a context and `.drain(` the recorder.
- **The teardown reads the log.** `teardown` must call `logErrors(`.
- **The config wires both.** The Playwright config must name the teardown as its
  `globalTeardown` and pass `LOG_FILE` to the API it boots.
- **Every spec takes `test` from the fixtures.** A spec importing `test` from `@playwright/test`
  runs none of the project's `auto` fixtures, so no tripwire watches it. It fails at its line;
  importing only `expect` from Playwright is fine.

## The toolchain

Every tool and plugin this package uses is one of its dependencies, pinned to an exact version:
ESLint, Prettier, Stylelint, commitlint, lint-staged, husky, knip, jscpd and their plugins. This
means:

- **Don't install any of them yourself.** In a project that depends on this package, the
  `package-json` gate fails if the project lists one of them. It also fails if a CLI is missing
  from the top of `node_modules` or is a different version from the one pinned here.
- **Pins are exact on purpose.** In a project, ranges are right, because the lockfile pins the
  tree. A published package's lockfile never reaches the projects that install it, so an exact
  pin is the only way to give every project the same version. The `package-json` gate fails an exact pin
  unless the field is listed in `exactFields` with the reason. This package lists `dependencies`,
  so there a `^` fails instead.
- **A tool upgrade is a release of this package.** Newer tools find new problems. When you update,
  run the linters and gates and read what changed. New findings are usually real, not a
  regression.

The plugins are resolved from inside this package, so they can sit anywhere in `node_modules`.
The CLIs can't: scripts, git hooks and editors look for `eslint`, `prettier`, `stylelint` and the
rest in the project's own `node_modules`. A registry install puts them there.

## Working on this package

```bash
npm run build          # src/*.ts → dist/, with declarations
npm run typecheck
npm test
npm run check:package  # packs the tarball, installs it, then imports and type-checks every export
npm run presets:record # re-records test/presets/ after a rule change you meant
npm run ci:check       # everything CI runs: the above, ESLint, Prettier and every library gate
```

This package is a library, and it checks itself the way the library family checks one:
`eslint.config.js` and `knip.config.js` import `larry()`, `libraryStandards()` and `knip()` from
`./src`, and each gate runs from a script in `scripts/checks/`, wired into `ci:check` and
`.github/workflows/ci.yml`. ESLint findings that predate this are recorded in
`eslint-suppressions.json`. A new finding fails, and so does a suppressed one once it's fixed,
until `npx eslint . --prune-suppressions` drops it, so the file only shrinks. `code-style`'s
`baseline` works the same way for the files over the line softcap.

`test/presets/` holds, for every preset, the rules ESLint resolves on one file per area, with the
family's standards at their defaults. `npm test` compares them, so a change to a shared block that
moves a rule in one family fails and names the rule and the files. When the change is meant,
re-record the snapshots, read their diff, and commit them with it.

The source is TypeScript and the package ships compiled `dist/`. Node will not strip types from
files under `node_modules`, so a `.ts` export would fail once installed. `check:package` runs with
`skipLibCheck` off, because with it on a declaration that fails to resolve silently becomes
`any`. `prepublishOnly` runs the typecheck, the tests and this check.

**Testing a local checkout in a project.** A `file:` dependency is a symlink by default, and
a symlinked package's dependencies never reach the project's `node_modules`, so the CLIs are
missing. Add this to the project's `.npmrc`:

```ini
install-links=true
```

npm then installs a packed copy, laid out like a registry install. Plain `npm i` does not refresh
that copy after you change this package, so reinstall it:

```bash
npm uninstall @larrydarko/lint-config && npm i -D file:../lint-config
```

This is for trying a change, not for committing. A `file:` dependency ties the project's lockfile
to your folder layout, so CI and fresh clones cannot install it. Switch back to the published
version, and remove `install-links` from `.npmrc`, before you commit:

```bash
npm i -D @larrydarko/lint-config@beta
```

## License

MIT
