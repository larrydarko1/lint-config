/**
 * The dead-code gate, against crafted knip reports.
 * - knip itself is not under test here — it is a well-tested binary, and pointing it
 * at a fixture repository would test its resolution rather than this gate's rules.
 * What IS this gate is everything around the run: how a report is flattened, how the
 * two passes are combined, and which categories are counted. Those are the parts
 * that drifted between the five copies, so those are the parts with tests.
 * - The pass tests are the ones worth reading. The second pass exists because
 * knip's default graph counts a test file as a consumer, so an export that only its
 * own test imports looks alive — and it is subtracted from the first pass so one
 * dead export is not reported twice under two different names.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    CATEGORIES,
    LOCAL_ONLY_TYPES,
    TEST_ONLY,
    collectHits,
    deadCodeProblems,
    deadCodeSummary,
    inspectDeadCode,
} from '../src/gates/dead-code.ts';

/** A knip JSON report with the given per-file issue buckets. */
const report = (...issues) => ({ issues });

const names = (hits) => hits.map((h) => `${h.file}:${h.line ?? '-'} ${h.name}`);

// ── collectHits: flattening one report ──────────────────────────────────────
test('an empty report yields an empty bucket for every requested category', () => {
    assert.deepEqual(collectHits(report(), ['exports', 'types']), { exports: [], types: [] });
});

test('a report with no issues key at all is not an error', () => {
    assert.deepEqual(collectHits({}, ['exports']), { exports: [] });
});

test('an export is flattened to file, name and line', () => {
    const found = collectHits(report({ file: 'src/a.ts', exports: [{ name: 'helper', line: 12 }] }), ['exports']);
    assert.deepEqual(names(found.exports), ['src/a.ts:12 helper']);
});

test('a missing line is carried through as undefined', () => {
    const found = collectHits(report({ file: 'src/a.ts', exports: [{ name: 'helper' }] }), ['exports']);
    assert.equal(found.exports[0]?.line, undefined);
});

test('a duplicates finding is an array of the names one symbol is exported under', () => {
    const issue = {
        file: 'src/a.ts',
        duplicates: [
            [
                { name: 'send', line: 3 },
                { name: 'dispatch', line: 9 },
            ],
        ],
    };
    const found = collectHits(report(issue), ['duplicates']);
    assert.deepEqual(names(found.duplicates), ['src/a.ts:3 send = dispatch']);
});

test('a cycle is the loop in import order, closed back on the file it starts from', () => {
    const issue = {
        file: 'src/a.ts',
        cycles: [
            [
                { name: 'src/a.ts', line: 4 },
                { name: 'src/b.ts', line: 15 },
            ],
        ],
    };
    const found = collectHits(report(issue), ['cycles']);
    assert.deepEqual(names(found.cycles), ['src/a.ts:4 src/a.ts → src/b.ts → src/a.ts']);
});

test('a category not asked for is not collected', () => {
    const issue = { file: 'src/a.ts', exports: [{ name: 'a' }], types: [{ name: 'B' }] };
    const found = collectHits(report(issue), ['exports']);
    assert.deepEqual(Object.keys(found), ['exports']);
});

test('a category knip did not report is still an empty bucket', () => {
    const found = collectHits(report({ file: 'src/a.ts', exports: [{ name: 'a' }] }), ['exports', 'enumMembers']);
    assert.deepEqual(found.enumMembers, []);
});

test('several files accumulate into one bucket', () => {
    const found = collectHits(
        report({ file: 'src/a.ts', exports: [{ name: 'a' }] }, { file: 'src/b.ts', exports: [{ name: 'b' }] }),
        ['exports'],
    );
    assert.equal(found.exports.length, 2);
});

test('a non-array value in a category slot is ignored rather than crashing', () => {
    const found = collectHits(report({ file: 'src/a.ts', exports: 3 }), ['exports']);
    assert.deepEqual(found.exports, []);
});

// ── inspectDeadCode: the two passes ─────────────────────────────────────────
/** A stand-in for a knip run: `first` for the default graph, `second` under --production. */
const knipStub = (first, second = {}) => {
    const calls = [];
    const fn = (include, extra) => {
        calls.push({ include, extra });
        return extra === undefined ? first : second;
    };
    fn.calls = calls;
    return fn;
};

test('the first pass asks for every gated category', () => {
    const knip = knipStub({});
    inspectDeadCode(knip);
    assert.deepEqual(knip.calls[0]?.include, Object.keys(CATEGORIES));
});

test('the second pass runs under --production with entry exports included', () => {
    const knip = knipStub({});
    inspectDeadCode(knip);
    assert.deepEqual(knip.calls[1]?.extra, ['--production', '--include-entry-exports']);
});

test('the second pass does not ask for files or dependencies', () => {
    const knip = knipStub({});
    inspectDeadCode(knip);
    const second = knip.calls[1]?.include ?? [];
    for (const category of ['files', 'dependencies', 'devDependencies', 'optionalPeerDependencies']) {
        assert.ok(!second.includes(category), `${category} must not be in the --production pass`);
    }
    assert.ok(second.includes('exports'));
});

test("a library's second pass leaves entry exports out, since they are its API", () => {
    const knip = knipStub({});
    inspectDeadCode(knip, undefined, ['src/index.ts']);
    assert.deepEqual(knip.calls[1]?.extra, ['--production']);
});

test("a library's public types are not local-only, even when only their own file names them", () => {
    const hits = () => [
        { file: 'src/index.ts', name: 'Options', line: 1 },
        { file: 'src/icons/arrow.ts', name: 'ArrowProps', line: 2 },
        { file: 'src/lib/walk.ts', name: 'WalkState', line: 3 },
    ];
    const found = inspectDeadCode(knipStub({}), hits, ['src/index.ts', 'src/icons/*.ts']);
    assert.deepEqual(names(found[LOCAL_ONLY_TYPES.key]), ['src/lib/walk.ts:3 WalkState']);
});

test('an export only a test imports lands in testOnlyExports', () => {
    const knip = knipStub({ exports: [] }, { exports: [{ file: 'src/a.ts', name: 'requireOwner', line: 4 }] });
    const found = inspectDeadCode(knip);
    assert.deepEqual(names(found[TEST_ONLY.key]), ['src/a.ts:4 requireOwner']);
});

test('an export the first pass already named is not reported twice', () => {
    const hit = { file: 'src/a.ts', name: 'helper', line: 4 };
    const knip = knipStub({ exports: [hit] }, { exports: [{ ...hit }] });
    const found = inspectDeadCode(knip);
    assert.deepEqual(found[TEST_ONLY.key], []);
    assert.equal(found.exports.length, 1);
});

test('the identity is file and name, so the same name in another file still counts', () => {
    const knip = knipStub(
        { exports: [{ file: 'src/a.ts', name: 'helper', line: 4 }] },
        { exports: [{ file: 'src/b.ts', name: 'helper', line: 9 }] },
    );
    assert.deepEqual(names(inspectDeadCode(knip)[TEST_ONLY.key]), ['src/b.ts:9 helper']);
});

test('a first-pass finding in any category suppresses the second-pass copy', () => {
    const hit = { file: 'src/a.ts', name: 'Thing', line: 2 };
    const knip = knipStub({ types: [hit] }, { types: [{ ...hit }] });
    assert.deepEqual(inspectDeadCode(knip)[TEST_ONLY.key], []);
});

test('every second-pass category flows into the one bucket', () => {
    const knip = knipStub(
        {},
        { exports: [{ file: 'src/a.ts', name: 'a' }], enumMembers: [{ file: 'src/b.ts', name: 'B.one' }] },
    );
    assert.equal(inspectDeadCode(knip)[TEST_ONLY.key].length, 2);
});

// ── inspectDeadCode: the third pass ─────────────────────────────────────────
// What the pass finds is tested in gate-local-only-types.test.js; here, only how it joins.
test('the local-only types land in their own bucket', () => {
    const found = inspectDeadCode(knipStub({}), () => [{ file: 'src/a.ts', name: 'Shape', line: 1 }]);
    assert.deepEqual(names(found[LOCAL_ONLY_TYPES.key]), ['src/a.ts:1 Shape']);
});

test('without a third pass the bucket is empty, not missing', () => {
    assert.deepEqual(inspectDeadCode(knipStub({}))[LOCAL_ONLY_TYPES.key], []);
});

test('a type knip already reports as unused is not reported again as local-only', () => {
    const shape = { file: 'src/a.ts', name: 'Shape', line: 1 };
    const found = inspectDeadCode(knipStub({ types: [shape] }), () => [{ ...shape }]);
    assert.deepEqual(found[LOCAL_ONLY_TYPES.key], []);
});

test('a type the --production pass named is not reported again as local-only', () => {
    const shape = { file: 'src/a.ts', name: 'Shape', line: 1 };
    const found = inspectDeadCode(knipStub({}, { types: [shape] }), () => [{ ...shape }]);
    assert.equal(found[TEST_ONLY.key].length, 1);
    assert.deepEqual(found[LOCAL_ONLY_TYPES.key], []);
});

test('the local-only pass is reported last, and budgeted like any other category', () => {
    const found = { [TEST_ONLY.key]: [hit('src/b.ts', 'b', 1)], [LOCAL_ONLY_TYPES.key]: [hit('src/a.ts', 'Shape', 1)] };
    assert.match(deadCodeProblems(found).at(-1)?.what ?? '', /^Exported types only their own file names: 1 exceeds/);
    assert.equal(deadCodeProblems(found, { [TEST_ONLY.key]: 1, [LOCAL_ONLY_TYPES.key]: 1 }).length, 0);
});

// ── deadCodeProblems: the budgets ───────────────────────────────────────────
const hit = (file, name, line) => ({ file, name, line });

test('everything at zero is no problem at all', () => {
    assert.deepEqual(deadCodeProblems({}), []);
});

test('one finding in a zero-budget category is a problem', () => {
    const problems = deadCodeProblems({ exports: [hit('src/a.ts', 'helper', 4)] });
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.what ?? '', /^Unused exports: 1 exceeds the budget of 0\./);
});

test('the finding is listed under the count', () => {
    const problems = deadCodeProblems({ exports: [hit('src/a.ts', 'helper', 4)] });
    assert.match(problems[0]?.what ?? '', /• src\/a\.ts:4 — helper$/);
});

test('an unused whole file is listed by path alone', () => {
    const problems = deadCodeProblems({ files: [hit('src/a.ts', 'src/a.ts', undefined)] });
    assert.match(problems[0]?.what ?? '', /• src\/a\.ts$/);
});

test('a hit with no line number omits the colon', () => {
    const problems = deadCodeProblems({ exports: [hit('src/a.ts', 'helper', undefined)] });
    assert.match(problems[0]?.what ?? '', /• src\/a\.ts — helper$/);
});

test('findings are listed in path order, not knip order', () => {
    const problems = deadCodeProblems({ exports: [hit('src/z.ts', 'z', 1), hit('src/a.ts', 'a', 1)] });
    const listed = (problems[0]?.what ?? '').split('\n').slice(1);
    assert.deepEqual(
        listed.map((l) => l.trim()),
        ['• src/a.ts:1 — a', '• src/z.ts:1 — z'],
    );
});

test('a budget covers exactly its own count', () => {
    assert.deepEqual(deadCodeProblems({ exports: [hit('src/a.ts', 'a', 1)] }, { exports: 1 }), []);
    assert.equal(
        deadCodeProblems({ exports: [hit('src/a.ts', 'a', 1), hit('src/b.ts', 'b', 1)] }, { exports: 1 }).length,
        1,
    );
});

test('a budget applies only to the category it names', () => {
    const found = { exports: [hit('src/a.ts', 'a', 1)], types: [hit('src/b.ts', 'B', 1)] };
    const problems = deadCodeProblems(found, { exports: 1 });
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.what ?? '', /^Unused exported types/);
});

test('a budget whose category is back at zero must be removed', () => {
    const problems = deadCodeProblems({}, { cycles: 4 });
    assert.equal(problems.length, 1);
    assert.match(problems[0]?.what ?? '', /^Circular imports: back at 0, but still budgeted 4\./);
});

test('a budget of zero on an empty category is not a problem', () => {
    assert.deepEqual(deadCodeProblems({}, { cycles: 0 }), []);
});

test('a budget naming no category is reported, not ignored', () => {
    const problems = deadCodeProblems({ cycles: [hit('src/a.ts', 'a', 1)] }, { cycle: 1 });
    assert.deepEqual(
        problems.map((p) => p.what),
        [
            'Circular imports: 1 exceeds the budget of 0.\n      • src/a.ts:1 — a',
            'The budget for `cycle` names no category.',
        ],
    );
});

// ── deadCodeSummary ─────────────────────────────────────────────────────────
test('the summary says all at 0 only when every category is', () => {
    assert.equal(deadCodeSummary({}), 'No dead code or import-graph drift — 17 categories, all at 0.');
});

test('the summary names a budget still in use', () => {
    const found = { cycles: [hit('src/a.ts', 'a', 1), hit('src/b.ts', 'b', 1), hit('src/c.ts', 'c', 1)] };
    assert.equal(
        deadCodeSummary(found, { cycles: 4 }),
        'No dead code or import-graph drift — 17 categories, 16 at 0; within budget: circular imports 3 of 4.',
    );
});

test('the second pass is reported last, after every knip category', () => {
    const found = { exports: [hit('src/a.ts', 'a', 1)], [TEST_ONLY.key]: [hit('src/b.ts', 'b', 1)] };
    const problems = deadCodeProblems(found);
    assert.match(problems.at(-1)?.what ?? '', /^Exports used only by tests/);
});

test("the closing hint names this project's own checks directory", () => {
    const problems = deadCodeProblems({ exports: [hit('src/a.ts', 'a', 1)] }, {}, 'scripts/check');
    assert.match(problems[0]?.why ?? '', /scripts\/check\/check-dead-code\.ts/);
});

// ── The category list itself ────────────────────────────────────────────────
test('every category has a label and a fix', () => {
    for (const [key, { label, fix }] of Object.entries(CATEGORIES)) {
        assert.ok(label.length > 0, `${key} needs a label`);
        assert.ok(fix.length > 20, `${key} needs a fix that says what to do`);
    }
});

test('testOnlyExports and localOnlyTypes are not knip issue types', () => {
    assert.ok(!Object.keys(CATEGORIES).includes(TEST_ONLY.key));
    assert.ok(!Object.keys(CATEGORIES).includes(LOCAL_ONLY_TYPES.key));
    assert.ok(LOCAL_ONLY_TYPES.fix.length > 20);
});

test('the three dependency categories are all gated', () => {
    for (const key of ['dependencies', 'devDependencies', 'optionalPeerDependencies']) {
        assert.ok(Object.keys(CATEGORIES).includes(key), `${key} must be gated`);
    }
});

test('the rest of the import graph is gated too, pnpm catalogs aside', () => {
    for (const key of ['unlisted', 'binaries', 'unresolved', 'cycles']) {
        assert.ok(Object.keys(CATEGORIES).includes(key), `${key} must be gated`);
    }
    for (const key of ['catalog', 'catalogReferences']) {
        assert.ok(!Object.keys(CATEGORIES).includes(key), `${key} is pnpm-only`);
    }
});
