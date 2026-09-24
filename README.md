# @larrydarko/lint-config

One home for the formatting, commit and style rules shared by Orchid, Mosaic, Fern, Quartz and
bamboo. Fix a rule here, and every project picks it up on its next update instead of needing
the same edit pasted five times.

Prettier, commitlint, Stylelint, lint-staged, ESLint (one preset per family: `fullstack` for
the Vue + Express monorepos, `electron` for the desktop apps) and all twenty-three `check-*` CI
gates. **Fern** (Electron) and **Orchid** (full-stack) are the worked examples, one per family.

## Using it in a project

```bash
npm i -D @larrydarko/lint-config
```

Then `.prettierrc` and the `lint-staged` block in `package.json` go away, replaced by four small
files that each name only what this project does differently:

```js
// prettier.config.js — no options, so it is a straight re-export
export { default } from '@larrydarko/lint-config/prettier';

// commitlint.config.js
import { commitlint } from '@larrydarko/lint-config/commitlint';
export default commitlint({ subjectSingleWhy: true });

// .stylelintrc.mjs
import { stylelint } from '@larrydarko/lint-config/stylelint';
export default stylelint({ spacingUnit: 'rem', mobileFirst: true });

// lint-staged.config.js
import { lintStaged } from '@larrydarko/lint-config/lint-staged';
export default lintStaged({ stylelint: true });
```

## ESLint

```js
// eslint.config.js
import { larry } from '@larrydarko/lint-config/eslint';
import { electronStandards, tsSourceSelectors /* … */ } from '@larrydarko/lint-config/eslint/electron';

export default larry({
    preset: 'electron', // or 'fullstack'
    rootDir: import.meta.dirname, // required — see below
    standards: electronStandards({ i18n: { ignoreText: ['Fern'] } }),
    overrides: [/* this project's own per-area blocks */],
});
```

`rootDir` is not optional. It becomes `tsconfigRootDir`, which has to point at **the project** —
`import.meta.dirname` read from inside this package would point at the package, and every
type-aware rule would then silently find no tsconfig.

`larry()` owns what every project agreed on: the JS/TS/Vue presets, which globals apply where, the
strict type rules, the naming convention, the return-type rule, the test relaxations, and Prettier
last. `preset` picks a family's folder layout (see `presets.js`); `paths` overrides any part of it.

**The per-area wiring stays in the project.** Which selectors apply to `api/src/routes` or to
`src/main` is genuinely about that project's folders, so it lives in its own config file and is
passed as `overrides`. What that wiring _composes_ — the selectors, the banned-import lists, the
function-contracts plugin — is imported from the family module, so the rules are shared even though
the wiring is not.

| Option             | Default      | What it is for                                                          |
| ------------------ | ------------ | ----------------------------------------------------------------------- |
| `preset`           | —            | `'electron'` or `'fullstack'`                                           |
| `rootDir`          | —            | the project root; **required**                                          |
| `paths`            | the preset's | override `source`, `tests`, `browser`, `node`, `ignores`, …             |
| `vue`              | `true`       | load the Vue plugin and parse `.vue` files                              |
| `importExtensions` | `false`      | enforce import specifiers; `{ nodeRun }` for folders Node runs directly |
| `testProject`      | none         | a dedicated tsconfig for tests (Fern's `tsconfig.test.json`)            |
| `testRules`        | `{}`         | one more relaxation for tests                                           |
| `rules`            | `{}`         | extra rules on typed source                                             |
| `standards`        | `[]`         | the family's standards blocks                                           |
| `overrides`        | `[]`         | the project's own blocks, appended last before Prettier                 |

**Block order is the point.** Flat config is last-match-wins, and a block with no `files` matches
everything. The catch-all block therefore comes _first_, before the strict block it would otherwise
undo, and the test relaxations come _after_ the standards so they are not re-tightened. Orchid had
this backwards: `no-explicit-any` and `no-unused-vars` were resolving to `warn` everywhere,
including inside the block that sets them to `error`. The order here is asserted in
`test/eslint.test.js` through ESLint's own resolver, not by reading the array.

Prettier is a file rather than a `"prettier"` key in `package.json` because the projects' own
`pkg:check` gate allows a fixed list of manifest keys, and a config file needs no exception to it.

**The project does not install the plugins.** `stylelint-config-standard-scss`, `stylelint-scss`,
`stylelint-declaration-strict-value`, `postcss-html`, `postcss-scss` and
`@commitlint/config-conventional` are dependencies of this package, and it hands Stylelint and
commitlint resolved absolute paths to them. That is what stops five projects pinning five drifting
copies — but it also means a project's **first** migration can surface findings its older copies
missed. Run the linters before and after and read the difference; it is real, not a regression.

`.prettierignore` and the `.husky/` hooks stay in each project: they name paths and commands
that only that project has.

## Options

**commitlint** — `subjectSingleWhy` (default on, warning only), `types`, `headerMaxLength`,
`bodyMaxLineLength`, `rules`.

**lint-staged** — `stylelint` (default off), `tasks`.

**stylelint** — the base is what every project already agreed on; each option below exists because
one project deliberately departs from it.

| Option                    | Default     | Turn it on when                                                 |
| ------------------------- | ----------- | --------------------------------------------------------------- |
| `spacingUnit`             | `'em'`      | the UI runs at a fixed size next to pixel-drawn content (Quartz) |
| `tokenProperties`         | colour only | the type and radius scales are tokenised too (Orchid, Mosaic)    |
| `ignoreZero`              | `false`     | `0` is a reset, not a design value waiting to be named          |
| `lowercaseCurrentColor`   | `false`     | `value-keyword-case` rewrites `currentColor` first              |
| `unknownCustomProperties` | `true`      | **off** where tokens are generated by a SCSS loop (Mosaic)      |
| `bem`                     | `false`     | class names are `block__element--modifier` (Mosaic)             |
| `noScssColorFunctions`    | `false`     | `$color-*` aliases resolve to `var(--color-*)` at runtime       |
| `noScssImport`            | `false`     | the project is fully on `@use`/`@forward`                       |
| `mobileFirst`             | `false`     | breakpoints only ever layer up with `min-width`                 |
| `duplicateFallbacks`      | `false`     | `100vh` then `100dvh` is a fallback, not a mistake              |
| `variablesOverride`       | `false`     | `_variables.scss` declares the aliases (Fern)                   |
| `referenceFiles`          | `[]`        | globs for token/theme files read for context (Quartz, bamboo) |
| `vue`                     | `true`      | leave on for `<style>` blocks in SFCs                           |
| `rules` / `overrides`     | `{}` / `[]` | the escape hatch, merged last                                   |

## Gate helpers

`repo-root`, `strip-comments` and `import-order` were the three files every `check-*` gate
imported, and each family carried its own version. `repo-root` and `strip-comments` are imported
directly; `import-order` is configured, and since the declaration-order gate moved here it is the
only caller, so its options are passed through that gate rather than through a project-side shim:

```ts
checkDeclarationOrder({
    sourceRoots: ['api/src', 'worker/src', 'frontend/src', 'packages/shared/src'],
    importOrder: {
        workspaceScope: '@orchid/', // four groups; omit it for a single-package repo
        localAliases: ['@test-utils'], // tsconfig paths that look like npm packages
    },
});
```

Where the two versions disagreed, the superset won and is documented in the file:
`strip-comments` blanks comments to spaces rather than deleting them, so byte offsets survive and
a gate can report the position it matched at; `repo-root` walks up for **either** a `workspaces`
manifest or a `.git` directory, because Orchid's version found nothing in a single-package repo and
Fern's `../..` was only right while the file stayed two levels down.

**These ship as `.js` with hand-written `.d.ts`, and that is not a style choice.** Node refuses to
strip TypeScript types from anything under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). A `.ts` file in this package works today only
because a local folder install is a symlink whose realpath is outside `node_modules` — it would
break the day this is published. Any future gate code added here has to be `.js` too, or the
package needs a build step.

### The gates themselves

All twenty-three are moved — `i18n`, `error-handling`, `declaration-order`, `pipeline`, `audit`,
`duplication`, `refactoring`, `code-style`, `dead-code`, `html-standards`, `testing`, `tsconfigs`,
`package-json`, `scss-standards`, `env-drift`, `db-drift`, `security-drift`, `metrics`,
`api-standards`, `ws-standards`, `docker`, `electron-security` and `ipc-standards`.
Each was ported by the same route: diff the five copies, port the superset, cross-check the result
against **every** project including the ones not yet migrated, then migrate the two reference
projects.

Each project keeps a one-file shim per gate under `scripts/check/`, holding only what that
project knows — its services, its vouched-for exceptions, each with a reason. The gate's options
are typed, so an editor lists them:

```ts
// scripts/check/check-error-handling.ts — the whole file
import { checkElectronErrorHandling } from '@larrydarko/lint-config/gates/error-handling/electron';

checkElectronErrorHandling({
    cleanupRequired: [['fsService', 'holds the vault fs watcher — …']],
});
```

## Checking it

```bash
npm test              # each toggle, asserted as a real stylelint run / ESLint resolution
npm run verify        # compares output against the 5 projects' current config files
npm run snapshot save  ../Quartz src/main/index.ts …   # before migrating its ESLint
npm run snapshot check ../Quartz                        # after
```

`npm run verify` is the one that matters while migrating: it reads each project's real config and
prints every value this package would produce differently. Zero differences means a project can
switch over without its lint results changing. The options each project needs live in
`scripts/verify.js`, which doubles as the migration checklist.

It keeps working after a project migrates: a project marked `migrated` there is read from the files
that now import this package, so the check becomes "does the live config still equal the options we
recorded" rather than "does it match the old file".

`npm run snapshot` is the ESLint equivalent, and the one to use when migrating a project's
`eslint.config.js`. Reading the old and new files side by side proves nothing — flat config is
last-match-wins, so what matters is the severity ESLint _ends up at_. `save` records that for one
file per area before the migration, `check` compares after, and every difference it prints is either
a bug or a change you meant. It found all three of the real problems in the Fern and Orchid
migrations.

**Expect a handful of new findings per project**, for the same reason as in phase 1: this package
pins newer versions than the projects did. Migrating Fern and Orchid surfaced nine redundant type
assertions (`typescript-eslint` 8.70 vs 8.58 narrows better) and one import specifier
(`eslint-plugin-import-x` 4.17 vs 4.16 stopped exempting deep package imports). All were real.

## License

MIT
