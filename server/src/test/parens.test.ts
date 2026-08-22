/**
 * Bracket balance.
 *
 * Like the comma and operator checks, this reports nothing across the corpus,
 * so these tests carry the whole burden of proving it still fires. Every "not
 * flagged" case is a shape taken from real library code — the `RANGE` intervals
 * in particular are 523 corpus occurrences, and all of them mix the kinds.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideParenDiagnostics } from '../providers/parens';

const URI = 'file:///Obj/scripts/3d.gdl';

function check(text: string, uri = URI): string[] {
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideParenDiagnostics(analyze(uri, text), td).map((d) => d.message);
}

// --- a bracket too many -----------------------------------------------------

test('a surplus closing paren is flagged', () => {
	// The shape that motivated the check, taken from a real 3D script.
	assert.deepEqual(check('_ang = atn(_stich / ccenters.c[1].x))'), [
		'Unmatched `)` — there is no `(` left open here.',
	]);
	assert.deepEqual(check('addx a)'), ['Unmatched `)` — there is no `(` left open here.']);
	assert.deepEqual(check('a = arr[1]]'), ['Unmatched `]` — there is no `[` left open here.']);
});

test('each surplus bracket is reported', () => {
	assert.deepEqual(check('a = sin(x)))'), [
		'Unmatched `)` — there is no `(` left open here.',
		'Unmatched `)` — there is no `(` left open here.',
	]);
});

// --- a bracket too few ------------------------------------------------------

test('an unclosed bracket is flagged', () => {
	assert.deepEqual(check('a = atn(b / c'), [
		'`(` is never closed — expected `)` before the statement ends.',
	]);
	assert.deepEqual(check('a = arr[i'), [
		'`[` is never closed — expected `]` before the statement ends.',
	]);
});

test('unclosed brackets are reported innermost first', () => {
	assert.deepEqual(check('a = sqr(sin(x'), [
		'`(` is never closed — expected `)` before the statement ends.',
		'`(` is never closed — expected `)` before the statement ends.',
	]);
});

test('a bracket does not carry over to the next statement', () => {
	// Two errors, not one balanced pair: `\` and a trailing `,` are the only
	// things that join lines, and neither is present.
	assert.deepEqual(check('a = sin(x\nb = 2)'), [
		'`(` is never closed — expected `)` before the statement ends.',
		'Unmatched `)` — there is no `(` left open here.',
	]);
});

// --- the wrong kind of bracket ----------------------------------------------

test('a bracket closed by the wrong kind is flagged', () => {
	assert.deepEqual(check('n = int(arr[1)'), [
		'`)` closes a `[` opened at line 1 — expected `]`.',
		'`(` is never closed — expected `)` before the statement ends.',
	]);
});

// --- what must stay quiet ---------------------------------------------------

test('nested and consecutive brackets balance', () => {
	assert.deepEqual(check('a = sqr(sin(x) * cos(y)) + arr[i][j]'), []);
	assert.deepEqual(check('cprism_ 1, 1, 1, 4, x[1], y[1], 15, x[2], y[2], 15'), []);
});

test('a statement continued over several lines balances', () => {
	assert.deepEqual(
		check('_v = atn(_a / \\\n         _b) + \\\n         2'),
		[],
	);
	// A trailing comma joins the lines too — a bracket may span the join.
	assert.deepEqual(check('put x, sin(a),\n    y, cos(b)'), []);
});

test('brackets inside strings and comments are not counted', () => {
	assert.deepEqual(check('text2 0, 0, "f(x) = ("'), []);
	assert.deepEqual(check('addx 1  ! (was atn(a'), []);
	// A `\` continuation carries through a commented-out line.
	assert.deepEqual(check('a = (1 + \\\n     ! b + ) \\\n     2)'), []);
});

test('RANGE intervals mix the bracket kinds on purpose', () => {
	const vl = 'file:///Obj/scripts/vl.gdl';
	assert.deepEqual(check('values "Winkel_1" RANGE(0, 170]', vl), []);
	assert.deepEqual(check('values "gs_resol" range [4, )', vl), []);
	assert.deepEqual(check('values "radius1" range (0,]', vl), []);
	assert.deepEqual(check('values "h" range [, min(A, B)*0.09]', vl), []);
	assert.deepEqual(check('values "h" range [,]', vl), []);
	// It is only the *kind* that is waived; an interval still has to balance.
	assert.deepEqual(check('values "h" range [0, 1', vl), [
		'`[` is never closed — expected `]` before the statement ends.',
	]);
});

test('an unterminated string suppresses the check', () => {
	// The string swallowed the rest of the line, brackets included; reporting
	// them as well would be two errors for one typo.
	assert.deepEqual(check('text2 0, 0, "f(x'), []);
});

test('imperial measurements are not string delimiters', () => {
	// `-.25"` is a number, so nothing here opens or closes anything.
	assert.deepEqual(check('addz -.25"'), []);
	assert.deepEqual(check("a = int((2'-6\" + 3/4\") / 2)"), []);
});
