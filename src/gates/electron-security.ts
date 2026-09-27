/**
 * The process-model invariants of a desktop app:
 * ––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––––– 
 *   1.  contextIsolation, nodeIntegration and sandbox set safely on every window.
 *   2.  No banned webPreferences (webviewTag, allowRunningInsecureContent,
 *       experimentalFeatures, enableRemoteModule, nodeIntegrationInWorker/SubFrames,
 *       webSecurity: false).
 *   3.  Every window declares a preload.
 *   4.  setWindowOpenHandler denies, and never allows.
 *   5.  will-navigate calls `preventDefault()`.
 *   6.  No `new-window` handler (removed in Electron 22).
 *   7.  Both permission handlers exist and have a deny path.
 *   8.  A custom protocol checks its boundary and refuses with 403; no deprecated
 *       `register*Protocol`.
 *   9.  A privileged scheme does not bypass CSP.
 *  10.  shell.openExternal is scheme-guarded, inside its own function.
 *  11.  No unescaped HTML sinks: `innerHTML` only from literals, consts bound to
 *       them, or a sanitizer.
 *  12.  Every `v-html` binding is accounted for, per binding.
 *  13.  No RegExp built from unescaped input.
 *  14.  No TLS or certificate overrides.
 * - Spans are bracket-counted (source.ts). The rule 8 boundary check and the rule 11
 * sanitizers are recognised by name; their correctness is a unit test's question.
 */
import fs from 'node:fs';
import path from 'node:path';

import { walkFiles } from './lib/files.ts';
import { REPO_ROOT } from './lib/repo-root.ts';
import { createGateReport, plural, type GateFailure } from './lib/report.ts';
import { callSites, declaredBody, functionParts, propertyValue, splitTopLevel, type FunctionParts } from './lib/source.ts';
import { stripComments } from './lib/strip-comments.ts';

export type ElectronSecurityOptions = Omit<ElectronSecurityInput, 'root'> & {
    /** Default: the repo root. */
    root?: string;
};

/** One `v-html` binding someone has vouched for. */
type VHtmlEntry = {
    /** The `.vue` file, relative to the repo root. */
    file: string;
    /** The bound expression exactly as written, e.g. `shape.icon`. */
    binding: string;
    /** Why this string cannot carry untrusted markup. */
    why: string;
};

/** A project helper whose output is safe to assign to `innerHTML`. */
type Sanitizer = {
    /** Called as `name(…)` or `this.name(…)`, e.g. `renderInline`. */
    name: string;
    /** Why its output is escaped. */
    why: string;
};

type ElectronSecurityInput = {
    root: string;
    /** Default `src/main`. */
    mainDir?: string;
    /** Default `src/preload`. */
    preloadDir?: string;
    /** Default `src/renderer`. */
    rendererDir?: string;
    /** Every `v-html` binding the renderer has, with its reason. Default none. */
    vHtml?: VHtmlEntry[];
    /** Helpers beyond `escapeHtml` and `DOMPurify.sanitize`. Default none. */
    sanitizers?: Sanitizer[];
};

type ElectronSecurityInspection = {
    problems: GateFailure[];
    counts: { windows: number; schemes: number; innerHtml: number; vHtml: number; regexps: number };
};

const REQUIRED_PREFS = [
    {
        key: 'contextIsolation',
        value: 'true',
        why: 'It is the barrier between the preload’s scope and the page. Without it, rendered content can reach in and redefine the API the renderer trusts.',
    },
    {
        key: 'nodeIntegration',
        value: 'false',
        why: 'Set true, a window rendering untrusted content gets `require` — and with it the filesystem, child_process and the network.',
    },
    {
        key: 'sandbox',
        value: 'true',
        why: 'Puts the renderer in an OS-level sandbox, so a Chromium RCE still lands somewhere with no filesystem. It needs a CommonJS preload.',
    },
];

const BANNED_PREFS = [
    {
        key: 'webviewTag',
        value: 'true',
        why: '<webview> creates a nested renderer whose webPreferences this configuration does not govern.',
    },
    {
        key: 'allowRunningInsecureContent',
        value: 'true',
        why: 'Permits http subresources inside the app document, which is a downgrade path for everything CSP protects.',
    },
    {
        key: 'experimentalFeatures',
        value: 'true',
        why: 'Enables unshipped Blink features — code paths that have not been through Chromium’s security review.',
    },
    {
        key: 'enableRemoteModule',
        value: 'true',
        why: 'The old `remote` module hands the renderer live main-process objects. Its presence means someone followed a pre-Electron-14 guide.',
    },
    {
        key: 'nodeIntegrationInWorker',
        value: 'true',
        why: 'Grants Node to Web Workers, bypassing the window’s nodeIntegration: false.',
    },
    {
        key: 'nodeIntegrationInSubFrames',
        value: 'true',
        why: 'Grants Node to iframes, which inherit none of the review the top-level frame got.',
    },
    {
        key: 'webSecurity',
        value: 'false',
        why: 'It disables the same-origin policy for the whole window. Local files belong behind a custom protocol, precisely so this never has to be touched.',
    },
];

/** Sanitizers every project may call without naming them. */
const BUILT_IN_SANITIZERS = ['escapeHtml', 'DOMPurify.sanitize'];

/** The metacharacter escape that makes a string safe to embed in a RegExp. */
const REGEX_ESCAPE = /\.replace(?:All)?\(\s*\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g/;

/** A visible http(s) test: `startsWith('https:`, `protocol === 'https:'`, or `/^https?:/`. */
const SCHEME_GUARD = /startsWith\(\s*['"`]https?:|protocol\s*[!=]==?\s*['"`]https?:|\/\^https/;

/** A containment check, recognised by name — see the header. */
const BOUNDARY_CHECK = /\b(?:isInsideBoundary|isInside|withinRoot)\s*\(|path\.relative\(|startsWith\(\s*root\b/;

/** The Electron calls that switch certificate checking off, however they are spelled. */
const TLS_OVERRIDES = [
    /setCertificateVerifyProc/,
    /ignoreCertificateErrors/,
    /['"`]certificate-error['"`]/,
    /ignore-certificate-errors/,
    /NODE_TLS_REJECT_UNAUTHORIZED/,
    /rejectUnauthorized\s*:\s*false/,
];

const lineAt = (code: string, index: number): number => code.slice(0, index).split('\n').length;

/** The offset just inside the innermost function body containing `index` (control blocks walked through); `0` at top level. */
function enclosingFunctionStart(code: string, index: number): number {
    let depth = 0;
    for (let j = index - 1; j >= 0; j--) {
        const ch = code[j];
        if (ch === '}') depth++;
        else if (ch === '{') {
            if (depth > 0) {
                depth--;
                continue;
            }
            const before = code.slice(0, j).trimEnd();
            if (before.endsWith('=>')) return j + 1;
            // A return-type annotation sits between the parameters and the body.
            const typed = /\)\s*:\s*[\w$.<>[\]|&\s,'"]*$/.exec(before);
            const close = typed !== null ? typed.index : before.endsWith(')') ? before.length - 1 : -1;
            if (close === -1) continue;
            let parens = 0;
            let k = close;
            for (; k >= 0; k--) {
                if (before[k] === ')') parens++;
                else if (before[k] === '(' && --parens === 0) break;
            }
            const keyword = /([\w$]+)\s*$/.exec(before.slice(0, Math.max(0, k)))?.[1] ?? '';
            if (!['if', 'for', 'while', 'switch', 'catch', 'with'].includes(keyword)) return j + 1;
        }
    }
    return 0;
}

/**
 * The interpolated expressions of a template literal, `${a} and ${b(c)}` → `['a', 'b(c)']`.
 * @param template The literal including its backticks.
 */
function interpolations(template: string): string[] {
    const found: string[] = [];
    for (let j = 1; j < template.length - 1; j++) {
        if (template[j] === '\\') {
            j++;
            continue;
        }
        if (template[j] !== '$' || template[j + 1] !== '{') continue;
        let depth = 0;
        const start = j + 2;
        for (j += 1; j < template.length; j++) {
            if (template[j] === '{') depth++;
            else if (template[j] === '}' && --depth === 0) break;
        }
        found.push(template.slice(start, j).trim());
    }
    return found;
}

/**
 * The branches of a top-level `a ? b : c`, or `null` when `expr` is not one.
 * `?.` and `??` are not the conditional operator.
 */
function ternaryBranches(expr: string): [string, string] | null {
    const parts = splitTopLevel(
        expr.replace(/\?\?|\?\./g, (m) => (m === '??' ? '\u0001\u0001' : '\u0002.')),
        '?',
    );
    if (parts.length < 2) return null;
    const rest = parts.slice(1).join('?');
    const branches = splitTopLevel(rest, ':');
    if (branches.length !== 2) return null;
    const restore = (s: string) => s.replace(/\u0001\u0001/g, '??').replace(/\u0002\./g, '?.');
    return [restore(branches[0] ?? ''), restore(branches[1] ?? '')];
}

/**
 * The right-hand side of the nearest `const|let|var name =` before `index`.
 *
 * @param constOnly A `let` can be reassigned after the line this reads.
 */
function boundValue(code: string, name: string, index: number, constOnly: boolean): string | null {
    const re = new RegExp(
        String.raw`(?:^|[^\w$.])(${constOnly ? 'const' : 'const|let|var'})\s+${name}\s*(?::[^=]+)?=(?!=)`,
        'g',
    );
    let last = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null && m.index < index) last = m.index + m[0].length;
    if (last === -1) {
        // Declared after the use is still a declaration when it is a module-level const.
        re.lastIndex = 0;
        m = re.exec(code);
        if (m === null) return null;
        last = m.index + m[0].length;
    }
    const tail = code.slice(last);
    const end = statementEnd(tail);
    return tail.slice(0, end).trim();
}

/**
 * Where the statement starting at the beginning of `text` ends: the first `;`
 * at depth zero, or an unmatched closing bracket.
 */
function statementEnd(text: string): number {
    let depth = 0;
    for (let j = 0; j < text.length; j++) {
        const ch = text[j];
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            for (j += 1; j < text.length && text[j] !== quote; j++) if (text[j] === '\\') j++;
            if (quote === '`') {
                // A template may hold `${…}` with its own backticks; re-scan it properly.
                const start = text.lastIndexOf('`', j - 1);
                j = templateEnd(text, start === -1 ? j : start);
            }
        } else if (ch === '(' || ch === '{' || ch === '[') depth++;
        else if (ch === ')' || ch === '}' || ch === ']') {
            if (depth === 0) return j;
            depth--;
        } else if (ch === ';' && depth === 0) return j;
    }
    return text.length;
}

/**
 * @param start Offset of the opening backtick.
 * @returns Offset of the closing backtick.
 */
function templateEnd(text: string, start: number): number {
    for (let j = start + 1; j < text.length; j++) {
        if (text[j] === '\\') j++;
        else if (text[j] === '`') return j;
        else if (text[j] === '$' && text[j + 1] === '{') {
            let depth = 0;
            for (j += 1; j < text.length; j++) {
                if (text[j] === '`') j = templateEnd(text, j);
                else if (text[j] === '{') depth++;
                else if (text[j] === '}' && --depth === 0) break;
            }
        }
    }
    return text.length;
}

function unwrap(expr: string): string {
    let e = expr.trim();
    while (e.startsWith('(') && e.endsWith(')') && splitTopLevel(e.slice(1, -1), ',').length <= 1) {
        const inner = e.slice(1, -1);
        let depth = 0;
        let balanced = true;
        for (const ch of inner) {
            if (ch === '(') depth++;
            else if (ch === ')' && --depth < 0) balanced = false;
        }
        if (!balanced) break;
        e = inner.trim();
    }
    return e;
}

const isStringLiteral = (e: string) => /^(['"])(?:\\.|(?!\1).)*\1$/s.test(e);
const isTemplate = (e: string) => e.startsWith('`') && templateEnd(e, 0) === e.length - 1;
const isIdentifier = (e: string) => /^[A-Za-z_$][\w$]*$/.test(e);

/**
 * The first piece of `expr` that is not known-safe HTML, or `null`. Safe: a string
 * literal, a template of safe parts, a whole-expression sanitizer call, a number, or
 * a `const` in this file bound to something safe.
 *
 * @param seen Names followed on this path: a cycle guard, not a cache.
 */
function unsafeHtml(expr: string, code: string, index: number, sanitizer: RegExp, seen: Set<string>): string | null {
    const e = unwrap(expr);
    if (e === '' || isStringLiteral(e) || /^-?\d/.test(e)) return null;
    const ternary = ternaryBranches(e);
    if (ternary !== null) {
        for (const branch of ternary) {
            const bad = unsafeHtml(branch, code, index, sanitizer, seen);
            if (bad !== null) return bad;
        }
        return null;
    }
    const sum = splitTopLevel(e.replace(/\+\+|\+=/g, '\u0003'), '+');
    if (sum.length > 1) {
        for (const part of sum) {
            const bad = unsafeHtml(part, code, index, sanitizer, seen);
            if (bad !== null) return bad;
        }
        return null;
    }
    if (isTemplate(e)) {
        for (const inner of interpolations(e)) {
            const bad = unsafeHtml(inner, code, index, sanitizer, seen);
            if (bad !== null) return bad;
        }
        return null;
    }
    const call = sanitizer.exec(e);
    if (call !== null && callSites(e, e.slice(0, call[0].length))[0]?.end === e.length - 1) return null;
    if (isIdentifier(e) && !seen.has(e)) {
        const value = boundValue(code, e, index, true);
        if (value !== null) return unsafeHtml(value, code, index, sanitizer, new Set([...seen, e]));
    }
    return e;
}

/**
 * The first piece of a RegExp source that is not a literal or escaped value, or
 * `null`. Escaped: the variable's declaration runs the escape, directly or via a local function.
 */
function unescapedRegex(expr: string, code: string, index: number, seen: Set<string>): string | null {
    const e = unwrap(expr);
    if (e === '' || isStringLiteral(e) || /^\/.+\/[a-z]*$/s.test(e) || /\.source$/.test(e)) return null;
    const sum = splitTopLevel(e, '+');
    if (sum.length > 1) {
        for (const part of sum) {
            const bad = unescapedRegex(part, code, index, seen);
            if (bad !== null) return bad;
        }
        return null;
    }
    if (isTemplate(e)) {
        for (const inner of interpolations(e)) {
            const bad = unescapedRegex(inner, code, index, seen);
            if (bad !== null) return bad;
        }
        return null;
    }
    if (REGEX_ESCAPE.test(e)) return null;
    const helper = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e)?.[1];
    if (helper !== undefined && REGEX_ESCAPE.test(declaredBody(code, helper))) return null;
    if (isIdentifier(e) && !seen.has(e)) {
        const value = boundValue(code, e, index, false);
        if (value !== null) return unescapedRegex(value, code, index, new Set([...seen, e]));
    }
    return e;
}

/**
 * The handler function passed as the argument after a leading channel/event
 * string, e.g. the arrow in `on('will-navigate', (event, url) => {…})`.
 */
function handlerAfterName(args: string): FunctionParts | null {
    const parts = splitTopLevel(args, ',');
    const fn = parts.slice(1).join(', ');
    return functionParts(fn);
}

export function inspectElectronSecurity({
    root,
    mainDir = 'src/main',
    preloadDir = 'src/preload',
    rendererDir = 'src/renderer',
    vHtml = [],
    sanitizers = [],
}: ElectronSecurityInput): ElectronSecurityInspection {
    const problems: GateFailure[] = [];
    const fail: (file: string, what: string, why: string) => void = (file, what, why) =>
        problems.push({ file, what, why });

    const exists = (dir: string) => fs.existsSync(path.join(root, dir));
    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

    if (!exists(mainDir)) {
        fail(mainDir, 'does not exist', 'This gate reads the main process from here. Point `mainDir` at it.');
        return { problems, counts: { windows: 0, schemes: 0, innerHtml: 0, vHtml: 0, regexps: 0 } };
    }

    // Test files never ship, and a test is where `new RegExp(input)` belongs.
    const exclude = /(?:^|\/)__tests__\/|\.(?:test|spec)\.[cm]?ts$/;
    const mainFiles = walkFiles(root, mainDir, { match: /\.[cm]?ts$/, exclude });
    const preloadFiles = walkFiles(root, preloadDir, { match: /\.[cm]?ts$/, exclude });
    const rendererFiles = walkFiles(root, rendererDir, { match: /\.(?:[cm]?ts|vue)$/, exclude });
    const strip = (rel: string) => stripComments(read(rel));
    const main = mainFiles.map((rel) => [rel, strip(rel)] as [string, string]);

    /** Every `token(` call across the main process, with the file it is in. */
    const sitesIn = (token: string) =>
        main.flatMap(([rel, code]) => callSites(code, token).map((site) => ({ rel, code, ...site })));
    const where = (s: { rel: string; code: string; index: number }) => `${s.rel}:${lineAt(s.code, s.index)}`;

    // ── 1/2/3. webPreferences on every BrowserWindow ─────────────────────────
    const windows = sitesIn('new BrowserWindow(');
    if (windows.length === 0) {
        fail(
            mainDir,
            'no `new BrowserWindow({...})` call found',
            'This gate reads its webPreferences. If the window is constructed some other way, the gate has to learn it — do not leave it reading nothing.',
        );
    }
    for (const window of windows) {
        const options = window.args.trim();
        if (!options.startsWith('{')) {
            fail(
                where(window),
                'passes its options as a variable, so its webPreferences cannot be read',
                'Write the options object inline. A window whose preferences come from elsewhere is the one nobody checks.',
            );
            continue;
        }
        const prefs = propertyValue(options.slice(1, -1), 'webPreferences')?.trim() ?? null;
        if (prefs !== null && !prefs.startsWith('{')) {
            fail(
                where(window),
                'passes webPreferences as a variable, so they cannot be read',
                'Write webPreferences inline in the window options, where review and this gate both see them.',
            );
            continue;
        }
        const body = prefs === null ? '' : prefs.slice(1, -1);
        for (const { key, value, why } of REQUIRED_PREFS) {
            const actual = propertyValue(body, key)?.trim() ?? null;
            if (actual === value) continue;
            fail(
                where(window),
                actual === null
                    ? `webPreferences is missing \`${key}: ${value}\``
                    : `webPreferences sets \`${key}: ${actual}\`, not \`${value}\``,
                why,
            );
        }
        for (const { key, value, why } of BANNED_PREFS) {
            if (propertyValue(body, key)?.trim() === value) {
                fail(where(window), `webPreferences sets \`${key}: ${value}\``, why);
            }
        }
        if (propertyValue(body, 'preload') === null) {
            fail(
                where(window),
                'declares no `preload`',
                'A window with no preload has no vetted API surface, and it inherits none of the review the main window got.',
            );
        }
    }

    // ── 4/5/6. Navigation containment ────────────────────────────────────────
    const openHandlers = sitesIn('setWindowOpenHandler(');
    if (openHandlers.length === 0) {
        fail(
            mainDir,
            'registers no `setWindowOpenHandler`',
            'Without it `target="_blank"` or `window.open` opens a real Electron window on a remote origin, with webPreferences nothing here configured.',
        );
    }
    for (const site of openHandlers) {
        const handler = functionParts(site.args);
        const body = handler?.body ?? '';
        const denies =
            /return\s*\{\s*action\s*:\s*['"]deny['"]\s*,?\s*\}/.test(body) ||
            /^\(?\s*\{\s*action\s*:\s*['"]deny['"]\s*,?\s*\}\s*\)?$/.test(body.trim());
        if (!denies || /action\s*:\s*['"]allow['"]/.test(body)) {
            fail(
                where(site),
                /action\s*:\s*['"]allow['"]/.test(body)
                    ? "setWindowOpenHandler returns `action: 'allow'`"
                    : "setWindowOpenHandler does not return `action: 'deny'`",
                'Anything but deny creates a window whose webPreferences this file did not configure. External links belong in the OS browser via shell.openExternal.',
            );
        }
    }

    const listeners = sitesIn('.on(');
    const navigations = listeners.filter((s) => /^\s*['"]will-navigate['"]/.test(s.args));
    if (navigations.length === 0) {
        fail(
            mainDir,
            'has no `will-navigate` handler',
            'A link that navigates the app window away replaces the app with a remote page in a process that still has the preload bridge attached.',
        );
    }
    for (const site of navigations) {
        const handler = handlerAfterName(site.args);
        const event = handler?.params[0] ?? '';
        if (event === '' || !new RegExp(String.raw`\b${event}\.preventDefault\(\)`).test(handler?.body ?? '')) {
            fail(
                where(site),
                'the `will-navigate` handler never calls `preventDefault()` on its event',
                'Observing a navigation without cancelling it lets it proceed. The handler reads like a guard and stops nothing.',
            );
        }
    }
    for (const site of listeners.filter((s) => /^\s*['"]new-window['"]/.test(s.args))) {
        fail(
            where(site),
            "registers a 'new-window' handler",
            'That event was removed in Electron 22 — the handler never runs. It is dead code shaped like a security control, which stops review looking for the real one (setWindowOpenHandler).',
        );
    }

    // ── 7. Permission handlers, each with a deny path ────────────────────────
    for (const [name, why, denies] of [
        [
            'setPermissionRequestHandler',
            'Handles a live permission request. Over file:// Electron denies everything by default and a dev server on http://localhost does not, so the two builds disagree until the policy is written down — and once one permission is granted, this handler is the entire policy.',
            (fn: FunctionParts) =>
                fn.params[2] !== undefined && new RegExp(String.raw`\b${fn.params[2]}\(\s*false\s*\)`).test(fn.body),
        ],
        [
            'setPermissionCheckHandler',
            'Answers `navigator.permissions.query`. Without it a renderer can be told it holds a permission the request handler would refuse, and the two answers disagree.',
            (fn: FunctionParts) => /\breturn\s+false\b/.test(fn.body) || fn.body.trim() === 'false',
        ],
    ] as const) {
        const sites = sitesIn(`${name}(`);
        if (sites.length === 0) {
            fail(mainDir, `registers no \`${name}\``, why);
            continue;
        }
        for (const site of sites) {
            const handler = functionParts(site.args);
            if (handler === null || !denies(handler)) {
                fail(
                    where(site),
                    `\`${name}\` has no deny path`,
                    'A permission handler must be an allowlist: name the one permission you grant and refuse the rest. With no deny branch it grants everything it was added to restrict — and `null` restores the default this handler was written to replace.',
                );
            }
        }
    }

    // ── 8/9. Custom protocols ────────────────────────────────────────────────
    const schemes = sitesIn('protocol.handle(');
    for (const site of schemes) {
        const scheme = /^\s*['"`]([^'"`]+)['"`]/.exec(site.args)?.[1] ?? '?';
        const body = handlerAfterName(site.args)?.body ?? '';
        if (!BOUNDARY_CHECK.test(body)) {
            fail(
                where(site),
                `the \`${scheme}://\` handler does not check that the path is inside its root`,
                'It is a file-read primitive any renderer script can call. Without containment it serves any path on the disk, and `..` in the URL is the whole exploit.',
            );
        }
        if (!/status\s*:\s*403\b/.test(body)) {
            fail(
                where(site),
                `the \`${scheme}://\` handler never returns 403`,
                'A denied read has to be a refusal. Falling through to a normal fetch turns the containment check into a comment.',
            );
        }
    }
    for (const [rel, code] of main) {
        for (const m of code.matchAll(/\b(?:register|intercept)(?:File|Buffer|String|Stream|Http)Protocol\(/g)) {
            fail(
                `${rel}:${lineAt(code, m.index)}`,
                `uses the deprecated \`${m[0].slice(0, -1)}\``,
                'Replaced by protocol.handle in Electron 25. This gate checks the containment of protocol.handle handlers only, so a handler registered this way is one nothing reads.',
            );
        }
    }
    for (const site of sitesIn('registerSchemesAsPrivileged(')) {
        if (/\bbypassCSP\s*:\s*true\b/.test(site.args)) {
            fail(
                where(site),
                'a privileged scheme sets `bypassCSP: true`',
                'Every resource loaded through that scheme would then be exempt from the policy in index.html — which is the only CSP a file:// renderer has.',
            );
        }
    }

    // ── 10. shell.openExternal is scheme-guarded ─────────────────────────────
    for (const site of sitesIn('shell.openExternal(')) {
        const arg = site.args.trim();
        if (/^['"`]https:\/\//.test(arg)) continue;
        const guard = site.code.slice(enclosingFunctionStart(site.code, site.index), site.index);
        if (!SCHEME_GUARD.test(guard)) {
            fail(
                where(site),
                `calls shell.openExternal(${arg.slice(0, 30)}) with no http/https check before it in the same function`,
                'openExternal hands the string to the OS. A `file://` or `smb://` URL from app content becomes local execution reached by clicking a link.',
            );
        }
    }

    // ── 11. HTML sinks in the renderer ───────────────────────────────────────
    const sanitizerNames = [...BUILT_IN_SANITIZERS, ...sanitizers.map((s) => s.name)];
    const sanitizer = new RegExp(
        String.raw`^(?:this\.)?(?:${sanitizerNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\s*\(`,
    );
    for (const { name, why } of sanitizers) {
        if (typeof why !== 'string' || why.trim() === '') {
            fail(
                '(gate options)',
                `sanitizer \`${name}\` has no \`why\``,
                'Naming a function safe is a claim about what it does. Write down why it escapes.',
            );
        }
    }
    let innerHtmlCount = 0;
    let regexCount = 0;
    const sourceFiles = [...mainFiles, ...preloadFiles, ...rendererFiles];
    const code = new Map(sourceFiles.map((rel) => [rel, strip(rel)]));

    for (const rel of rendererFiles) {
        const text = code.get(rel) ?? '';
        for (const m of text.matchAll(
            /\bdocument\.write(?:ln)?\s*\(|\.outerHTML\s*\+?=(?!=)|\.insertAdjacentHTML\s*\(/g,
        )) {
            fail(
                `${rel}:${lineAt(text, m.index)}`,
                `uses \`${m[0]
                    .replace(/\s*\($/, '')
                    .replace(/\s*\+?=$/, ' =')
                    .replace(/^\./, '')}\``,
                'Parses its argument as HTML with no escaping stage. Build the node and set textContent, or route the string through a sanitizer.',
            );
        }
        for (const m of text.matchAll(/\.innerHTML\s*\+?=(?!=)\s*/g)) {
            innerHtmlCount++;
            const rest = text.slice(m.index + m[0].length);
            const value = rest.slice(0, statementEnd(rest));
            const bad = unsafeHtml(value, text, m.index, sanitizer, new Set());
            if (bad !== null) {
                fail(
                    `${rel}:${lineAt(text, m.index)}`,
                    `assigns \`${bad.replace(/\s+/g, ' ').slice(0, 40)}\` to innerHTML without escaping`,
                    'Only literals, constants bound to literals and sanitizer output may reach innerHTML. Wrap the value in escapeHtml() — or name the helper in `sanitizers` with the reason it is safe.',
                );
            }
        }
    }

    // ── 12. v-html bindings ──────────────────────────────────────────────────
    /** file → bindings found */
    const bindings = new Map();
    let vHtmlCount = 0;
    for (const rel of rendererFiles.filter((f) => f.endsWith('.vue'))) {
        const source = read(rel).replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
        const found: string[] = [];
        for (const m of source.matchAll(
            /(?:\bv-html|(?:\bv-bind)?:inner-?[hH][tT][mM][lL])\s*=\s*(["'])([\s\S]*?)\1/g,
        )) {
            const binding = (m[2] ?? '').trim();
            found.push(binding);
            vHtmlCount++;
            if (!vHtml.some((entry) => entry.file === rel && entry.binding === binding)) {
                fail(
                    `${rel}:${lineAt(source, m.index)}`,
                    `binds \`${binding.slice(0, 40)}\` with v-html, and no entry vouches for it`,
                    'v-html bypasses Vue’s escaping entirely. Whether that is safe depends on where the string came from, so name the file and the binding in `vHtml`, with the reason it cannot carry untrusted markup.',
                );
            }
        }
        bindings.set(rel, found);
    }
    for (const entry of vHtml) {
        if (typeof entry.why !== 'string' || entry.why.trim() === '') {
            fail(
                entry.file,
                `the v-html entry for \`${entry.binding}\` has no \`why\``,
                'The entry IS the review. Without the reason it is just a mute button.',
            );
        }
        if (!(bindings.get(entry.file) ?? []).includes(entry.binding)) {
            fail(
                entry.file,
                `is listed in \`vHtml\` for \`${entry.binding}\`, which it no longer binds`,
                'Drop the entry. A stale exemption is one that silently covers the next binding someone adds.',
            );
        }
    }

    // ── 13. RegExp built from input ──────────────────────────────────────────
    for (const rel of sourceFiles) {
        const text = code.get(rel) ?? '';
        for (const site of callSites(text, 'new RegExp(')) {
            regexCount++;
            const source = splitTopLevel(site.args, ',')[0] ?? '';
            const bad = unescapedRegex(source, text, site.index, new Set());
            if (bad !== null) {
                fail(
                    `${rel}:${lineAt(text, site.index)}`,
                    `builds a RegExp from \`${bad.slice(0, 30)}\` with no metacharacter escape`,
                    "A name containing `(` throws at runtime; one containing `(a+)+` is a ReDoS that hangs the process. Escape it where it is declared: `.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')`.",
                );
            }
        }
    }

    // ── 14. TLS / certificate overrides ──────────────────────────────────────
    for (const rel of [...mainFiles, ...preloadFiles]) {
        const text = code.get(rel) ?? '';
        for (const pattern of TLS_OVERRIDES) {
            for (const m of text.matchAll(new RegExp(pattern.source, 'g'))) {
                fail(
                    `${rel}:${lineAt(text, m.index)}`,
                    `uses \`${m[0]}\``,
                    'A certificate override switches off the one check that tells the real server from an impostor. There is no certificate here worth overriding; its appearance means something started talking to a server and a check got in the way.',
                );
            }
        }
    }

    return {
        problems,
        counts: {
            windows: windows.length,
            schemes: schemes.length,
            innerHtml: innerHtmlCount,
            vHtml: vHtmlCount,
            regexps: regexCount,
        },
    };
}

export function checkElectronSecurity({ root = REPO_ROOT, ...rest }: ElectronSecurityOptions): void {
    const report = createGateReport({ name: 'Electron security' });
    const { problems, counts } = inspectElectronSecurity({ root, ...rest });

    for (const { file, what, why } of problems) report.fail(file, what, why);

    report.done({
        summary:
            `Electron security OK — ${plural(counts.windows, 'window')} with the process-model invariants and a preload, ` +
            `navigation contained, both permission handlers denying by default, ${plural(counts.schemes, 'custom scheme')} bounded, ` +
            `${plural(counts.innerHtml, 'innerHTML assignment')} escaped, ${plural(counts.vHtml, 'v-html binding')} vouched for, ` +
            `${plural(counts.regexps, 'RegExp')} built from literals or escaped input.`,
        notMachineChecked:
            'Whether a v-html or sanitizer reason is still true, whether a permission allowlist grants the right permission, whether a guard before openExternal covers the path the call actually takes, whether a boundary check is correct (its unit tests own that), and anything only observable at runtime — a window a library opens, or a navigation Chromium starts itself.',
    });
}
