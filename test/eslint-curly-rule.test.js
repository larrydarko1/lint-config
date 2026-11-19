/**
 * `larry/curly-inline`, run through ESLint's RuleTester. The valid cases are the two shapes a body
 * may take; the invalid ones are each way of being in the other shape, and the edge of the width.
 */
import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import ts from 'typescript-eslint';

import { curlyRules } from '../src/eslint/rules/curly-inline.ts';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: ts.parser } });
const inline = { messageId: 'inline' };
const braces = { messageId: 'braces' };

/** A call statement exactly `width` columns long. */
const call = (width) => `work('${'x'.repeat(width - 9)}');`;

tester.run('curly-inline', curlyRules['curly-inline'], {
    valid: [
        'if (a) return;',
        "if (a) throw new Error('missing');",
        'if (a) work();',
        'for (const a of list) work(a);',
        'for (const k in o) work(k);',
        'for (let i = 0; i < n; i++) work(i);',
        'while (a) a -= 1;',
        'if (a) work();\nelse other();',
        'if (a) one();\nelse if (b) two();\nelse three();',
        // `if (a) ` is 7 columns, so this line ends at Prettier's width exactly.
        `if (a) ${call(113)}`,
        `if (a) {\n    ${call(114)}\n}`,
        // Prettier prints `else if (b) ` (12 columns) and `else ` (5) at the start of their lines.
        `if (a) one();\nelse if (b) ${call(108)}`,
        `if (a) one();\nelse ${call(115)}`,
        'if (a) {\n    one();\n    two();\n}',
        'if (a) {\n    work(\n        1,\n    );\n}',
        'if (\n    a &&\n    b\n) {\n    work();\n}',
        'for (const a of list) {\n    if (a) work(a);\n}',
        'if (a) {\n    // Why it runs.\n    work();\n}',
        'if (a) {\n    const b = 1;\n}',
        'do {\n    a -= 1;\n} while (a);',
        // One branch needs braces, so the other keeps them.
        'if (a) {\n    work();\n} else {\n    one();\n    two();\n}',
        // Without the braces, the `else` would belong to the inner `if`.
        'if (a) {\n    if (b) work();\n} else {\n    other();\n}',
    ],
    invalid: [
        { code: 'if (a) {\n    work();\n}', output: 'if (a) work();', errors: [inline] },
        {
            code: 'for (const a of list) {\n    work(a);\n}',
            output: 'for (const a of list) work(a);',
            errors: [inline],
        },
        { code: 'while (a) {\n    a -= 1;\n}', output: 'while (a) a -= 1;', errors: [inline] },
        {
            code: 'if (a) {\n    one();\n} else if (b) {\n    two();\n} else {\n    three();\n}',
            output: 'if (a) one(); else if (b) two(); else three();',
            errors: [inline, inline, inline],
        },
        { code: `if (a) {\n    ${call(113)}\n}`, output: `if (a) ${call(113)}`, errors: [inline] },
        { code: `if (a)\n    ${call(114)}`, output: `if (a)\n    { ${call(114)} }`, errors: [braces] },
        {
            code: `if (a) one();\nelse if (b) ${call(109)}`,
            output: `if (a) { one(); }\nelse if (b) { ${call(109)} }`,
            errors: [braces, braces],
        },
        {
            code: `if (a) one();\nelse ${call(116)}`,
            output: `if (a) { one(); }\nelse { ${call(116)} }`,
            errors: [braces, braces],
        },
        // Indentation counts towards the width.
        {
            code: `function f() {\n    if (a) ${call(110)}\n}`,
            output: `function f() {\n    if (a) { ${call(110)} }\n}`,
            errors: [braces],
        },
        // Prettier counts a wide character as two columns: this line is 68 characters and 121 columns.
        {
            code: `if (a) log('${'界'.repeat(53)}');`,
            output: `if (a) { log('${'界'.repeat(53)}'); }`,
            errors: [braces],
        },
        {
            code: 'if (a)\n    work(\n        1,\n    );',
            output: 'if (a)\n    { work(\n        1,\n    ); }',
            errors: [braces],
        },
        {
            code: 'if (\n    a &&\n    b\n)\n    work();',
            output: 'if (\n    a &&\n    b\n)\n    { work(); }',
            errors: [braces],
        },
        {
            code: 'for (const a of list) if (a) work(a);',
            output: 'for (const a of list) { if (a) work(a); }',
            errors: [braces],
        },
        { code: 'do a -= 1;\nwhile (a);', output: 'do { a -= 1; }\nwhile (a);', errors: [braces] },
        {
            code: 'if (a) work();\nelse {\n    one();\n    two();\n}',
            output: 'if (a) { work(); }\nelse {\n    one();\n    two();\n}',
            errors: [braces],
        },
        {
            code: 'if (a) {\n    if (b) work();\n} else other();',
            output: 'if (a) {\n    if (b) work();\n} else { other(); }',
            errors: [braces],
        },
    ],
});
