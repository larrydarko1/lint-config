/**
 * The Rust reader the Rust passes and the Tauri gates stand on. Each trap here is a
 * place where counting brackets in Rust goes wrong in a way TypeScript never does: a
 * lifetime that looks like a quote, a raw string full of braces, a block comment
 * inside a block comment, an `impl` whose self type sits after `for`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    closingBracket,
    isTestModule,
    lexRust,
    rustDocBlocks,
    rustItems,
    splitRustList,
    stringsIn,
    summarySentences,
} from '../src/gates/lib/rust.ts';

const kinds = (source) => rustItems(source).map((it) => `${it.kind} ${it.name}`);

// ── The lexer ───────────────────────────────────────────────────────────────

test('the lexed code is the same length as the source, so offsets carry over', () => {
    const source = 'fn a() { let s = "x{y}"; } // trailing {\n/* a { */ const B: char = \'{\';\n';
    assert.equal(lexRust(source).code.length, source.length);
});

test('comments and literal contents are blanked; the quotes stay', () => {
    const { code } = lexRust('let s = "a{b"; // c}\n');
    assert.equal(code, 'let s = "   ";      \n');
});

test('block comments nest, as Rust reads them', () => {
    const { code } = lexRust('/* outer /* inner */ still a comment */ fn a() {}');
    assert.match(code, /^\s+fn a\(\) \{\}$/);
});

test("THE LIFETIME TRAP: `'a` is not the start of a char literal", () => {
    const source = "impl<'a> Foo<'a> { fn x(&'a self) -> &'a str { \"}\" } }";
    const { code } = lexRust(source);
    assert.equal(closingBracket(code, code.indexOf('{')), source.length - 1);
});

test('char literals are blanked, escaped ones included', () => {
    const { code } = lexRust("let a = '{'; let b = '\\''; let c = '\\u{7D}';");
    assert.doesNotMatch(code, /[{}]/);
});

test('a raw string is read to its own closing `"#`, quotes inside and all', () => {
    const source = 'const A: &str = r#"say "{" here"#; fn b() {}';
    const lexed = lexRust(source);
    assert.deepEqual(
        lexed.strings.map((s) => s.value),
        ['say "{" here'],
    );
    assert.deepEqual(kinds(source), ['const A', 'fn b']);
});

test('byte and raw byte strings are strings too, braces inside them included', () => {
    const source = 'const A: &[u8] = b"x}"; const B: &[u8] = br#"z{"#; fn c() {}';
    assert.deepEqual(
        lexRust(source).strings.map((s) => s.value),
        ['x}', 'z{'],
    );
    assert.deepEqual(kinds(source), ['const A', 'const B', 'fn c']);
});

test('string values unescape the common escapes', () => {
    assert.deepEqual(
        lexRust('const A: &str = "a\\"b\\n";').strings.map((s) => s.value),
        ['a"b\n'],
    );
});

test('stringsIn reads a list literal’s entries, in order', () => {
    const source = 'const COMMANDS: &[&str] = &["one", "two"];\nconst OTHER: &str = "three";';
    const lexed = lexRust(source);
    const [list] = rustItems(source, lexed);
    assert.deepEqual(stringsIn(lexed, list.keywordStart, list.end), ['one', 'two']);
});

// ── Items ───────────────────────────────────────────────────────────────────

test('every item kind a Tauri crate has is read, in order', () => {
    const source = `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod commands;
pub mod error;
use std::path::Path;
pub use crate::error::Error;
extern crate alloc;
const LIMIT: u32 = 1;
static NAME: &str = "x";
pub struct A(pub u8);
enum B { One, Two }
pub type R<T> = std::result::Result<T, Error>;
pub trait C {}
impl A { fn new() -> Self { Self(0) } }
pub async fn run() {}
pub const fn twice(x: u8) -> u8 { x * 2 }
macro_rules! m { () => {}; }
m!();
#[cfg(test)]
mod tests { use super::*; }
`;
    assert.deepEqual(kinds(source), [
        'inner-attribute #![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]',
        'mod commands',
        'mod error',
        'use std::path::Path',
        'use crate::error::Error',
        'extern-crate alloc',
        'const LIMIT',
        'static NAME',
        'struct A',
        'enum B',
        'type R',
        'trait C',
        'impl A',
        'fn run',
        'fn twice',
        'macro-rules m',
        'macro m',
        'mod tests',
    ]);
});

test('visibility is any `pub`, `pub(crate)` included', () => {
    const items = rustItems('pub(crate) fn a() {}\npub fn b() {}\nfn c() {}');
    assert.deepEqual(
        items.map((it) => it.public),
        [true, true, false],
    );
});

test('attributes belong to the item below them, and the item starts at the first one', () => {
    const source = '#[derive(Debug)]\n#[serde(rename_all = "camelCase")]\npub struct A {}';
    const [item] = rustItems(source);
    assert.deepEqual(item.attributes, ['#[derive(Debug)]', '#[serde(rename_all = "camelCase")]']);
    assert.equal(item.start, 0);
    assert.equal(item.line, 3);
});

test('an impl names its self type, and keeps the trait it implements', () => {
    const [inherent, trait, generic] = rustItems(
        "impl Error {}\nimpl<'kvs> VisitSource<'kvs> for Fields {}\nimpl<T: Into<String>> From<T> for Wrapper<T> where T: Clone {}",
    );
    assert.deepEqual([inherent.name, inherent.trait], ['Error', undefined]);
    assert.deepEqual([trait.name, trait.trait], ['Fields', "VisitSource<'kvs>"]);
    assert.deepEqual([generic.name, generic.trait], ['Wrapper', 'From<T>']);
});

test('a struct literal inside a const does not end the const early', () => {
    assert.deepEqual(kinds('const D: S = S { a: 1 };\nfn next() {}'), ['const D', 'fn next']);
});

test('an fn’s body is recorded; a unit struct has none', () => {
    const [unit, fn] = rustItems('struct U;\nfn f() -> Result<(), E> { Ok(()) }');
    assert.equal(unit.body, null);
    assert.notEqual(fn.body, null);
    assert.equal(fn.head, 'fn f() -> Result<(), E>');
});

test('isTestModule is the inline cfg(test) module, not a declared one', () => {
    const [declared, inline] = rustItems('#[cfg(test)]\nmod tests;\n#[cfg(test)]\nmod more { }');
    assert.equal(isTestModule(declared), false);
    assert.equal(isTestModule(inline), true);
});

test('splitRustList splits at depth zero, through generics and closures', () => {
    assert.deepEqual(splitRustList('a::b, Vec<(u8, u8)>, |x| { x, }, c => d'), [
        'a::b',
        'Vec<(u8, u8)>',
        '|x| { x, }',
        'c => d',
    ]);
});

// ── Docs ────────────────────────────────────────────────────────────────────

test('doc blocks are read by kind, and `////` is a plain comment', () => {
    const blocks = rustDocBlocks('//! The crate.\n//!\n//! More.\n\n//// not docs\n/// The item.\nfn a() {}');
    assert.deepEqual(
        blocks.map((b) => [b.kind, b.line, b.lines]),
        [
            ['inner', 1, ['The crate.', '', 'More.']],
            ['outer', 6, ['The item.']],
        ],
    );
});

test('a `///` inside a string literal is not a doc block', () => {
    assert.deepEqual(rustDocBlocks('const A: &str = "\n/// not a doc\n";'), []);
});

test('the summary is the first paragraph, and its sentences are counted', () => {
    assert.equal(summarySentences(['The error every command returns.', '', 'It crosses as a code.']), 1);
    assert.equal(summarySentences(['The error every command returns. It crosses', 'as a code.']), 2);
});

test('a code span, a link or a lowercase word after a full stop ends no sentence', () => {
    assert.equal(summarySentences(['Reads `a.b`, a [`Path`](std::path::Path) and the rest, e.g. this.']), 1);
});
