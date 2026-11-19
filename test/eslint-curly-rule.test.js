/**
 * `larry/curly-exit-only`, run through ESLint's RuleTester. The valid cases are the guards a
 * project writes; the invalid ones are each body that does work, and the exits that left
 * their `if` line.
 */
import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import ts from 'typescript-eslint';

import { curlyRules } from '../src/eslint/rules/curly-exit-only.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: ts.parser } });
const braces = { messageId: 'braces' };

tester.run('curly-exit-only', curlyRules['curly-exit-only'], {
    valid: [
        'function f(a) { if (a === null) return; }',
        'function f(a) { if (a === null) return 0; }',
        "function f(a) { if (a === null) throw new Error('missing'); }",
        'for (const a of list) { if (a < 0) continue; }',
        'for (const a of list) { if (a < 0) break; }',
        // A condition that wraps still ends on the line of its exit.
        'function f(a, b) { if (\n    a !== null &&\n    b !== null\n) return a; }',
        // A guard chain: each `else if` is an `if` of its own.
        'function f(a) { if (a === 1) return 1; else if (a === 2) return 2; }',
        'if (a) { work(); }',
        'if (a) { work(); } else { other(); }',
        'if (a) { work(); } else if (b) { other(); }',
        'for (const a of list) { work(a); }',
        'while (a) { a -= 1; }',
        'do { a -= 1; } while (a);',
    ],
    invalid: [
        { code: 'if (a) work();', output: 'if (a) { work(); }', errors: [braces] },
        { code: 'for (const a of list) work(a);', output: 'for (const a of list) { work(a); }', errors: [braces] },
        { code: 'for (const k in o) work(k);', output: 'for (const k in o) { work(k); }', errors: [braces] },
        {
            code: 'for (let i = 0; i < n; i++) work(i);',
            output: 'for (let i = 0; i < n; i++) { work(i); }',
            errors: [braces],
        },
        { code: 'while (a) a -= 1;', output: 'while (a) { a -= 1; }', errors: [braces] },
        { code: 'do a -= 1; while (a);', output: 'do { a -= 1; } while (a);', errors: [braces] },
        // An exit on a line of its own has left the guard shape Prettier gives a one-line `if`.
        {
            code: 'function f(a) { if (a)\n    return 1; }',
            output: 'function f(a) { if (a)\n    { return 1; } }',
            errors: [braces],
        },
        {
            code: "function f(a) { if (a) throw new Error(\n    'missing',\n); }",
            output: "function f(a) { if (a) { throw new Error(\n    'missing',\n); } }",
            errors: [braces],
        },
        // An `else` body is never a guard, even when it exits; the `if` beside it still is.
        {
            code: 'function f(a) { if (a) return 1; else return 2; }',
            output: 'function f(a) { if (a) return 1; else { return 2; } }',
            errors: [braces],
        },
        {
            code: 'if (a) work(); else other();',
            output: 'if (a) { work(); } else { other(); }',
            errors: [braces, braces],
        },
        // An exit only goes bare as an `if` body: in a loop it is still the loop's whole body.
        { code: 'for (const a of list) continue;', output: 'for (const a of list) { continue; }', errors: [braces] },
        // The dangling `else` stays with the inner `if`: the outer braces go round both, and the
        // inner bodies' fixes overlap them, so they wait for ESLint's next pass.
        {
            code: 'if (a) if (b) work(); else other();',
            output: 'if (a) { if (b) work(); else other(); }',
            errors: [braces, braces, braces],
        },
    ],
});
