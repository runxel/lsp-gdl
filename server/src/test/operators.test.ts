/**
 * Operator checks.
 *
 * Like the comma checks, these report nothing at all across the 2400-file
 * corpus, so these tests carry the whole burden of proving they still fire.
 * Every "not flagged" case below is a shape taken from real library code —
 * several of them from GRAPHISOFT's own Base Macros and ACLib — so treat a new
 * one as a bug report rather than a hypothetical.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideOperatorDiagnostics } from '../providers/operators';

const URI = 'file:///Obj/scripts/3d.gdl';

function check(text: string): string[] {
	const td = TextDocument.create(URI, 'gdl-hsf', 1, text);
	return provideOperatorDiagnostics(analyze(URI, text), td).map((d) => d.message);
}

// --- doubled operators ------------------------------------------------------

test('a doubled operator is flagged', () => {
	assert.deepEqual(check('a = 1 + + 2'), [
		'Two operators in a row — `+ +`. Only `-` may follow an operator, as a sign.',
	]);
	assert.deepEqual(check('a = b * + c'), [
		'Two operators in a row — `* +`. Only `-` may follow an operator, as a sign.',
	]);
	// Written without spaces, which is how the slip usually looks.
	assert.deepEqual(check('a = 1++2'), [
		'Two operators in a row — `+ +`. Only `-` may follow an operator, as a sign.',
	]);
});

test('an operator with nothing on its left is flagged', () => {
	assert.deepEqual(check('a = b * / c'), [
		'Two operators in a row — `* /`. `/` has no value on its left.',
	]);
	assert.deepEqual(check('a = = 1'), ['Two operators in a row — `= =`. `=` has no value on its left.']);
	assert.deepEqual(check('if a < > b then addx 1'), [
		'Two operators in a row — `< >`. `>` has no value on its left.',
	]);
	assert.deepEqual(check('a = (* 2)'), ['`*` has no value on its left.']);
});

test('an operator with nothing on its right is flagged', () => {
	assert.deepEqual(check('a = (b + )'), ['`+` has no value on its right.']);
	assert.deepEqual(check('put 1, 2 *, 3'), ['`*` has no value on its right.']);
	assert.deepEqual(check('a = arr[i -]'), ['`-` has no value on its right.']);
});

test('an expression that runs out at the end of the statement is flagged', () => {
	assert.deepEqual(check('a = b +'), ['`+` has no value on its right — the statement ends here.']);
	assert.deepEqual(check('a = b *\nc = 1'), ['`*` has no value on its right — the statement ends here.']);
});

test('a commented-out line inside a continuation does not truncate it', () => {
	// Base Macros/Threshold, and six more like it. The comment is a no-op, so
	// the continuation runs straight through it and the `|` above keeps its
	// right-hand side. This was seven false positives before the lexer agreed.
	const text =
		'bNor = (iType = TRESHOLD_FLAT | \\\n' +
		'\t!iType = TRESHOLD_HEVE | \\\n' +
		'\tiType = TRESHOLD_BRANN)';
	assert.deepEqual(check(text), []);
});

test('a run of operators is reported once', () => {
	assert.deepEqual(check('a = 1 + + + 2'), [
		'Two operators in a row — `+ +`. Only `-` may follow an operator, as a sign.',
	]);
});

// --- the shapes that must stay silent ---------------------------------------

test('a leading minus is a sign, never a doubled operator', () => {
	// `, -` alone occurs ~198k times in the corpus.
	assert.deepEqual(check('put -x/2, y, msk,\n\t-tlr, 0, msk'), []);
	assert.deepEqual(check('a = b * -1'), []);
	assert.deepEqual(check('if bs_leaf_overhang < -tlr then addz 1'), []);
	assert.deepEqual(check('if dk_LoI > -1 then addz 1'), []);
	assert.deepEqual(check('if UI_page_type[i] # -2 then addz 1'), []);
	assert.deepEqual(check('a = -1'), []);
	assert.deepEqual(check('a = 3 - -2'), []);
});

test('a leading plus in an operand position is left alone', () => {
	// Base Macros/BasicGeometry opens continued sums this way, for alignment.
	assert.deepEqual(check('_determinant = +_t.XAxis.dx * _t.YAxis.dy'), []);
	assert.deepEqual(check('_inv.Xaxis.dy = (+ _t.ZAxis.dy * _t.XAxis.dz - _t.XAxis.dy * _t.ZAxis.dz)'), []);
	// ACLib/Section-Elevation Marker Macro.
	assert.deepEqual(check('epsilon = + EPS'), []);
	// A whole coordinate row aligned with `+`, from BIM-all-doors.
	assert.deepEqual(check('put -x/2, y, msk,\n\t+x/2, y, msk'), []);
});

test('open-ended RANGE intervals are not truncated expressions', () => {
	assert.deepEqual(check('values "cp_height_lower" range( , cp_height_upper)'), []);
	assert.deepEqual(check('values "bulge", range[, min(A, B)*0.09]'), []);
	assert.deepEqual(check('values "coursing_start" range[,] step 0, 0.5'), []);
	assert.deepEqual(check('values "gs_height" range[rail_d*2,)'), []);
	assert.deepEqual(check('values "hFrame" range [(wFrame - ac_panelThickness) / 2, ]'), []);
});

test('ordinary expressions are not disturbed', () => {
	assert.deepEqual(check('x = 3 * (1 - _guess) ** 2 * _guess * ease1x'), []);
	assert.deepEqual(check('iEdgeNext = iEdge % (nCut - 1) + 1'), []);
	assert.deepEqual(check('_flag = (_panelflags[_i - 1][FLAG_SIDE] % 4) + 1'), []);
	assert.deepEqual(check('if errorR[i] <> "" then addx 1'), []);
	assert.deepEqual(check('ui_seiten = VARDIM1(UI_page_type) * (UI_page_names[1] # "noPages" & UI_page_names[1] # "")'), []);
	assert.deepEqual(check('dim arr[]'), []);
	assert.deepEqual(check('new_midpoints[ac_polyline[i]] = 1'), []);
	assert.deepEqual(check('pen pens[types[i]][1]'), []);
	// An imperial number, not an operator meeting a string.
	assert.deepEqual(check('addz -.25"'), []);
	assert.deepEqual(check('a = 3/4'), []);
});

test('a multi-line condition continued with a backslash is not truncated', () => {
	assert.deepEqual(check('if a = 1 |\\\n\tb = 2 \\\n\nthen\naddx 1\nendif'), []);
	assert.deepEqual(check('bNor = (iType = 1 | \\\n\tiType = 2 | \\\n\tiType = 3)'), []);
});

test('jump labels and statement separators are not operators', () => {
	assert.deepEqual(check('100:\nfor i = 1 to n : cutend : next i'), []);
	assert.deepEqual(check('"tapPage":\nreturn'), []);
});
