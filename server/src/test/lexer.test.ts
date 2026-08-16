/**
 * Lexer tests.
 *
 * Every case here is a GDL quirk found in real library code, not a
 * hypothetical. Keep it that way — this file doubles as documentation of the
 * lexical oddities the language actually has.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tokenize } from '../gdl/lexer';

const kinds = (src: string) => tokenize(src).filter((t) => t.type !== 'eof').map((t) => `${t.type}:${t.text}`);

test('comments run to end of line', () => {
	assert.deepEqual(kinds('a = 1 ! note'), [
		'identifier:a',
		'operator:=',
		'number:1',
		'comment:! note',
	]);
});

test('all three string delimiters are recognised', () => {
	const toks = tokenize('"a" `b` \'c\'').filter((t) => t.type === 'string');
	assert.deepEqual(toks.map((t) => t.quote), ['"', '`', "'"]);
	assert.equal(toks.every((t) => !t.unterminated), true);
});

test('imperial literals are numbers, not string starts', () => {
	// `ADDZ -.25"` is 0.25 inches. Mis-lexing the `"` opens a bogus string
	// that swallows the rest of the script.
	assert.deepEqual(kinds('addz -.25"'), ['identifier:addz', 'operator:-', 'number:.25"']);
	assert.deepEqual(kinds("a = 2'-6\""), ['identifier:a', 'operator:=', 'number:2\'-6"']);
	assert.deepEqual(kinds("a = 3'"), ['identifier:a', 'operator:=', "number:3'"]);
});

test('imperial fractions without a feet part are single numbers', () => {
	// `24 3/4"` is 24¾ inches, not `24` beside `3/4`.
	assert.deepEqual(kinds('addy 24 3/4"'), ['identifier:addy', 'number:24 3/4"']);
	assert.deepEqual(kinds('addy 1 1/2"'), ['identifier:addy', 'number:1 1/2"']);
	assert.deepEqual(kinds('addy 3/4"'), ['identifier:addy', 'number:3/4"']);
});

test('a fraction without an inch mark stays ordinary division', () => {
	assert.deepEqual(kinds('a = 3/4'), [
		'identifier:a',
		'operator:=',
		'number:3',
		'operator:/',
		'number:4',
	]);
});

test('a quote after whitespace still starts a string', () => {
	const toks = tokenize('print 5 "text"');
	assert.equal(toks.find((t) => t.type === 'string')?.text, '"text"');
});

test('backslash continues a statement across lines', () => {
	assert.deepEqual(kinds('a = 1 + \\\n2'), [
		'identifier:a',
		'operator:=',
		'number:1',
		'operator:+',
		'number:2',
	]);
});

test('a continuation may carry a trailing comment', () => {
	const toks = tokenize('if a |\\ ! why\n b then');
	assert.equal(toks.some((t) => t.type === 'newline'), false);
	assert.equal(toks.at(-2)?.text, 'then');
});

test('a continuation survives blank lines', () => {
	const toks = tokenize('if a |\\\n   b \\\n\n then');
	assert.equal(toks.some((t) => t.type === 'newline'), false);
	assert.equal(toks.at(-2)?.text, 'then');
});

test('a continuation survives a commented-out line', () => {
	// Base Macros/Threshold comments out one term of a multi-line condition:
	//     bNor = (iThresholdType = TRESHOLD_FLAT   | \
	//             !iThresholdType = TRESHOLD_HEVE  | \
	//             iThresholdType = TRESHOLD_BRANN )
	// A comment is a no-op, so the statement carries on through it. Ending it
	// there instead left the expression truncated on a dangling `|`.
	const toks = tokenize('bNor = (a = 1 |\\\n\t!b = 2 |\\\n\tc = 3)');
	assert.equal(toks.some((t) => t.type === 'newline'), false);
	assert.equal(toks.at(-2)?.text, ')');
	// The comment is still there to be read, just not as a statement break.
	assert.equal(toks.some((t) => t.type === 'comment' && t.text === '!b = 2 |\\'), true);
});

test('a comment cannot start a continuation of its own', () => {
	// Library code comments out whole statements line by line, and 116 of those
	// lines end in `\`. Were that a continuation, each would eat the live
	// statement below it.
	const toks = tokenize('! a = 1 + \\\nb = 2');
	assert.deepEqual(
		toks.filter((t) => t.type !== 'eof').map((t) => t.type),
		['comment', 'newline', 'identifier', 'operator', 'number'],
	);
});

test('strings continue across lines with a backslash', () => {
	const toks = tokenize('ui_outfield `line one \\\n line two`');
	const str = toks.find((t) => t.type === 'string');
	assert.equal(str?.unterminated, undefined);
	assert.match(str!.text, /line two/);
});

test('unterminated strings are flagged, not swallowed', () => {
	const toks = tokenize('a = "oops\nb = 2');
	assert.equal(toks.find((t) => t.type === 'string')?.unterminated, true);
	// The next line must still tokenize normally.
	assert.equal(toks.some((t) => t.text === 'b'), true);
});

test('a UTF-8 BOM does not displace the first keyword', () => {
	const toks = tokenize('﻿if a then');
	assert.equal(toks[0].type, 'identifier');
	assert.equal(toks[0].text, 'if');
});

test('classic-Mac CR-only line endings terminate lines', () => {
	const toks = tokenize('! comment\ra = 1');
	assert.equal(toks.some((t) => t.type === 'newline'), true);
	assert.equal(toks.some((t) => t.text === 'a'), true);
});

test('dotted and variant identifiers stay whole', () => {
	assert.deepEqual(kinds('DETLEVEL.d3.mvo'), ['identifier:DETLEVEL.d3.mvo']);
	assert.deepEqual(kinds('CPRISM_{2}'), ['identifier:CPRISM_{2}']);
});
