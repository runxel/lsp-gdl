/**
 * An attribute command handed a name nothing gives a value.
 *
 * Every case runs inside `TestObject`, since the check stands down outside a
 * library part: `matBody` and `iDetailLevel` are its parameters, and its master
 * script assigns `gDetailFactor` and `DIR_ALIGNED`.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { URI as Uri } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideAttributeDiagnostics } from '../providers/attributes';

const FIXTURES = join(__dirname, '..', '..', '..', 'TestObject');
const partUri = (script: string) =>
	Uri.file(join(FIXTURES, 'TestObject', 'scripts', script)).toString();

function check(text: string, script = '3d.gdl'): string[] {
	const uri = partUri(script);
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideAttributeDiagnostics(analyze(uri, text), td).map((d) => d.message);
}

/** Just the names reported, in order. */
function names(text: string, script = '3d.gdl'): string[] {
	return check(text, script).map((m) => m.split('`')[1]);
}

test('an undeclared name handed to PEN is reported', () => {
	assert.deepEqual(check('pen foobar'), [
		'`foobar` is never given a value: nothing in reach of this script assigns it, ' +
			'and `TestObject` has no parameter of that name, so `PEN` reads it as 0.',
	]);
});

test('every attribute command is judged, with or without SET', () => {
	assert.deepEqual(names('material m1\nset material m2\nfill f\nset fill f2'), ['m1', 'm2', 'f', 'f2']);
	assert.deepEqual(names('line_type lt\nset line_type lt2\nstyle s\nset style s2', '2d.gdl'), [
		'lt',
		'lt2',
		's',
		's2',
	]);
	assert.deepEqual(names('building_material bm, DEFAULT, p\nset building_material bm2'), ['bm', 'p', 'bm2']);
	assert.deepEqual(names('sect_fill f, p1, p2, p3'), ['f', 'p1', 'p2', 'p3']);
	assert.deepEqual(names('sect_attrs{2} p, lt'), ['p', 'lt']);
});

test('every site is reported, not only the first', () => {
	assert.deepEqual(names('pen foobar\nline 0, 0, 0, 1, 1, 1\npen foobar'), ['foobar', 'foobar']);
});

test('a parameter needs no assignment', () => {
	assert.deepEqual(check('material matBody'), []);
	// Case-insensitive, as everywhere but a jump label.
	assert.deepEqual(check('material MATBODY'), []);
});

test('a name written anywhere in the script counts, after the use included', () => {
	assert.deepEqual(check('p = 3\npen p'), []);
	// Source order is not execution order once GOSUB is in play.
	assert.deepEqual(check('gosub "setup"\npen p\nend\n"setup":\np = 3\nreturn'), []);
	assert.deepEqual(check('for p = 1 to 3\npen p\nnext p'), []);
	assert.deepEqual(check('let p = 3\npen p'), []);
	assert.deepEqual(check('dim pens[]\npens[1] = 3\npen pens[1]'), []);
	assert.deepEqual(check('dict d\npen d.pen'), []);
});

test('a name filled in by a call counts as written', () => {
	assert.deepEqual(check('n = REQUEST ("PEN_OF_RGB", "1 1 1", _white)\npen _white'), []);
	assert.deepEqual(check('call "m" parameters returned_parameters _p\npen _p'), []);
	assert.deepEqual(check('n = INPUT (ch, "", 1, _p)\npen _p'), []);
});

test('a name written by the master script counts', () => {
	assert.deepEqual(check('pen gDetailFactor'), []);
	assert.deepEqual(check('pen DIR_ALIGNED', '2d.gdl'), []);
});

test('a sibling script is not in reach', () => {
	// `3d.gdl` and `2d.gdl` are independent; only the master and `vl` reach.
	// `TestObject/3d.gdl` assigns `nWidth` on disk, and 2D cannot see it.
	assert.deepEqual(names('pen nWidth', '2d.gdl'), ['nWidth']);
});

test('globals, fixed parameters and functions are Archicad’s', () => {
	assert.deepEqual(check('pen GLOB_CONTEXT'), []);
	assert.deepEqual(check('material IND (MATERIAL, "Brick")'), []);
	assert.deepEqual(check('pen max (1, gDetailFactor)'), []);
});

test('an attribute defined under a bare name is a name, not a variable', () => {
	// `02_ling` and `Öffnung polygonal` both do this, and a `REQUEST` in
	// `02_ling` names the same style as a quoted string.
	assert.deepEqual(check('define style myStyle Arial, 2, 1, 0\nstyle myStyle', '2d.gdl'), []);
	assert.deepEqual(check('define style{2} myStyle Arial, 2, 1, 0\nset style myStyle', '2d.gdl'), []);
	assert.deepEqual(check('define material "glass" 0, 1, 1, 1\nmaterial glass'), []);
	assert.deepEqual(check('if a then define fill myFill 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1\nfill myFill'), []);
});

test('every identifier in the arguments is judged', () => {
	assert.deepEqual(names('pen pens[i]'), ['pens', 'i']);
	assert.deepEqual(names('pen 1 + offset'), ['offset']);
	// The head of a dotted path is the variable, and is what is named.
	assert.deepEqual(names('pen d.pen'), ['d']);
	// A member after a subscript is a key of the dictionary, not a variable.
	assert.deepEqual(names('dict d\npen d.f[1].pen'), []);
});

test('literals carry nothing to judge', () => {
	assert.deepEqual(check('pen 3\nmaterial "Brick"\nset fill `Solid`'), []);
});

test('the command may stand in any clause, and ends with it', () => {
	assert.deepEqual(names('if iDetailLevel > 1 then pen foo else pen bar'), ['foo', 'bar']);
	// `then` and `else` are not arguments.
	assert.deepEqual(names('if iDetailLevel > 1 then pen 3 else material matBody'), []);
});

test('DEFINE heads a definition, not the current attribute', () => {
	assert.deepEqual(check('define material mat 0, 1, 1, 1'), []);
	assert.deepEqual(check('define fill f 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1'), []);
	assert.deepEqual(check('define style s Arial, 2, 1, 0', '2d.gdl'), []);
	// Nor is the keyword a command anywhere else in a statement.
	assert.deepEqual(check('call "m" parameters material = undeclaredHere'), []);
});

test('assigning to the keyword is not the command', () => {
	// `reservedNames.ts` reports this; it is not an attribute being set.
	assert.deepEqual(check('pen = foobar'), []);
});

test('outside a library part the check stands down', () => {
	const uri = 'file:///nowhere/scripts/3d.gdl';
	const text = 'pen foobar';
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	assert.deepEqual(provideAttributeDiagnostics(analyze(uri, text), td), []);
});

test('the range covers the variable, not the members after it', () => {
	const uri = partUri('3d.gdl');
	const text = 'pen  _cfg.pen';
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	const [d] = provideAttributeDiagnostics(analyze(uri, text), td);
	assert.deepEqual(d.range, { start: { line: 0, character: 5 }, end: { line: 0, character: 9 } });
});
