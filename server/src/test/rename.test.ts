/**
 * Rename tests, run against the real HSF fixture in `TestObject/TestObject`.
 *
 * The cases encode the scoping rules that make GDL renaming unusual: sibling
 * scripts are independent namespaces, while the master and parameter scripts
 * reach across the whole library part.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { analyze } from '../gdl/analyzer';
import { tokenize } from '../gdl/lexer';
import { provideRename, RenameError } from '../providers/rename';

const OBJECT_ROOT = join(__dirname, '..', '..', '..', 'TestObject', 'TestObject');
const scriptPath = (name: string) => join(OBJECT_ROOT, 'scripts', name);
const scriptUri = (name: string) => URI.file(scriptPath(name)).toString();

/** Nothing is open in an editor during these tests, so always fall to disk. */
const noOpenDocs = () => undefined;

function renameAt(script: string, symbol: string, newName: string) {
	const uri = scriptUri(script);
	const text = readFileSync(scriptPath(script), 'utf8');

	// Find the symbol as a real identifier token — a plain indexOf would land
	// inside the explanatory comments the fixture is full of.
	const token = tokenize(text).find((t) => t.type === 'identifier' && t.lower === symbol.toLowerCase());
	assert.ok(token, `fixture ${script} should use ${symbol} as an identifier`);

	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideRename(analyze(uri, text), td, td.positionAt(token.start), newName, noOpenDocs);
}

const touched = (edit: { changes?: Record<string, unknown> }) =>
	Object.keys(edit.changes ?? {})
		.map((uri) => URI.parse(uri).fsPath.split('/').slice(-1)[0])
		.sort();

test('a script-local variable renames in that script only', () => {
	// `count` exists in both 2d.gdl and 3d.gdl as unrelated variables.
	const edit = renameAt('3d.gdl', 'count', 'segments');
	assert.deepEqual(touched(edit), ['3d.gdl']);
	// `count = 4`, `to count`, `A / count`, `del count`
	assert.equal(edit.changes![scriptUri('3d.gdl')].length, 4);
});

test('a master-script variable renames across the whole library part', () => {
	// gDetailFactor is defined in 1d.gdl and used in 3d.gdl.
	const edit = renameAt('3d.gdl', 'gDetailFactor', 'gLodFactor');
	assert.deepEqual(touched(edit), ['1d.gdl', '3d.gdl']);
});

test('a parameter renames across scripts, its strings, and paramlist.xml', () => {
	const edit = renameAt('2d.gdl', 'bShowFrame', 'bDrawFrame');
	assert.deepEqual(touched(edit), ['2d.gdl', '3d.gdl', 'paramlist.xml', 'vl.gdl']);

	// vl.gdl mentions it as a bare identifier three times and as `lock "..."`.
	const vl = edit.changes![scriptUri('vl.gdl')];
	assert.equal(vl.length, 4);
});

test('fixed parameters cannot be renamed', () => {
	// `A` carries <Fix/> — Archicad owns the name.
	assert.throws(() => renameAt('2d.gdl', 'A', 'width'), RenameError);
});

test('keywords and globals cannot be renamed', () => {
	assert.throws(() => renameAt('3d.gdl', 'block', 'brick'), RenameError);
	assert.throws(() => renameAt('3d.gdl', 'material', 'surface'), RenameError);
});

test('the new name must be a valid GDL identifier', () => {
	assert.throws(() => renameAt('3d.gdl', 'count', '2fast'), RenameError);
	assert.throws(() => renameAt('3d.gdl', 'count', 'has space'), RenameError);
});

test('the new name must not collide with a GDL name', () => {
	assert.throws(() => renameAt('3d.gdl', 'count', 'CUTPLANE'), RenameError);
	assert.throws(() => renameAt('3d.gdl', 'count', 'WALL_HEIGHT'), RenameError);
});
