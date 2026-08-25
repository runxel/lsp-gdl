/**
 * Rename tests, run against the real HSF fixture in `TestObject/TestObject`.
 *
 * The cases encode the scoping rules that make GDL renaming unusual: sibling
 * scripts are independent namespaces, while the master and parameter scripts
 * reach across the whole library part — and groups, which scope the other way
 * again, never leaving the one script.
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

/** As `renameAt`, but landing the cursor on a string literal instead. */
function renameStringAt(script: string, literal: string, newName: string) {
	const uri = scriptUri(script);
	const text = readFileSync(scriptPath(script), 'utf8');

	const token = tokenize(text).find(
		(t) => t.type === 'string' && t.text.slice(1, -1).toLowerCase() === literal.toLowerCase(),
	);
	assert.ok(token, `fixture ${script} should hold the string ${literal}`);

	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideRename(analyze(uri, text), td, td.positionAt(token.start + 1), newName, noOpenDocs);
}

/**
 * A rename over a script written out here rather than the fixture. Group scope
 * stops at the file, so nothing on disk is needed — and the shapes worth
 * pinning down, a group name spelt again as prose among them, do not belong in
 * a demo object whose geometry someone actually looks at.
 */
const SCRATCH_URI = 'file:///scratch/3d.gdl';

function renameInText(text: string, cursorAt: string, newName: string) {
	const offset = text.indexOf(cursorAt);
	assert.ok(offset >= 0, `the script should contain ${cursorAt}`);
	const td = TextDocument.create(SCRATCH_URI, 'gdl-hsf', 1, text);
	return provideRename(analyze(SCRATCH_URI, text), td, td.positionAt(offset + 1), newName, noOpenDocs);
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

// --- groups ------------------------------------------------------------------

test('a string-named group renames every place the script names it', () => {
	// `gr_leg` is defined, fed to `subgroup` and killed — three group positions.
	const edit = renameStringAt('3d.gdl', 'gr_leg', 'gr_post');
	assert.deepEqual(touched(edit), ['3d.gdl']);

	const edits = edit.changes![scriptUri('3d.gdl')];
	assert.equal(edits.length, 3);
	// The edit lands inside the quotes, so the delimiter the author chose stays.
	assert.ok(edits.every((e) => e.newText === 'gr_post'));
});

test('a group named by a variable renames as the variable it is', () => {
	// `grLeg` holds a subgroup result: the assignment and the `placegroup`.
	const edit = renameAt('3d.gdl', 'grLeg', 'grPost');
	assert.deepEqual(touched(edit), ['3d.gdl']);
	assert.equal(edit.changes![scriptUri('3d.gdl')].length, 2);
});

test('a matching string that is not a group is left alone', () => {
	const edit = renameInText(
		[
			'group "gr_leg"',
			'\tblock 0.05, 0.05, 0.4',
			'endgroup',
			'placegroup "gr_leg"',
			'text2 0, 0, "gr_leg"\t\t! prose, not a group',
		].join('\n'),
		'"gr_leg"',
		'gr_post',
	);
	assert.equal(edit.changes![SCRATCH_URI].length, 2);
});

test('a group name may hold spaces, being a string and not an identifier', () => {
	const edit = renameInText(
		'group "gr_leg"\nendgroup\nplacegroup "gr_leg"',
		'"gr_leg"',
		'front left leg',
	);
	const edits = edit.changes![SCRATCH_URI];
	assert.equal(edits.length, 2);
	assert.equal(edits[0].newText, 'front left leg');
});

test('a group name may not close its own literal', () => {
	const script = 'group "gr_leg"\nendgroup\nplacegroup "gr_leg"';
	assert.throws(() => renameInText(script, '"gr_leg"', 'gr"post'), RenameError);
	assert.throws(() => renameInText(script, '"gr_leg"', ''), RenameError);
});

test('a group cannot be renamed onto another group of the same script', () => {
	// The guide requires the names unique per script; merging two silently
	// would place one set of bodies where two were meant.
	const script = [
		'group "gr_leg"',
		'endgroup',
		'group "gr_notch"',
		'endgroup',
		'placegroup subgroup("gr_leg", "gr_notch")',
	].join('\n');
	assert.throws(() => renameInText(script, '"gr_leg"', 'gr_notch'), RenameError);
	// Its own name in another case is not a clash — that is a re-spelling.
	assert.equal(renameInText(script, '"gr_leg"', 'GR_Leg').changes![SCRATCH_URI].length, 2);
});

test('a string that names nothing still cannot be renamed', () => {
	assert.throws(() => renameInText('text2 0, 0, "hello"', '"hello"', 'goodbye'), RenameError);
});

test('a group name tabulated into a variable renames with the group', () => {
	// Real corpus shape: the group name is picked out of a table at run time,
	// so the string naming it sits in an assignment with no group keyword in
	// sight. Missing it would leave `placegroup` pointing at nothing.
	const edit = renameInText(
		[
			'group "gr_leg"',
			'\tblock 0.05, 0.05, 0.4',
			'endgroup',
			'gr_out[1] = "gr_leg"',
			'if bMirror then gr_toplace = "gr_leg"',
			'placegroup gr_out[i]',
			'placegroup gr_toplace',
		].join('\n'),
		'"gr_leg"',
		'gr_post',
	);
	assert.equal(edit.changes![SCRATCH_URI].length, 3);
});

test('a comparison against a group variable is not an assignment', () => {
	const edit = renameInText(
		[
			'group "gr_leg"',
			'endgroup',
			'gr_toplace = "gr_leg"',
			'if gr_toplace = "gr_leg" then addz 1',
			'placegroup gr_toplace',
		].join('\n'),
		'"gr_leg"',
		'gr_post',
	);
	// The `group` line and the assignment — not the `if`, which asks a question.
	assert.equal(edit.changes![SCRATCH_URI].length, 2);
});

test('a string held by a variable that is never a group stays a string', () => {
	const edit = renameInText(
		'group "gr_leg"\nendgroup\nsCaption = "gr_leg"\nplacegroup "gr_leg"',
		'"gr_leg"',
		'gr_post',
	);
	assert.equal(edit.changes![SCRATCH_URI].length, 2);
});
