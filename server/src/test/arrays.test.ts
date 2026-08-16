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
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideArrayDiagnostics } from '../providers/arrays';

const URI = 'file:///Obj/scripts/3d.gdl';

function check(text: string): string[] {
	const td = TextDocument.create(URI, 'gdl-hsf', 1, text);
	return provideArrayDiagnostics(analyze(URI, text), td).map((d) => d.message);
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
