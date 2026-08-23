/**
 * Comma checks.
 *
 * Both checks report nothing at all across the 2400-file corpus, so these tests
 * carry the whole burden of proving they still fire on the mistakes they exist
 * to catch. The "not flagged" cases are the legal shapes that forced each
 * exception; treat any new one as a bug report.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideCommaDiagnostics } from '../providers/commas';

const URI = 'file:///Obj/scripts/3d.gdl';

function check(text: string): string[] {
	const td = TextDocument.create(URI, 'gdl-hsf', 1, text);
	return provideCommaDiagnostics(analyze(URI, text), td).map((d) => d.message);
}

// --- missing commas ---------------------------------------------------------

test('two values side by side in a list are flagged', () => {
	assert.deepEqual(check('put 0.815, 0.1649 0.1650, 1'), [
		'Missing comma between `0.1649` and `0.1650`.',
	]);
	// `ADD2 x, y` takes two arguments, so this drops one.
	assert.deepEqual(check('add2 xOffset yOffset'), [
		'Missing comma between `xOffset` and `yOffset`.',
	]);
	assert.deepEqual(check('put a, b c, d'), ['Missing comma between `b` and `c`.']);
});

test('a command followed by its first argument is not a missing comma', () => {
	assert.deepEqual(check('material gs_mat'), []);
	assert.deepEqual(check('resol 48'), []);
	assert.deepEqual(check('group "Bell"'), []);
});

test('statement syntax words never look like a missing comma', () => {
	assert.deepEqual(check('for i = 1 to 6 step 2'), []);
	assert.deepEqual(check('if a then addx 1'), []);
	assert.deepEqual(check('call "macro" parameters all'), []);
	assert.deepEqual(check('model solid'), []);
	assert.deepEqual(check('set style "big"'), []);
});

test('commands that run their name into the list are exempt — once', () => {
	assert.deepEqual(check('values "gs_leaf_thk" 0.01, 0.03, custom'), []);
	assert.deepEqual(check('define material "Cover white" 4, 0.95, 0.95, 0.95'), []);
	assert.deepEqual(check('textblock "tb" 0, 7, 0, 1'), []);
	// The name may itself be an expression.
	assert.deepEqual(check('textblock "tb" + styleName width, anchor, 1'), []);
	assert.deepEqual(check('paragraph k * 10 + i 1, 0, 0'), []);
	// ...but a second gap in the same list is still a mistake.
	assert.deepEqual(check('values "thk" 0.01 0.03, 0.05'), [
		'Missing comma between `0.01` and `0.03`.',
	]);
});

test('each clause of a single-line IF is measured separately', () => {
	assert.deepEqual(check('if n > 0 then values "s" a else values "s" b'), []);
});

// --- trailing commas --------------------------------------------------------

test('a comma that swallows the following command is flagged', () => {
	// `MATERIAL` never runs: the comma glued it onto the PUT argument list.
	assert.deepEqual(check('put 1, 2, 3,\nmaterial wood'), [
		'Trailing comma — `material` on the next line reads as another argument rather than a new statement.',
	]);
	assert.match(check('hotspot2 0, 0,\npen 3')[0], /Trailing comma/);
});

test('an ordinary wrapped argument list is not flagged', () => {
	assert.deepEqual(check('put 0.815, 0.1649,\n\t0.833, 0.2039'), []);
	assert.deepEqual(check('revolve nsp / 3, 360, 1 + 2,\n\tget(nsp)'), []);
});

test('clause keywords may legitimately open a continuation line', () => {
	// Every one of these was a false positive on the corpus.
	assert.deepEqual(check('poly2_b nsp / 3, 1 + 2,\n\tuse 4'), []);
	assert.deepEqual(check('prism_ n, h,\n\tnsp'), []);
	assert.deepEqual(check('define material "m", 0,\n\tadditional_data "x", 1'), []);
	assert.deepEqual(check('values "thk" 0.01, 0.03,\n\tcustom'), []);
});

test('a macro call listing named arguments per line is not flagged', () => {
	assert.deepEqual(
		check('call "BasicGeometry" parameters iFunction = 1,\n\tpolygon = poly,\n\tlineA = ln'),
		[],
	);
});

// --- stranded arguments -----------------------------------------------------

test('a list left standing by a missing comma is flagged', () => {
	// The comma after `_prf[ii + 2]` is missing, so the statement ends there and
	// `_srf` — a name and nothing else — is left as a statement of its own.
	assert.deepEqual(check('put \\\n\t_prf[ii],\n\t_prf[ii + 1],\n\t_prf[ii + 2]\n\t_srf'), [
		'Missing comma — `_srf` on the next line reads as a statement of its own rather than the next argument.',
	]);
	assert.deepEqual(check('prism_ 3, 0.4,\n\t0, 0, s\n\t1, 1, s'), [
		'Missing comma — `1` on the next line reads as a statement of its own rather than the next argument.',
	]);
});

test('every stranded row of a coordinate list is reported', () => {
	// The stranded remains of a list can strand the next row in turn, so two
	// missing commas must give two reports rather than one.
	assert.deepEqual(check('prism_ 3, 0.4,\n\t0, 0, s\n\t1, 1, s\n\t2, 2, s').length, 2);
});

test('a correctly wrapped list is not flagged', () => {
	assert.deepEqual(check('prism_ 3, 0.4,\n\t0, 0, s,\n\t1, 1, s'), []);
	// The next line is a command, so nothing was stranded.
	assert.deepEqual(check('put 1, 2, 3\naddz 1'), []);
	assert.deepEqual(check('put 1, 2, 3\nx = 4'), []);
	assert.deepEqual(check('put 1, 2, 3\n"routine":'), []);
});

test('DEFINE lines in a row are commands, not stranded values', () => {
	// The keyword table indexes `DEFINE STYLE{2}` whole, so `DEFINE` on its own
	// is not a keyword — which made a run of them read as two lists of values.
	assert.deepEqual(check('define style{2} "a" f, s, 0\ndefine style{2} "b" f, s, 1'), []);
	assert.deepEqual(check('define material "m" 4, 0.95, 0.95\ndefine material "n" 4, 0.5, 0.5'), []);
});

test('a PARAGRAPH body is written as bare values by design', () => {
	assert.deepEqual(
		check('paragraph "p" 2, 0, 0, 0, 1\n\tpen 3\n\tstr(x, 1, 0)\n\t"\\n"\n\tname[i]\nendparagraph'),
		[],
	);
});

test('a gap in the text is too weak a signal to judge', () => {
	// A blank or commented-out line between the two is not the shape a dropped
	// comma leaves behind.
	assert.deepEqual(check('put 1, 2, 3\n\nfoo'), []);
	assert.deepEqual(check('put 1, 2, 3\n! note\nfoo'), []);
	// `MATERIAL` takes one argument and could never have continued, so telling
	// anyone to put a comma after it would be wrong.
	assert.deepEqual(check('material gs_mat\nfoo'), []);
});
