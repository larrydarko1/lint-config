/**
 * Document-level HTML standards gate — the one file no linter reads.
 *
 * ESLint's Vue parser never opens `index.html`, so nothing else in the toolchain
 * can assert that the document shell still has a `lang`, a charset, the mount point
 * the app calls `.mount()` on, or the metadata a crawler reads. Stylelint has the
 * same blind spot one level down: it can police how a rule is written, but not that
 * a rule still EXISTS, so deleting the global reduced-motion override is invisible
 * in review and silent at runtime.
 *
 * WHAT IS DATA AND WHAT IS A RULE. The five copies looked like two gates because
 * their head requirements differ — a web page owes `og:*`, `canonical`, a viewport
 * and an icon; a packaged renderer loading over `file://` owes none of them, and
 * the standard says so itself ("unless the project is exclusively desktop"). But
 * that is the LIST, not the rule. The rule is "the shell carries the tags this kind
 * of document owes", so the matchers live here in `HEAD_CHECKS` and each project
 * passes the keys it owes. A desktop shell asking for `title` is then a decision
 * someone made, not a difference nobody can see.
 *
 * THREE RULES ONLY ONE FAMILY HAD, AND ALL THREE ARE FREE:
 *   - the zoom ban (full-stack) fires on `user-scalable=no` / `maximum-scale=1`,
 *     and a document with no viewport tag at all never reaches it;
 *   - the entry-module check (one full-stack copy alone) fires on the `<script type="module"
 *     src>` every one of these shells has, and all five resolve;
 *   - no remote subresources (desktop) found nothing in either web shell.
 *
 * THE SUBRESOURCE RULE NEEDED FIXING BEFORE IT COULD BE SHARED. The desktop copies
 * matched any `<link>` with a remote `href`, which in a web shell is `<link
 * rel="canonical" href="https://…">` — metadata, not a subresource, and pointing it
 * at the live origin is the entire point of the tag. So the rule now reads the
 * `rel`: it fires on the rels that make the browser FETCH something (stylesheet,
 * preload, icon, manifest, a preconnect) and ignores the ones that only describe
 * the document. That is the difference the original rule was reaching for.
 *
 * THE REDUCED-MOTION CHECK IS THE STRICTER HALF OF EACH COPY. The desktop copies
 * scoped the search to the block and accepted any neutralising declaration; the
 * full-stack copies demanded `!important` on both durations but read from the first
 * `prefers-reduced-motion` in the file to EOF, so a declaration outside the block
 * would have satisfied them. Here the block is found first and then held to
 * `!important`, which is what makes a global override beat the scoped SFC rules it
 * exists to beat. All five repos already pass it.
 *
 * `csp` IS THE ONE REAL SWITCH. In a packaged build the renderer loads over
 * `file://`, where there is no server to send a header, so the meta tag IS the
 * policy — and a CSP degrades silently, because a directive someone widened still
 * parses and still loads the app. A served web app sends the header instead, and
 * that header is a different gate's business, so checking for a meta tag there
 * would fail a correct document.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: semantic element choice, ARIA appropriateness,
 * alt-text quality, heading order. All of it is in the standard, none of it is
 * decidable from a regex over the shell, and a gate that pretended otherwise would
 * teach people to write markup that passes rather than markup that reads.
 */
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from './repo-root.ts';
import { createGateReport, plural } from './report.ts';

/** A presence check over the document shell. */
export type HeadCheck = {
    /** The tag, as it appears in the failure message. */
    what: string;
    re: RegExp;
    why: string;
};

/** Every head requirement any of the shells had. A project passes the keys it owes. */
export type HeadRequirement =
    | 'lang'
    | 'charset'
    | 'appMount'
    | 'viewport'
    | 'title'
    | 'description'
    | 'ogTitle'
    | 'ogDescription'
    | 'ogImage'
    | 'canonical'
    | 'twitterCard'
    | 'themeColor'
    | 'icon';

export type HtmlStandardsOptions = {
    root?: string;
    /** The document shell, relative to the repo root. */
    indexHtml: string;
    /** The stylesheet that owns the global reduced-motion override. Omit to skip that check. */
    baseScss?: string;
    /** The head requirements this document owes. */
    require?: HeadRequirement[];
    /** True where the meta tag IS the policy — a renderer loading over `file://`. */
    csp?: boolean;
    /** A pre-launch origin that should be replaced before shipping. Warns, never fails. */
    placeholderOrigin?: string;
    /** The document to point at on failure. */
    standard?: string;
};

export type HtmlStandardsInput = Omit<HtmlStandardsOptions, 'standard'> & { root: string };

export type HtmlStandardsProblem = {
    file: string;
    what: string;
    why: string;
};

export type HtmlStandardsInspection = {
    problems: HtmlStandardsProblem[];
    /** Non-failing notes, printed after the report. */
    warnings: string[];
    /** How many head requirements were asked for. */
    required: number;
};

/**
 * Every head requirement any of the five documents had, as a matcher per key. A
 * project passes the keys it owes; a key it does not pass is a tag it does not owe.
 */
export const HEAD_CHECKS: Record<HeadRequirement, HeadCheck> = {
    lang: {
        what: '<html lang="…">',
        re: /<html[^>]+\blang="[a-z]{2}[^"]*"/i,
        why: 'Screen readers pick pronunciation from it on load, before any locale the app selects later.',
    },
    charset: {
        what: '<meta charset>',
        re: /<meta[^>]+charset=/i,
        why: 'Without it the browser guesses the encoding, and the content it is guessing about is arbitrary user text.',
    },
    appMount: {
        what: '<div id="app">',
        re: /<div[^>]+id="app"/i,
        why: 'The mount point `main.ts` calls `.mount("#app")` on. Rename it and the app renders nothing, with no error.',
    },
    viewport: {
        what: '<meta name="viewport">',
        re: /<meta[^>]+name="viewport"/i,
        why: 'Mobile layout collapses to a desktop viewport without it.',
    },
    title: {
        what: '<title>',
        re: /<title>[^<]+<\/title>/i,
        why: 'The tab name and the first thing a screen reader announces.',
    },
    description: {
        what: '<meta name="description">',
        re: /<meta[^>]+name="description"[^>]+content="[^"]{50,}"/i,
        why: 'Search and social summary — it needs to be a real sentence, not a stub.',
    },
    ogTitle: {
        what: '<meta property="og:title">',
        re: /<meta[^>]+property="og:title"/i,
        why: 'Link previews fall back to the raw URL without it.',
    },
    ogDescription: {
        what: '<meta property="og:description">',
        re: /<meta[^>]+property="og:description"/i,
        why: 'Link previews show no summary without it.',
    },
    ogImage: {
        what: '<meta property="og:image">',
        re: /<meta[^>]+property="og:image"[^>]+content="https?:\/\//i,
        why: 'Link previews need an absolute image URL — a relative path is not resolved by most crawlers.',
    },
    canonical: {
        what: '<link rel="canonical">',
        re: /<link[^>]+rel="canonical"[^>]+href="https?:\/\//i,
        why: 'An absolute canonical URL stops query-string and trailing-slash variants indexing as separate pages.',
    },
    twitterCard: {
        what: '<meta name="twitter:card">',
        re: /<meta[^>]+name="twitter:card"/i,
        why: 'Controls the preview shape on X/Twitter. The card tags are `name=`, not `property=` — Open Graph is the vocabulary that uses `property`, and a `property="twitter:card"` is silently ignored by validators that follow the spec.',
    },
    themeColor: {
        what: '<meta name="theme-color">',
        re: /<meta[^>]+name="theme-color"/i,
        why: 'Mobile browser chrome flashes a light bar above a dark app without it.',
    },
    icon: {
        what: '<link rel="icon">',
        re: /<link[^>]+rel="icon"/i,
        why: 'Browsers request /favicon.ico and 404 without it.',
    },
};

/** Directives that must be present in a meta-tag CSP, locked to the value given. */
export const CSP_REQUIRED: HeadCheck[] = [
    {
        what: "default-src 'self'",
        re: /default-src\s+'self'\s*(?:;|$)/,
        why: "The backstop every directive without an explicit rule falls through to. It is matched to the end of the directive, because `default-src 'self' https:` still contains the words and still opens every unlisted fetch type.",
    },
    {
        what: "object-src 'none'",
        re: /object-src\s+'none'\s*(?:;|$)/,
        why: '<object>/<embed> load plugin content that is not covered by script-src — a bypass that looks like nothing.',
    },
    {
        what: "base-uri 'none'",
        re: /base-uri\s+'none'\s*(?:;|$)/,
        why: 'An injected <base> rewrites every relative URL in the document, including the entry script, without touching script-src.',
    },
    {
        what: "form-action 'none'",
        re: /form-action\s+'none'\s*(?:;|$)/,
        why: 'A local-first app never posts anywhere. Without this, injected markup can exfiltrate via a form submit, which no other directive covers.',
    },
    {
        what: 'frame-ancestors or frame-src',
        re: /frame-(ancestors|src)\s+[^;]+/,
        why: 'The policy has to say which schemes may fill a frame. An unset directive falls through to default-src, which would allow one.',
    },
];

/** Values that must never appear. A CSP that was widened still parses. */
export const CSP_BANNED: HeadCheck[] = [
    {
        what: "'unsafe-eval'",
        re: /'unsafe-eval'/,
        why: 'SFCs are precompiled and vue-i18n v10+ uses the CSP-safe JIT compiler, so nothing here needs it. Its presence means something started evaluating strings.',
    },
    {
        what: "'unsafe-inline' in script-src",
        re: /script-src[^;]*'unsafe-inline'/,
        why: 'Turns every value the app can put on screen into script execution. (style-src may keep it — Vue :style bindings need it.)',
    },
    {
        what: "a wildcard host ('*')",
        re: /(?:^|\s)\*(?:\s|;|$)/,
        why: 'A local-first app has no origin to reach. A wildcard is a network egress path in the one policy that was supposed to forbid one.',
    },
];

/** `rel` values that make the browser fetch something. The rest only describe the document. */
const FETCHING_REL =
    /^(stylesheet|preload|modulepreload|prefetch|preconnect|dns-prefetch|icon|shortcut icon|apple-touch-icon|manifest)$/i;

const LOCAL_HOST = /^(localhost|127\.0\.0\.1)(:\d+)?\/?$/;

/**
 * Where a `<script type="module" src>` points, resolved the way the browser resolves
 * it: against the document's own directory, with a leading `/` meaning the Vite root
 * rather than the filesystem root.
 */
export function entryPath(src: string, indexHtml: string): string {
    return path.posix.join(path.posix.dirname(indexHtml), src.replace(/^\//, './'));
}

/**
 * Every problem in one document shell, without printing anything.
 */
export function inspectHtmlStandards(input: HtmlStandardsInput): HtmlStandardsInspection {
    const { root, indexHtml, baseScss, require: required = [], csp = false, placeholderOrigin } = input;

    const problems: HtmlStandardsProblem[] = [];
    const warnings: string[] = [];
    const fail = (file: string, what: string, why: string): void => {
        problems.push({ file, what, why });
    };
    const html = fs.readFileSync(path.join(root, indexHtml), 'utf8');

    // ── 1. The document shell ───────────────────────────────────────────────
    for (const key of required) {
        const check = HEAD_CHECKS[key];
        if (check === undefined) throw new Error(`Unknown head requirement '${key}'.`);
        if (!check.re.test(html)) fail(indexHtml, `is missing ${check.what}`, check.why);
    }

    // Zoom is an accessibility feature — blocking it fails WCAG 1.4.4. Silent in a
    // document with no viewport tag, which is why it needs no switch.
    if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/i.test(html)) {
        fail(
            indexHtml,
            'has a viewport that blocks zoom',
            'Never `user-scalable=no` or `maximum-scale=1` — pinch-zoom is an accessibility feature (WCAG 1.4.4).',
        );
    }

    // ── 2. The entry module resolves ────────────────────────────────────────
    const src = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (src === undefined) {
        fail(
            indexHtml,
            'has no `<script type="module" src="…">`',
            'It is the single entry the bundler builds the graph from, and the one import in the app that no compiler checks. Without it the built page loads nothing.',
        );
    } else {
        const rel = entryPath(src, indexHtml);
        // The bundler resolves the specifier, not the file name, so a `.js` src for a
        // `.ts` module happens to work and is still a lie about the tree.
        const found = [rel, rel.replace(/\.js$/, '.ts')].find((c) => fs.existsSync(path.join(root, c)));
        if (found === undefined) {
            fail(
                indexHtml,
                `entry \`${src}\` does not exist`,
                'Nothing typechecks this path. Point it at the real entry module.',
            );
        } else if (found !== rel) {
            fail(
                indexHtml,
                `entry is \`${src}\` but the file is \`${path.posix.basename(found)}\``,
                'The bundler resolves the specifier rather than the filename, so this works — right up until something else reads the tag literally. Name the file that exists.',
            );
        }
    }

    // ── 3. The Content-Security-Policy meta tag ─────────────────────────────
    if (csp) {
        const match = /<meta[^>]+http-equiv="Content-Security-Policy"[^>]*content="([^"]*)"/i.exec(html);
        if (match === null) {
            fail(
                indexHtml,
                'has no Content-Security-Policy meta tag',
                'In a packaged build the renderer loads over file:// — there is no server to send a CSP header, so this tag is the entire policy.',
            );
        } else {
            const policy = (match[1] ?? '').replace(/\s+/g, ' ').trim();
            for (const { what, re, why } of CSP_REQUIRED) {
                if (!re.test(policy)) fail(indexHtml, `CSP is missing \`${what}\``, why);
            }
            for (const { what, re, why } of CSP_BANNED) {
                if (re.test(policy)) fail(indexHtml, `CSP contains ${what}`, why);
            }
            // localhost is the dev server's HMR socket, which cannot resolve in a packaged build.
            for (const remote of policy.matchAll(/\b(https?|wss?):\/\/([^\s;]+)/g)) {
                if (!LOCAL_HOST.test(remote[2] ?? '')) {
                    fail(
                        indexHtml,
                        `CSP allows the remote origin \`${remote[0]}\``,
                        'Nothing in this app may reach the network. Only the dev-server HMR socket on localhost is permitted here.',
                    );
                }
            }
        }
    }

    // ── 4. No remote subresources in the shell ──────────────────────────────
    for (const tag of html.matchAll(/<(script|link|img)\b[^>]*>/gi)) {
        const markup = tag[0];
        if (!/\b(?:src|href)="(?:https?:)?\/\//i.test(markup)) continue;
        const rel = /\brel="([^"]+)"/i.exec(markup)?.[1];
        // A <link> that only describes the document — canonical, alternate, an og:url
        // sibling — names a remote URL on purpose. Only the rels that fetch count.
        if (tag[1]?.toLowerCase() === 'link' && !FETCHING_REL.test(rel ?? '')) continue;
        fail(
            indexHtml,
            `loads a remote subresource: \`${markup.replace(/\s+/g, ' ').slice(0, 60)}…\``,
            'Every asset ships inside the app. A remote one is a network request on launch, a privacy leak to whoever serves it, and a build that stops being reproducible.',
        );
    }

    // ── 5. The reduced-motion escape hatch ──────────────────────────────────
    if (baseScss !== undefined) {
        const scss = fs.readFileSync(path.join(root, baseScss), 'utf8');
        // Anchored at column 0: a block nested inside a selector only reaches the
        // elements that selector matches, which is not what "global override" means.
        const blocks = [
            ...scss.matchAll(/^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{([\s\S]*?)\n\}/gm),
        ];
        if (blocks.length === 0) {
            fail(
                baseScss,
                'has no top-level `@media (prefers-reduced-motion: reduce)` block',
                'It is the only place every transition and animation in the app can be switched off at once (WCAG 2.3.3). Without it each declaration would have to opt out individually.',
            );
        } else {
            for (const prop of ['animation-duration', 'transition-duration']) {
                const forced = blocks.some(([, body = '']) => new RegExp(`${prop}:[^;]*!important`).test(body));
                if (!forced) {
                    fail(
                        baseScss,
                        `reduced-motion block does not force ${prop}`,
                        'Guarding only `scroll-behavior` leaves every other declaration running, and without `!important` the override loses the cascade to the component-scoped rules it exists to beat.',
                    );
                }
            }
        }
    }

    // ── 6. The launch checklist, as a warning ───────────────────────────────
    if (placeholderOrigin !== undefined && html.includes(placeholderOrigin)) {
        warnings.push(
            `${indexHtml} still uses the placeholder origin "${placeholderOrigin}".` +
                '\n  Before launch:' +
                '\n    • point canonical / og:url / og:image at the real domain' +
                '\n    • add the og-image.png asset (1200×630) — the URL 404s until it exists' +
                '\n    • move canonical to per-route generation (unhead/vue-meta): one static' +
                '\n      canonical tells crawlers every route is the homepage.',
        );
    }

    return { problems, warnings, required: required.length };
}

/**
 * @param [options.standard] The document to point at on failure.
 */
export function checkHtmlStandards(options: HtmlStandardsOptions): void {
    const { root = REPO_ROOT, standard, ...rest } = options;

    const report = createGateReport({ name: 'HTML standards', standard });
    const { problems, warnings, required } = inspectHtmlStandards({ root, ...rest });
    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `Document shell intact — ${plural(required, 'required tag')} present, the entry module resolves, ` +
            `no remote subresources${rest.csp === true ? ', the CSP is locked' : ''}` +
            `${rest.baseScss === undefined ? '' : ', the reduced-motion override is still there'}.`,
        notMachineChecked:
            'semantic element choice, ARIA appropriateness, alt-text quality, heading order — all of it is in ' +
            'the standard and none of it is decidable from the shell.',
    });

    // After the report, and only when it passed: a launch checklist under a red X is
    // noise, and the gate that failed is the thing to read first.
    if (report.count === 0) for (const warning of warnings) console.warn(`\n⚠ ${warning}`);
}
