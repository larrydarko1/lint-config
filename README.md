# @larrydarko/lint-config

One home for the formatting, commit and style rules shared by Orchid, Mosaic, Fern, Quartz and
bamboo. Fix a rule here, and every project picks it up on its next update instead of needing
the same edit pasted five times.

Status: **phases 1 and 2 done**, phase 3 in progress — Prettier, commitlint, Stylelint,
lint-staged and ESLint are here, along with the helpers every `check-*` gate imports and the first
two gates themselves (`i18n`, `error-handling`). The remaining gates are moving one batch at a
time, newest-correct copy winning; see **Gate helpers** below.
Not published; installed from this folder while it is proved out.
**Fern** (Electron) and **Orchid** (full-stack) are migrated and are the worked examples, one per
family; Quartz, bamboo and Mosaic still use their own files.

## Using it in a project

```bash
npm i -D ../lint-config          # local for now; an npm install once it is published
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

Sixteen are moved so far — `i18n`, `error-handling`, `declaration-order`, `pipeline`, `audit`,
`duplication`, `refactoring`, `code-style`, `dead-code`, `html-standards`, `testing`, `tsconfigs`,
`package-json`, `scss-standards`, `env-drift` and `db-drift`.
Each was ported by the same route: diff the five copies, port the superset, cross-check the result
against **every** project including the ones not yet migrated, then migrate the two reference
projects.

Doing that turned up the thing the table below hides. **The divergence is almost entirely BETWEEN
families, not within one.** `error-handling` is the worst case in the table at 189 lines, and it
splits cleanly: Orchid and Mosaic differ by 54 lines and Fern/Quartz/bamboo by 10-38 — and not
one of those lines is logic. They are lists. Which services exist, which codes are parse-level,
which are security events, which native handles need releasing. So the two family entry points
below reproduce all five projects' existing output exactly, with the lists passed in as options.

```ts
// scripts/check/check-error-handling.ts — the whole file
import { checkElectronErrorHandling } from '@larrydarko/lint-config/gates/error-handling/electron';

checkElectronErrorHandling({
    cleanupRequired: [['fsService', 'holds the vault fs watcher — …']],
});
```

Where two copies genuinely disagreed, the **more correct** one won rather than the newer one, and
the reason is recorded in the file. The swallowed-failure check now rejects `/* ignore */` because
Fern's own failure message already said a comment must give a reason; the interceptor check no
longer insists the i18n key be written inline, because extracting it to a variable is the same
contract and Orchid's regex would have failed a refactor that changed nothing.

`declaration-order` is the first one that was genuinely the same tool in all five projects: its
whole body — 635 lines in Fern's copy: the category table, the topological sort that computes the one legitimate
exception to it, the separate table a suite is read against, and the `--fix` pass — moved without a
family split. Only the scope and the import groups stayed behind. The one rule that differed was
Fern's `isTestPath`, which also treats a top-level `tests/` tree as suites; it is the superset and
neither full-stack repo has such a directory under a source root, so it ships and changes nothing
for the other four.

Cross-checking it against Mosaic paid for itself again. A specifier beginning with `#` is resolved
by Node through the package's own `imports` field, so it can only ever name a file **inside** this
package — Mosaic's gate had that rule and the other four did not, because only Mosaic uses the
idiom. Except that Orchid uses it too, in `packages/shared`, and had been sorting those imports
into the external group next to `pino`. The rule is a language fact rather than project data, so
it is unconditional here; `--fix` reordered the eight Orchid files it surfaced.

`pipeline` and `audit` are the two where the families' copies looked most like different tools and
turned out not to be.

The full-stack pipeline gate carried five rules about containers and self-hosted deploys — image
tags, BuildKit cache scopes, `packages: write`, scrubbed secret files, checksummed downloads —
that the desktop one had never needed. But none of the five is Docker-specific in its **trigger**:
each fires only on the step shape it is about, and is silent in a repository that has none. So the
shared gate is the plain union of the two, eighteen rules with one option (where the gate scripts
live), and each family simply exercises a different half of it. Three rules moved the other way,
and each is strictly more correct than what the full-stack copy had:

- the runner check resolves a matrix `runs-on`, so it stops skipping exactly the jobs that compile
  native modules — and now reports a computed `runs-on` it cannot resolve, rather than passing it
  silently;
- the `workflow_run` gate is followed through `needs:`, so one job can carry the full three-clause
  condition and the rest depend on it, instead of the same condition being maintained in four
  places;
- **Orchid gained rule 18 outright**: nothing was checking that the Node major CI installs matches
  `engines.node`. It passes, but nothing had been proving it.

`audit` is the one where each family had a different **half** of the same idea. The full-stack copy
put an expiry on every waiver and only printed a note when one went stale; the desktop copy dropped
the expiry and made the stale entry fail. Those guard different failures — "you stopped looking"
against "you no longer need to" — so the shared gate keeps both, plus a third: a waiver missing any
of its four fields. Both allowlists were empty, so adopting all three cost nothing.

It also carries two corrections from the desktop copy, and the first matters:

- **an `npm audit` that reports an ERROR is now a failure.** The full-stack copy parsed the JSON,
  found no `vulnerabilities` key and printed a clean audit — so an unreachable registry looked
  exactly like a green tick. An audit that did not run has verified nothing.
- a waiver counts as "still reported" at any severity, not only at high or critical. Matching
  against the filtered rows meant a waiver for an advisory downgraded to moderate was called stale
  while it was still live.

`duplication` is the one where the two families' copies read like different gates and are not. The
full-stack copies check for a block copied between two workspaces and for one exported type name
declared in two of them; the desktop copies check a per-format ceiling and a cap on any single
clone. Only the first pair looks family-shaped, and it is shaped by the REPOSITORY rather than by
the family: both rules compare one scan root against another, so in a repo with one root they have
nothing to compare and say nothing. The shared gate is the union of all four, with no switch, and a
single-root project simply never reaches the last two. That is the same trigger test `pipeline`
needed, applied a second time.

The numbers are the part that stays per project, and an omitted format is a decision rather than a
gap: the full-stack repos gate `typescript` alone because their SCSS is the same handful of
declarations inside different SFCs, where `@extend` cannot cross the SFC boundary — de-duplicating
those means promoting each one to a real global class, which is a design call and not something a
percentage should force. Two options carry the rest of the disagreement:

- `perRoot` runs the ceilings against each scan root on its own as well as all of them together,
  which is what stops a small heavily-duplicated workspace being diluted by a large clean one. The
  full-stack copy did that and the desktop copy did not; it is now a choice, not a fork.
- `maxCloneTokens` caps any single clone. A percentage is a ratio, so it quietly improves as a
  codebase grows and a large new copy-paste can land while the number goes DOWN. Only the desktop
  family had this rule. It is off in the full-stack repos for an honest reason: **Orchid's largest
  clone is 355 tokens**, so setting the cap today would bless it rather than catch it.

`refactoring` was the same gate everywhere, and the five copies disagreed on exactly one thing that
mattered: four matched the deferral markers in their shouted form only, one matched
case-insensitively. Case-sensitive wins, and not by majority. This gate reads locale JSON and
prose, where `todo` is an ordinary Spanish and Portuguese word — "Copiar Todo", "todo lo que",
"todo o seu portfólio" — and three of the five repos ship exactly those strings. A
case-insensitive match flags every one of them, and the only way to make a translation pass is to
make it wrong. The lowercase case that does matter, `// todo` in code, is ESLint's, whose `terms`
are lowercase and matched case-insensitively already.

Each family also had a piece the other lacked, and both are now everyone's:

- the desktop copies strip fenced blocks and inline code spans out of Markdown before matching,
  because a backticked word is being named rather than used — `notes/todo.md` in a contributing
  guide is a filename. They are replaced with spaces rather than deleted, so every line number
  after them still points at the real line.
- the full-stack copies read **every** tracked text file that ESLint cannot parse, rather than an
  allowlist of extensions. That closed a real gap in the desktop family: the git hooks, `LICENSE`
  and the ignore files were unscanned in all three, and in bamboo so was the entire Android
  side — `.gradle`, `.java`, `.xml`, `.properties`.

Which extensions ESLint covers is the one option, and it does the SFC split too: listing `.vue` in
`linted` means ESLint has the `<script>` half, so the gate reads the `<template>` half — which
`no-warning-comments` never sees, because it reads `sourceCode.getAllComments()` and
vue-eslint-parser keeps the template on a separate AST. A project with no ESLint passes
`linted: []` and the gate takes all of it, SFC included.

`code-style` looked like the clearest family split of the lot, and was not. The full-stack pair
names backend modules `kebab-case`; the desktop three name `.ts` `camelCase` and `.vue`
`PascalCase`. But that is the naming CONVENTION, which is data. The rule is "a filename follows
the convention for where it sits", and it is the same rule in both — so `casing` is an ordered list
of `{ files, style, exempt }` and a file no entry matches is deliberately unconstrained. The same
reading collapsed `headers` into a `{ files, require }` list, where `require: 'none'` is a BAN on a
file header, and bans are the rules nothing else would ever catch.

Applying the trigger test to the four rules only one family had gave the same answer every time:

- **a composable file must export its own name** (desktop). `useFoo.ts` exporting `useOther` is a
  filename that lies about its contents while every import site still reads perfectly. Zero
  findings in the full-stack repos, which have `useDashboardUploads.ts` files of their own.
- **SFC block order** (Mosaic and desktop). Zero findings in Orchid, which never had the rule.
- **the two stale-baseline rules** (full-stack). Four real findings: three baseline entries in Fern
  and one in Quartz name files that shrank back under the cap. `AudioViewer.vue` was baselined at
  514 and is 305 today, so its entry was licensing 209 lines of regrowth. A ratchet that can only
  be tightened by hand is one that quietly stops being tight.
- **`aliasedRoots`** (Mosaic). The only rule that cannot simply be switched on everywhere — and it
  is self-silencing, because a repo that declares no alias roots never reaches it.

One rule was subtly wrong in the copy that had it. Mosaic's `<script setup lang="ts">` check reads
the FIRST script block, and an SFC may legitimately open with a plain `<script lang="ts">` — that
is where a generic component declares the type its setup block is generic over. Orchid has exactly
one. The shared gate finds the block carrying `setup` wherever it sits and holds the companion to
TypeScript rather than to `setup`.

The copies also disagreed about the UNIT the `baseline` numbers are written in, which looked at
first like an option: the full-stack pair count non-blank lines and drop an SFC's `<style>` block,
the desktop three counted what `wc -l` counts, and the gap is not small — Fern's `AiMessageList.vue`
is 1098 lines one way and 490 the other. The standard decides it rather than taste: _"files over
~400 lines (template and script only, style can be ignored)"_, and the SCSS standard says outright
that no gate counts stylesheet lines and none will. A measure that counts the style block also pays
a component for moving its CSS out of the file it belongs to. So the desktop measure was drift: the
baselines were re-measured once (Fern 19 entries → 11, because eight were over the cap only on
their stylesheets) and the option is gone rather than left as a dial that can put the drift back.

`dead-code` was the opposite: the same file five times. With comments stripped, the five copies
differ in four lines — which knip issue types are left ungated, one environment variable, the path
in the closing hint, and the glyph in front of the word. Nothing about it is family-shaped, because
knip reports what it finds and a repo without pnpm catalogs simply has no catalog findings. The
options are `checksDir`, the footer text, and `budgets`, which is zero everywhere and is the shape
of a backlog being cleared rather than a dial.

Its two passes are the part worth keeping: knip's default graph counts a test file as a consumer,
so an export that only its own test imports looks alive — a fully tested owner-role middleware
mounted on zero routes passed for months. The second pass drops test files from the graph and
subtracts whatever the first pass already named, so nothing is reported twice.

`html-standards` is the gate for the one file no linter reads. Its five copies disagreed about
which tags the shell owes, which is the LIST and not the rule: a web page owes `og:*`, a canonical
and an icon, and a renderer loading over `file://` owes none of them — the standard says so itself
("unless the project is exclusively desktop"). So the matchers live in the gate as `HEAD_CHECKS`
and each project passes the keys it owes, which turns twelve absent tags from a difference nobody
can see into a decision somebody made. Three rules only one family had cost nothing to switch on
everywhere: the zoom ban never fires in a document with no viewport tag, the entry-module check
resolves in all five shells, and no remote subresource was found in either web shell.

Two of its rules needed fixing before they could be shared. The desktop subresource rule matched
any `<link>` with a remote `href`, which in a web shell is `rel="canonical"` — metadata, and
pointing it at the live origin is the entire point of the tag; it now reads the `rel` and fires
only on the ones that make the browser fetch something. And the CSP directives were described as
"locked to the value given" while the matchers only checked a prefix, so `default-src 'self'
https:` passed a rule written to stop exactly that. Both fixes are free in all five repos.

`testing` looked the furthest apart of any gate and was not: one family co-locates suites in
`__tests__/` and runs Playwright out of `e2e/`, the other mirrors `src/` under `tests/` and has
deliberately NO E2E suite. Underneath, the same three sentences — every suite is where this
project said suites go, a `.spec` file belongs to the E2E runner so it lives where E2E lives
(which may be nowhere), and the numbers that define failure only move one way. `layout` and `e2e`
carry the pattern; the rules are shared. Both one-family rule sets were free again: suite hygiene
(`.only`, `.skip`, a bare `test()`, a commented-out case, two cases with one title in a `describe`)
finds nothing across 464 full-stack suites, and the transport-patching rule finds nothing in the
desktop three. Each family now checks something it never had.

`tsconfigs` and `package-json` were the two closest gates left, and both came apart the same way.
Nine rules each in `tsconfigs`, eight of them the same rule, and the three lists they are built on
— nineteen strictness flags, ten environmental settings, eight section dividers — were
**byte-identical across all five repos**, in two families that never shared a file. The apparent
split was one rule, and even that was two instances of one shape: "this named project may not do
X". `package-json` was closer still: the two full-stack copies were byte-identical to each other,
and the desktop three differed by one comment and one entry of a data list. Its three
Electron-only rules needed no switch — they fire on a `build` block and an electron-vite config,
so a web repo never triggers them. What DID need fixing was that the desktop copy read the
electron-vite config unconditionally, which in a repo without one is a crash rather than a pass.

`tsconfigs` also produced the sharpest finding of the port so far. The desktop copy checked that a
browser project does not DECLARE `node` in its `types`. Orchid passed that check — and its frontend
compiles `process.env` anyway, because `packages/shared` does `import type Stripe from 'stripe'`,
the barrel re-exports it, and the Stripe SDK's typings carry a `/// <reference types="node" />`
that drags 82 `@types/node` files into a program that asked for `vite/client` only. **The
declaration is not the effect.** So the gate now also checks the source: no file in a browser tree
may import a Node builtin or touch a Node global, tests excluded because they run under Vitest in
Node. That rule is free in all five repos today and is the half that actually holds.

One genuine disagreement in `package-json` was settled by going to the authority rather than
picking a side: the standard names `sort-package-json` as the canonical field order, and that tool
puts `packageManager` immediately before `engines`. The full-stack family already did; the desktop
family did not. The loser's spelling is gone rather than kept as an option, because an option is
how drift comes back. What is deliberately NOT adopted is that tool's full 111-key order, which
disagrees with the standard's own written sketch in places that would move a field in every
manifest in every repo — a question about the standard, not about this gate.

`scss-standards` was the hardest, and the only one whose five copies disagreed about **what** they
were checking rather than how. They agreed on the principles and differed on the spelling, because
the projects genuinely differ: one ships its themes as JSON files users hand-edit, which is a
product feature rather than a style preference. What made it one gate was noticing that two roles
hide behind the word "barrel", and every project has both. The **injected** module is whatever
`additionalData` prepends to each SFC style block — compiled once per component. The **entry**
module is what `main.ts` imports, once. Three projects inject the token module and let `index.scss`
be both barrel and entry; two inject the barrel, which forces the entry into a second file. That is
not two architectures needing a switch. It is one rule — _whatever is injected must emit nothing,
transitively_ — reading two different starting points, and the single-file check in the older
copies is the degenerate case of the graph walk in the newest.

That rule found a real bug. Orchid injects `_variables.scss`, and `_variables.scss` held the five
`[data-theme='…'] { @include emit-theme(…) }` blocks. Measured on the real build, not argued:
**every palette appeared 47 times in the production CSS**, once per SFC plus once for the barrel,
and moving the emission into a partial only the entry reaches took the stylesheet from 286,849
bytes to 110,002 — 62% of it was duplicated palettes. Four of the five projects already had a rule
against this. The fifth did not, and it was the one with the bug. Worth recording why: the standard
says "the mechanism, all in `variables.scss`", and also that `variables.scss` is auto-injected into
every SFC. Following both sentences literally is what produces 47 copies, so **the standard needs
the same correction the code just got**.

Three of its rules were settled by the standard rather than by recency. No Sass colour function on
a `$color-*` token, and no `@extend` inside an SFC, each existed in exactly one copy and are stated
outright in the standard, so both are in for everyone — and both are free in all five today. The
font rules are the standard's full set (no CDN, no `@fontsource`, `@font-face` resolving to a
bundled asset, the upstream `LICENSE` shipped beside the woff2), where one copy checked the first
two and another the last two. The two that only apply to a project that vendors fonts stay silent
in one that does not, because a system font stack is not a violation.

The one real switch is `themes.source`, and it earns being a switch: `scss-maps` is what the
standard describes, `css-blocks` is what a project picks when it wants stylelint's
`no-unknown-custom-properties` to see the palette (a Sass map is opaque to it, and to this gate),
and `json-presets` is what a project picks when users edit the themes themselves. All three feed
the identical comparison — a reference palette, every other palette carrying exactly its key set, a
fallback layer that matches, and no `var()` naming something nothing declares.

Three things nearly every gate had its own copy of are now shared too: `report` (the
fail/report/exit block, 15 gates), `files` (the directory walk, 12 gates in six signatures), and
`swallowed-errors`. `report` groups failures by file, always prints why a rule exists, and uses
`process.exitCode` rather than `process.exit` so a piped CI log cannot be truncated mid-write.

`env-drift` and `db-drift` are the first family-only pair, and they behave differently from
everything above: with only two copies each and both in the same family, the divergence is not a
family split but plain drift, one copy ahead of the other on each rule. So the port is the union
and every disagreement is settled once.

Three settlements are worth recording because the losing spelling was not merely older — it was
**wrong in a way a passing gate hides**. `env-drift`'s gitignore rule read `.gitignore` with a
regular expression; whether git ignores a path depends on pattern order, negations and every
nested ignore file in the tree, so the regex could report "`.env` is ignored" about a file git was
tracking. Asking `git check-ignore` is the only thing that knows. (It also turned up that the
`!*.env.example` negation one repo carries was never doing anything: `*.env` matches names _ending_
in `.env`, which `.env.example` does not.) And `db-drift`'s registry is now imported rather than
regex-parsed, which proves something the regex could not — the bootstrap migration reads that
module through the migrate-mongo CLI, where there is no bundler and no path aliases, so a runtime
import added to it breaks `npm run db:migrate` and nothing else.

Four rules came from the standards rather than from either copy, and all four are free in both
repos today. `process.env` is read nowhere but the config module and the entry file. Every index
entry carries a `why` — the keys are the what, and TypeScript already shows you that. A TTL index
carries `expireAfterSeconds`, without which it is an ordinary date index that silently never
deletes anything. And an unindexed collection is an error with a written exemption rather than a
warning, because the difference between a decision and an oversight is whether someone wrote it
down.

Writing the tests found three rules that a **comment, a type declaration or a function declaration**
was enough to satisfy. `source.includes('SIGTERM')` passed on the prose explaining why the handler
matters. `/flushdb\(\)/` matched `{ flushdb(): Promise<unknown> }`, an inline client type near the
top of the file — which would also have passed the flush-before-enqueue ordering check every time,
whatever the code below did. And `ensureIndexes\s*\(` matched `async function ensureIndexes(db)`,
so a file that defines the applier and never calls it counted as calling it. All three are the same
mistake: matching a name instead of a use.

What is left is family-only: `api-standards`, `metrics`, `security-drift`, `ws-standards` and
`docker` exist only in the full-stack projects, and `electron-security` and `ipc-standards` only in
the desktop ones. Those do not need a drift table — a gate that lives in two or three copies of one
family is a different problem from one that had to reconcile two families, and none of them has to
decide whether it is one tool or two.

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
