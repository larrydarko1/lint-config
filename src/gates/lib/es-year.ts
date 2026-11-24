/**
 * The one ES year, and the oldest browsers that run all of it. `tsconfigs` holds every
 * project (its rule 4) and every Vite build (its rule 10) to them.
 */
import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';

import { isRecord, stringsAt } from './json.ts';
import type { CompilerOptions } from './tsconfig-json.ts';

type Fail = (file: string, what: string, why: string) => void;

/**
 * The one ES year for every project: the newest that every runtime the families ship to
 * runs in full (Node 24 and up, Electron's Chromium, the VS Code extension host, and the
 * `BROWSER_FLOOR`). It moves in a release of this package, never per project.
 */
export const ES_YEAR = 'ES2025';

/**
 * The oldest browsers a Vite build supports: the first release of each that runs all of
 * `ES_YEAR`. Safari 26 is the first with RegExp modifiers, Chrome 136 and Firefox 134 the
 * first with `RegExp.escape`. A bundler lowers syntax but never adds a built-in or a regex
 * feature, so a browser below this fails at runtime on code that compiled. Moves with the year.
 */
const BROWSER_FLOOR: string[] = [
    'chrome >= 136',
    'edge >= 136',
    'firefox >= 134',
    'safari >= 26',
    'ios_saf >= 26',
    'and_chr >= 136',
    'and_ff >= 134',
];

/** A Vite config. `electron.vite.config.*` is not one: electron-vite targets the Electron it builds for. */
export const VITE_CONFIG = /^vite\.config\.[cm]?[jt]s$/;

/**
 * A project's `target` and `lib`, read down the repo's own `extends` chain only: a
 * published preset's year moves on its upgrade, with nothing in the repo changing.
 * @param options The project's compilerOptions merged down its local `extends` chain.
 */
export function checkProjectYear(rel: string, options: CompilerOptions | undefined, fail: Fail): void {
    const target = options?.['target'];
    const libs = options?.['lib'] === undefined ? undefined : stringsAt(options, 'lib');

    for (const [setting, value] of [
        ['target', target],
        ['lib', libs],
    ] as const) {
        if (value !== undefined) continue;
        fail(
            rel,
            `does not set \`${setting}\``,
            `Unset here, the ES year comes from a published preset (\`@vue/tsconfig\` types ES2022) or from tsc's default, and moves when either is upgraded, with nothing in this repo changing. Set \`"target": "${ES_YEAR}"\` and a \`lib\` that starts with "${ES_YEAR}".`,
        );
    }
    if (target !== undefined && (typeof target !== 'string' || target.toLowerCase() !== ES_YEAR.toLowerCase())) {
        fail(
            rel,
            `targets ${typeof target === 'string' ? target : JSON.stringify(target)}, not ${ES_YEAR}`,
            'Every project is on one ES year, the newest every runtime here runs in full: Node 24 and up, Electron, the VS Code extension host, and the browser floor (Safari 26, Chrome 136, Firefox 134). An earlier year is drift; a later one emits syntax a runtime cannot parse.',
        );
    }
    if (libs !== undefined && libs[0]?.toLowerCase() !== ES_YEAR.toLowerCase()) {
        fail(
            rel,
            `has a lib starting at ${libs[0] ?? 'nothing'}, not ${ES_YEAR}`,
            'The first lib entry is the ES year: it decides which built-ins compile. A bundler lowers new syntax but never adds a built-in, so a lib behind the year refuses methods every runtime has, and one ahead of it lets through calls that throw `… is not a function` on the floor.',
        );
    }
    const ahead = libs?.find((entry) => yearOf(entry) > yearOf(ES_YEAR));
    if (ahead !== undefined) {
        fail(
            rel,
            `has the lib entry ${ahead}, past ${ES_YEAR}`,
            'It types built-ins from after the year, which the oldest runtime here does not have: the call compiles and throws at runtime. They become usable when the year moves, for every project at once.',
        );
    }
}

/**
 * A Vite build's `build.target` and `oxc.target` are the year, and the package.json nearest
 * above it declares the browser floor.
 * @param root Repository root.
 * @param rel The Vite config, by path from the root.
 */
export function checkViteBuild(root: string, rel: string, fail: Fail): void {
    const year = ES_YEAR.toLowerCase();
    const config = configObject(ts.createSourceFile(rel, read(root, rel), ts.ScriptTarget.Latest, true));
    if (config === undefined) {
        fail(
            rel,
            'exports no config object the gate can read',
            'It reads `export default defineConfig({ … })`, a function returning that object, or a variable holding it. Without one, nothing here can say what the build targets.',
        );
        return;
    }

    const build = objectAt(config, 'build');
    const buildTarget = build === undefined ? undefined : propertyAt(build, 'target');
    if (buildTarget === undefined) {
        fail(
            rel,
            'does not set `build.target`',
            `Vite's default is the browsers widely available when that Vite release was cut, so the syntax the app ships changes on a Vite upgrade, whatever the year the code is typed at. Set \`build: { target: '${year}' }\`.`,
        );
    } else if (!isString(buildTarget, year)) {
        fail(
            rel,
            `sets \`build.target\` to ${buildTarget.getText()}, not '${year}'`,
            `tsconfig types the code at ${ES_YEAR}, and every browser at the floor runs all of it. A lower target ships larger code for browsers that fail on the first ${ES_YEAR} built-in anyway; a higher one ships syntax a floor browser cannot parse.`,
        );
    }
    const oxc = objectAt(config, 'oxc');
    const oxcTarget = oxc === undefined ? undefined : propertyAt(oxc, 'target');
    if (oxcTarget !== undefined && !isString(oxcTarget, year)) {
        fail(
            rel,
            `sets \`oxc.target\` to ${oxcTarget.getText()}, not '${year}'`,
            'Vite transforms each module to `oxc.target` and the bundle to `build.target`, so two values are two answers to which syntax ships, and the dev server runs the first. Set both to the year, or leave `oxc.target` out.',
        );
    }

    const manifest = nearestManifest(root, path.posix.dirname(rel));
    const json: unknown = JSON.parse(read(root, manifest));
    const declared = isRecord(json) ? json['browserslist'] : undefined;
    const floor = JSON.stringify(BROWSER_FLOOR);
    if (declared === undefined) {
        fail(
            manifest,
            `declares no \`browserslist\` for the build in ${rel}`,
            `It is where the browser floor is written down: autoprefixer and any other CSS tool read it, and so does a reader asking which browsers the app supports. Set it to ${floor}.`,
        );
    } else if (JSON.stringify(declared) !== floor) {
        fail(
            manifest,
            `declares \`browserslist\` ${JSON.stringify(declared)}, not the floor`,
            `The floor is the first release of each browser that runs all of ${ES_YEAR}, so it moves with the year, in a release of this package, never per project. Set it to ${floor}.`,
        );
    }
}

/** The year a lib entry belongs to: `ES2023.Array` is 2023, `ESNext` is after every year, `DOM` before. */
function yearOf(lib: string): number {
    if (/^esnext(?:\.|$)/i.test(lib)) return Infinity;
    const year = /^es(\d{4})(?:\.|$)/i.exec(lib)?.[1];
    return year === undefined ? -Infinity : Number(year);
}

/**
 * The object a Vite config exports: `export default` an object, `defineConfig(…)` of one, a
 * function returning one, or a variable holding any of those.
 */
function configObject(source: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
    const exported = source.statements.find(ts.isExportAssignment)?.expression;
    return exported === undefined ? undefined : unwrap(exported);

    function unwrap(node: ts.Expression): ts.ObjectLiteralExpression | undefined {
        let expr = node;
        while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) {
            expr = expr.expression;
        }
        if (ts.isObjectLiteralExpression(expr)) return expr;
        if (ts.isCallExpression(expr)) return expr.arguments[0] === undefined ? undefined : unwrap(expr.arguments[0]);
        if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
            if (!ts.isBlock(expr.body)) return unwrap(expr.body);
            const returned = expr.body.statements.filter(ts.isReturnStatement).at(-1)?.expression;
            return returned === undefined ? undefined : unwrap(returned);
        }
        if (ts.isIdentifier(expr)) {
            const declared = source.statements
                .filter(ts.isVariableStatement)
                .flatMap((statement) => [...statement.declarationList.declarations])
                .find((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === expr.text);
            return declared?.initializer === undefined ? undefined : unwrap(declared.initializer);
        }
        return undefined;
    }
}

/** The value of `key` in an object literal, by its real property, not by text. */
function propertyAt(object: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined {
    const property = object.properties.find(
        (p): p is ts.PropertyAssignment =>
            ts.isPropertyAssignment(p) &&
            (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
            p.name.text === key,
    );
    return property?.initializer;
}

/** The object literal under `key`, if that is what the property holds. */
function objectAt(object: ts.ObjectLiteralExpression, key: string): ts.ObjectLiteralExpression | undefined {
    const value = propertyAt(object, key);
    return value !== undefined && ts.isObjectLiteralExpression(value) ? value : undefined;
}

function isString(node: ts.Expression, text: string): boolean {
    return ts.isStringLiteralLike(node) && node.text === text;
}

/** The package.json nearest above `dir`, the one a CSS tool reads `browserslist` from. */
function nearestManifest(root: string, dir: string): string {
    for (let at = dir; ; at = path.posix.dirname(at)) {
        const manifest = at === '.' ? 'package.json' : `${at}/package.json`;
        if (at === '.' || fs.existsSync(path.join(root, manifest))) return manifest;
    }
}

function read(root: string, rel: string): string {
    return fs.readFileSync(path.join(root, rel), 'utf8');
}
