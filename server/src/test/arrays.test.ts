/**
 * Array bounds checks.
 *
 * Like the comma checks, this reports nothing across the whole corpus, so these
 * tests are the only proof it works. The "no diagnostic" cases encode the two
 * things that make GDL arrays awkward: dynamic dimensions grow to fit any
 * index, and only constant indices can be judged at all.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { URI as Uri } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideArrayDiagnostics } from '../providers/arrays';

const URI = 'file:///Obj/scripts/3d.gdl';

function check(text: string): string[] {
	const td = TextDocument.create(URI, 'gdl-hsf', 1, text);
	return provideArrayDiagnostics(analyze(URI, text), td).map((d) => d.message);
}

// The undeclared check needs a real library part on disk: `paramlist.xml` says
// which names are parameters, and the master script is where a shared `DIM`
// lives. `TestObject` supplies both — `aSegmentWidths` is an array parameter
// and `1d.gdl` declares `gSegmentLengths[]`.
const FIXTURES = join(__dirname, '..', '..', '..', 'TestObject');
const partUri = (script: string) =>
	Uri.file(join(FIXTURES, 'TestObject', 'scripts', script)).toString();

function checkInPart(text: string, script = '3d.gdl'): string[] {
	const uri = partUri(script);
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideArrayDiagnostics(analyze(uri, text), td).map((d) => d.message);
}

test('writing past a fixed dimension is an error', () => {
	assert.deepEqual(check('dim a[4]\na[5] = 1'), [
		'`a` is declared with 4 elements, so index 5 is out of bounds.',
	]);
	// Reading is checked too — the guide says fixed dimensions are validated.
	assert.deepEqual(check('dim a[4]\nx = a[5]'), [
		'`a` is declared with 4 elements, so index 5 is out of bounds.',
	]);
});

test('the last valid cell is accepted', () => {
	assert.deepEqual(check('dim a[4]\na[4] = 1'), []);
	assert.deepEqual(check('dim a[3][2]\na[3][2] = 1'), []);
});

test('indices below 1 never exist', () => {
	// GDL arrays are 1-based, so this holds even for a dynamic array.
	assert.match(check('dim a[4]\na[0] = 1')[0], /indices start at 1/);
	assert.match(check('dim a[]\na[0] = 1')[0], /indices start at 1/);
	assert.match(check('dim a[4]\na[-1] = 1')[0], /indices start at 1/);
	// And even for an array we never saw declared.
	assert.match(check('x = someArray[0]')[0], /indices start at 1/);
});

test('dynamic dimensions have no upper bound', () => {
	assert.deepEqual(check('dim a[]\na[999] = 1'), []);
	assert.deepEqual(check('dim a[][]\na[99][99] = 1'), []);
});

test('each dimension is checked against its own bound', () => {
	assert.deepEqual(check('dim a[][2]\na[99][3] = 1'), [
		'`a` is declared with 2 elements on dimension 2, so index 3 is out of bounds.',
	]);
	assert.deepEqual(check('dim a[3][2]\na[4][1] = 1'), [
		'`a` is declared with 3 elements on dimension 1, so index 4 is out of bounds.',
	]);
});

test('a computed index cannot be judged', () => {
	assert.deepEqual(check('dim a[4]\na[i] = 1'), []);
	assert.deepEqual(check('dim a[4]\nfor i = 1 to 9\n\ta[i] = 1\nnext i'), []);
	assert.deepEqual(check('dim a[4]\na[n + 1] = 1'), []);
});

test('several arrays may be declared in one DIM', () => {
	assert.deepEqual(check('dim a[4], b[2]\nb[3] = 1'), [
		'`b` is declared with 2 elements, so index 3 is out of bounds.',
	]);
	assert.deepEqual(check('dim a[4], b[2]\na[4] = 1'), []);
});

test('a later DIM replaces the earlier bounds', () => {
	// The standard reset idiom, which also drops the fixed size.
	assert.deepEqual(check('dim a[4]\ndim a[]\na[9] = 1'), []);
	assert.deepEqual(check('dim a[]\ndim a[2]\na[9] = 1'), [
		'`a` is declared with 2 elements, so index 9 is out of bounds.',
	]);
});

test('parameter arrays are left alone', () => {
	// The guide: library part parameter arrays "are dynamic by default",
	// whatever size the parameter list currently shows.
	assert.deepEqual(check('x = ac_corner_offsets[7]'), []);
});

test('an array that was never declared is reported', () => {
	// The shape the corpus actually holds: a rename left `pos_drain` behind
	// while the parameter list moved on to `pos_drain_x` / `pos_drain_y`.
	const message =
		'`pos_drain` is subscripted but never declared: no `DIM` reaches this script, ' +
		'and `TestObject` has no parameter of that name.';
	assert.deepEqual(checkInPart('circle2 pos_drain[1], 0.02'), [message]);
	// It is the same mistake wherever the subscript sits, and a command wrapped
	// around it changes nothing — the whole statement is walked, as in
	// `groups.ts` and `labels.ts`, not just its head.
	assert.deepEqual(checkInPart('add pos_def_x + pos_drain[1], 0, zzyzx'), [message]);
	assert.deepEqual(checkInPart('if a then add pos_drain[1], 0, 0'), [message]);
});

test('every site is reported, not just the first', () => {
	// Reporting once per name was tried first and read as the check not
	// working: a line pasted below an earlier use of the same array was left
	// clean. `Waschbecken AOL/3d.gdl` is exactly that shape, its second
	// `pos_drain` sitting a hundred lines under the first.
	assert.equal(checkInPart('z[1] = 0\nz[2] = 1').length, 2);
	// Two on one line are two subscripts and get one each.
	assert.equal(checkInPart('z[n] = z[1]').length, 2);
});

test('every declaration in reach silences it', () => {
	assert.deepEqual(checkInPart('dim mine[4]\nmine[2] = 1'), []);
	// Declared by the master script, which runs ahead of this one.
	assert.deepEqual(checkInPart('gSegmentLengths[2] = 1'), []);
	// An array parameter needs no declaration at all.
	assert.deepEqual(checkInPart('x = aSegmentWidths[2]'), []);
	// Nor does a global — plenty of them are arrays.
	assert.deepEqual(checkInPart('x = RAIL_COMPONENTS[1]'), []);
});

test('a dictionary member is not an undeclared array', () => {
	// The guide keeps the two apart: a dictionary "cannot be redeclared as an
	// array or vice versa", so no `DIM` is ever missing here. Both spellings
	// occur, because the lexer breaks a dotted path at a subscript.
	assert.deepEqual(checkInPart('_trapezoid.start.vert[1] = 0'), []);
	assert.deepEqual(checkInPart('x = pbuf.line[i].edge[j].x'), []);
});

test('a VALUES range clause is not a subscript', () => {
	// `RANGE[0, 1]` reads exactly like an array reference. It is a keyword,
	// which is what keeps it out.
	assert.deepEqual(checkInPart('values "iDetailLevel" range[0, 3]', 'vl.gdl'), []);
});

test('outside a library part the check stands down', () => {
	// Without `paramlist.xml` a parameter cannot be told from a typo, and the
	// master script cannot be found either — so nothing here is knowable.
	assert.deepEqual(check('pos_drain[1] = 2'), []);
});

test('more indices than the array has dimensions is an error', () => {
	assert.deepEqual(check('dim myarray[]\nmyarray[1][3] = 1'), [
		'`myarray` is declared with one dimension, so it takes one index, not 2.',
	]);
	assert.deepEqual(check('dim a[3][2]\nx = a[1][2][1]'), [
		'`a` is declared with two dimensions, so it takes two indices, not 3.',
	]);
	// It is reported at every site, unlike the missing declaration: each
	// surplus index is its own typo rather than one absent statement.
	assert.equal(check('dim a[]\na[1][1] = 1\na[2][2] = 1').length, 2);
});

test('fewer indices than declared is idiomatic', () => {
	// The guide allows `var2[i]` and bare `var2` for a two-dimensional array,
	// meaning one row and the whole table.
	assert.deepEqual(check('dim a[3][2]\nx = a[1]'), []);
	assert.deepEqual(check('dim a[3][2]\nput a'), []);
});

test('a dimension count is only ever taken from a DIM', () => {
	// A parameter array's dimensions come from the dialog, and the guide warns
	// a CALL may hand it "an array with arbitrary dimensions" — so
	// `paramlist.xml` cannot settle how many indices are right.
	assert.deepEqual(checkInPart('x = aSegmentWidths[1][2]'), []);
});

test('a parameter that is not an array is reported too', () => {
	// `paramlist.xml` says which parameters are arrays, and a scalar one
	// subscripted anyway is the same leftover as a name that does not exist —
	// `pen_text[i]` in `Maßkettenschablone AOL`, in the same half-finished
	// UI_INFIELD block that supplies four of the corpus's missing names.
	assert.deepEqual(checkInPart('bShowFrame[1] = 0'), [
		'`bShowFrame` is subscripted, but `TestObject` declares it as a plain ' +
			'Boolean parameter, not an array.',
	]);
});

test('a fixed parameter is Archicad\'s, however the part declares it', () => {
	// `ac_bottomlevel` is a scalar Length in this part's list, but the keyword
	// table knows it as a fixed parameter — and the vendored list is an AC27
	// snapshot that will always trail, so those names are never ours to judge.
	assert.deepEqual(checkInPart('x = ac_bottomlevel[1]'), []);
});
