/**
 * Jump-label checks for `GOSUB` and `GOTO`.
 *
 * A jump to a label that does not exist stops the object, reachable or not, so
 * this is one of the few checks that is an outright error. The corpus reports
 * three hits across 2448 files — two rename leftovers in one UI script and one
 * in a 2D script — so, as with `commas.ts` and `operators.ts`, the cases here
 * carry most of the proof that it still fires.
 *
 * Every shape below is one the corpus actually holds.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideLabelDiagnostics } from '../providers/labels';
import { invalidateMasterScriptCache, type TextResolver } from '../gdl/masterScript';

const FIXTURES = join(__dirname, '..', '..', '..', 'TestObject');
const uriFor = (script: string) =>
	URI.file(join(FIXTURES, 'TestObject', 'scripts', script)).toString();

const NO_TEXT: TextResolver = () => undefined;

function check(text: string, script = '3d.gdl', resolve: TextResolver = NO_TEXT) {
	invalidateMasterScriptCache();
	const uri = uriFor(script);
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideLabelDiagnostics(analyze(uri, text), td, resolve).map((d) => d.message);
}

test('a jump to a label that does not exist is reported', () => {
	// `Wandarmatur AOL/2d.gdl`: the routine was renamed, the call was not.
	assert.match(
		check('gosub "simple tap style"\nend\n"simple wall mounted":\nreturn')[0],
		/No label `simple tap style` in this script or the master script/,
	);
	assert.match(check('goto 250\nend\n100:\nreturn')[0], /No label `250`/);
});

test('both label spellings answer a jump', () => {
	assert.deepEqual(check('gosub "tapPage"\nend\n"tapPage":\nreturn'), []);
	assert.deepEqual(check('gosub 100\nend\n100:\nreturn'), []);
	assert.deepEqual(check('goto 100\nend\n100:\nreturn'), []);
	// Case-insensitive, like everything else in GDL.
	assert.deepEqual(check('gosub "TAPPAGE"\nend\n"tapPage":\nreturn'), []);
	// Numeric labels match by value.
	assert.deepEqual(check('gosub 100\nend\n0100:\nreturn'), []);
});

test('a label may share its line with the code that follows it', () => {
	// `500: LINE2 0, -body_wid, 0` — the label still defines the routine.
	assert.deepEqual(check('gosub 500\nend\n500:\tline2 0, -0.1, 0\nreturn'), []);
	assert.deepEqual(check('gosub "draw"\nend\n"draw": line2 0, 0, 1, 1\nreturn'), []);
});

test('a label defined further down still answers', () => {
	// Labels are resolved before the script runs, so order does not matter.
	assert.deepEqual(check('gosub "late"\nend\n"late":\nreturn'), []);
});

test('a jump anywhere in a statement is checked', () => {
	// `IF gs_tap_type_m <> -1 THEN GOSUB ... ELSE GOSUB "simple tap style"`.
	assert.equal(check('if a then gosub "here" else gosub "gone"\nend\n"here":\nreturn').length, 1);
	assert.deepEqual(check('if a then gosub "here"\nend\n"here":\nreturn'), []);
	// A second statement on the line, past the colon separator.
	assert.equal(check('addx 1 : gosub "gone"\nend\n"here":\nreturn').length, 1);
});

test('a computed target is left alone', () => {
	// The guide calls the label a string or numeric *expression*, and the
	// corpus takes it at its word. None of these can be resolved statically.
	assert.deepEqual(check('gosub 10 + idx'), []);
	assert.deepEqual(check('gosub i_type * 10'), []);
	assert.deepEqual(check('gosub _subid[type_head_1]'), []);
	assert.deepEqual(check('gosub "fixing" + str(iEdge, 1, 0)'), []);
	assert.deepEqual(check('gosub use_form'), []);
	// A bare `gosub` with nothing after it is `operators.ts`' business.
	assert.deepEqual(check('gosub'), []);
});

test('the master script answers a jump from another script', () => {
	const master = 'gosub "shared - init"\nend\n"shared - init":\nreturn';
	const resolve: TextResolver = (uri) => (uri === uriFor('1d.gdl') ? master : undefined);

	assert.deepEqual(check('gosub "shared - init"', '3d.gdl', resolve), []);
	// ...but a sibling script does not. Only the master reaches across.
	const sibling: TextResolver = (uri) =>
		uri === uriFor('1d.gdl') ? '' : 'gosub "x"\n"only in 2d":\nreturn';
	assert.equal(check('gosub "only in 2d"', '3d.gdl', sibling).length, 1);
});

test('the master script answers only for itself', () => {
	// Nothing runs before `1d.gdl`, so its jumps must resolve in its own text.
	assert.match(check('gosub "gone"', '1d.gdl')[0], /No label `gone` in this script\./);
	assert.deepEqual(check('gosub "here"\nend\n"here":\nreturn', '1d.gdl'), []);
});

test('outside a library part nothing is reported', () => {
	// The master script cannot be found, so the label may well exist there.
	const uri = URI.file(join(FIXTURES, 'scratch', 'scripts', '3d.gdl')).toString();
	const td = TextDocument.create(uri, 'gdl-hsf', 1, 'gosub "gone"');
	assert.deepEqual(provideLabelDiagnostics(analyze(uri, 'gosub "gone"'), td, NO_TEXT), []);
});
