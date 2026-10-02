# @larrydarko/lint-config

Formatting, linting, commit rules and CI quality gates for my projects, kept in one package so a
rule is changed once and every project picks it up on its next update.

It is opinionated and built for two kinds of project:

- **fullstack**: a Vue frontend and an Express API as npm workspaces, with a worker, a database
  and a websocket gateway.
- **electron**: a Vue desktop app split into main, preload and renderer.

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
- [Response-leak tripwire](#response-leak-tripwire)
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
    preset: 'electron', // or 'fullstack'
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
modules (`/eslint/electron` and `/eslint/fullstack`) export the standards blocks. They also export
the selectors, banned-import lists and rule plugins those blocks are built from, so the
project's own per-folder blocks can reuse them in `overrides`.

Most standards are the same in both families. Security, TypeScript, env, Vue, HTML and a11y,
i18n, refactoring, testing and the function contracts are one implementation each, applied to
that family's folders. Only the rules about a family's architecture differ: process or
workspace boundaries, its logger, and the full-stack api, database and websocket rules. Both
`electronStandards()` and `fullstackStandards()` accept the same options: `security.vHtmlAllowed`,
`html.globalStylesheet`, `refactoring.markerFiles` and `i18n` (or `i18n: false`).
`fullstackStandards()` also accepts `logging.consoleAllowed`.

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

| Option             | Default      | What it is for                                                          |
| ------------------ | ------------ | ----------------------------------------------------------------------- |
| `preset`           | —            | `'electron'` or `'fullstack'`                                           |
| `rootDir`          | —            | the project root; **required**                                          |
| `workspaces`       | the four     | full-stack only: which workspace plays which role                       |
| `paths`            | the preset's | override `source`, `tests`, `browser`, `node`, `ignores`, …             |
| `vue`              | `true`       | load the Vue plugin and parse `.vue` files                              |
| `importExtensions` | `false`      | enforce import specifiers; `{ nodeRun }` for folders Node runs directly |
| `testProject`      | none         | a dedicated tsconfig for tests, such as `./tsconfig.test.json`          |
| `testRules`        | `{}`         | extra relaxations for tests                                             |
| `rules`            | `{}`         | extra rules on typed source                                             |
| `standards`        | `[]`         | the family's standards blocks                                           |
| `overrides`        | `[]`         | the project's own blocks, appended last before Prettier                 |

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

Every option is typed and documented in the gate's declarations, so your editor lists them. Most
gates also export an `inspect*` function that returns the failures instead of printing them, for
use in tests. Most gates run with no options. Options exist for things only the project knows:
its source roots, its services, and exceptions it has approved, each with a stated reason.

| Gate                       | Family    | Checks                                                                   |
| -------------------------- | --------- | ------------------------------------------------------------------------ |
| `audit`                    | both      | `npm audit`, with a reviewed allowlist that expires                      |
| `code-style`               | both      | file names, file length, SFC block order, stale size baselines           |
| `dead-code`                | both      | unused code and dependencies, undeclared imports, import cycles (knip)   |
| `declaration-order`        | both      | the order of imports, types, constants and functions in a module         |
| `duplication`              | both      | copy-paste ceilings per format and a cap on clone size (jscpd)           |
| `html-standards`           | both      | `index.html`: shell, CSP, entry module, remote resources, reduced motion |
| `i18n`                     | both      | two-letter locale files; plurals, placeholders and arrays agree; options |
| `package-json`             | both      | manifest fields, version ranges, and the toolchain rule below            |
| `pipeline`                 | both      | every gate runs in CI; timeouts, permissions, SHA-pinned actions, …      |
| `refactoring`              | both      | no deferral markers left in code                                         |
| `scss-standards`           | both      | the entry, Vite injection, theme parity, self-hosted fonts               |
| `testing`                  | both      | suite layout, `.only`/`.skip`, duplicate titles, coverage ratchet        |
| `tsconfigs`                | both      | compiler flags stay at the standard                                      |
| `electron-security`        | electron  | `webPreferences`, navigation, permissions, `v-html`, TLS overrides       |
| `error-handling/electron`  | electron  | IPC handlers contain failures, process backstops, cleanup on quit        |
| `ipc-standards`            | electron  | the channel list, documentation and preload surface agree                |
| `api-standards`            | fullstack | route map, middleware order, rate limits                                 |
| `db-drift`                 | fullstack | collection registry, indexes, migrations, drain order, ops scripts       |
| `docker`                   | fullstack | image rules that need no Docker daemon, including no secrets in layers   |
| `env-drift`                | fullstack | the env schema and `.env.example` files agree; secrets have no default   |
| `error-handling/fullstack` | fullstack | the status policy, error codes and their translations                    |
| `metrics`                  | fullstack | scrape config, probes, metric cardinality                                |
| `security-drift`           | fullstack | security controls whose failure is silent                                |
| `ws-standards`             | fullstack | one socket server, one client, and the handshake order                   |

`dead-code` and `duplication` accept `--all`, which prints the tool's own full report instead of
pass or fail. List `vue` in `.jscpd.json` and jscpd reports template markup as `html` on its own.
Don't list `html` there, because jscpd rejects it.

`gates/lib/repo-root`, `gates/lib/strip-comments`, `gates/lib/source`, `gates/lib/files`,
`gates/lib/report` and `gates/lib/swallowed-errors` are the helpers the gates are built from, and
they are exported for your own gates.

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
or a ban reason shown to staff. Both checks are denylists, so a mapper per response is still the
real defence. The tripwire catches a route that skipped one, on the routes the suite visits.
The module has no dependencies. It accepts any object shaped like a MongoDB `Db` and a Playwright
`BrowserContext`.

## The toolchain

Every tool and plugin this package uses is one of its dependencies, pinned to an exact version:
ESLint, Prettier, Stylelint, commitlint, lint-staged, husky, knip, jscpd and their plugins. This
means:

- **Don't install any of them yourself.** In a project that depends on this package, the
  `package-json` gate fails if the project lists one of them. It also fails if a CLI is missing
  from the top of `node_modules` or is a different version from the one pinned here.
- **Pins are exact on purpose.** In a project, ranges are right, because the lockfile pins the
  tree. A published package's lockfile never reaches the projects that install it, so an exact
  pin is the only way to give every project the same version.
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
```

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
