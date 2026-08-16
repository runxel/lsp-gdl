/**
 * Parameter-reference checks for `PARAMETERS`, `LOCK`, `HIDEPARAMETER` and
 * `VALUES`.
 *
 * `paramlist.xml` is the ground truth: inherited parameters arrive in it as
 * fixed entries, so a name missing from it does not exist on the object.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideParameterRefDiagnostics } from '../providers/paramRefs';

const FIXTURES = join(__dirname, '..', '..', '..', 'TestObject');
const uriFor = (object: string, script: string) =>
	URI.file(join(FIXTURES, object, 'scripts', script)).toString();

function check(text: string, script = 'vl.gdl') {
	const uri = uriFor('TestObject', script);
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideParameterRefDiagnostics(analyze(uri, text), td).map((d) => d.message);
}

test('a parameter that does not exist is reported', () => {
	assert.deepEqual(check('lock "bShowFrmae"'), [
		'`bShowFrmae` is not a parameter of `TestObject`, so this LOCK has no effect.',
	]);
	assert.match(check('hideparameter "iDetailLvl"')[0], /HIDEPARAMETER has no effect/);
	assert.match(check('parameters nSegments = 4')[0], /PARAMETERS has no effect/);
});

test('parameters that do exist are accepted', () => {
	assert.deepEqual(check('lock "bShowFrame"'), []);
	assert.deepEqual(check('hideparameter "matBody"'), []);
	assert.deepEqual(check('parameters zzyzx = 2.0'), []);
	// Case-insensitive, like the rest of GDL.
	assert.deepEqual(check('lock "BSHOWFRAME"'), []);
});

test('the names after ALL are exceptions, and are checked too', () => {
	assert.deepEqual(check('lock all "A", "B"'), []);
	assert.deepEqual(check('hideparameter all "bShowFrame"'), []);
	assert.match(check('lock all "notAParam"')[0], /not a parameter/);
	// A bare ALL names nothing.
	assert.deepEqual(check('lock all'), []);
});

test('names that cannot be resolved are left alone', () => {
	// The guide calls these "string expressions", so they may be computed.
	assert.deepEqual(check('lock "prefix_" + STR(iDetailLevel, 1, 0)'), []);
	assert.deepEqual(check('lock paramNameVariable'), []);
});

test('fix named parameters are always accepted', () => {
	// Known to the keyword table...
	assert.deepEqual(check('lock "ac_bottomlevel"'), []);
	// ...and anything else on Archicad's reserved `ac_` prefix, since the
	// vendored keyword list is an AC27 snapshot.
	assert.deepEqual(check('hideparameter "ac_mep_connectionpage_active"'), []);
});

test('only the master and parameter scripts are checked', () => {
	// Migration scripts move values between versions of the object, so they
	// legitimately name parameters the current paramlist.xml does not have.
	assert.deepEqual(check('parameters nSegments = 4', 'fwm.gdl'), []);
	assert.deepEqual(check('parameters nSegments = 4', 'bwm.gdl'), []);
	assert.deepEqual(check('parameters nSegments = 4', '2d.gdl'), []);
	// The master script is checked.
	assert.match(check('parameters nSegments = 4', '1d.gdl')[0], /not a parameter/);
});

test('a macro call is not a PARAMETERS statement', () => {
	// These name the *macro's* parameters, not this object's.
	assert.deepEqual(check('call "SomeMacro" parameters nSegments = 4, other = 1'), []);
});

test('VALUES checks its first argument only', () => {
	assert.deepEqual(check('values "iDetailLevel" 1, 2, 3'), []);
	assert.match(check('values "iDetailLvl" 1, 2, 3')[0], /VALUES has no effect/);
	// The comma after the name is optional in GDL.
	assert.match(check('values "iDetailLvl", 1, 2, 3')[0], /VALUES has no effect/);

	// The value list must NOT be treated as parameter names, even when the
	// values are strings.
	assert.deepEqual(check('values "matBody" "brick", "timber", "steel"'), []);
});

test('VALUES{2} pairs values with descriptions, and only names one parameter', () => {
	assert.deepEqual(check('values{2} "iDetailLevel" 1, "low", 2, "high"'), []);
	assert.match(check('values{2} "nope" 1, "low"')[0], /VALUES\{2\} has no effect/);
});

test('VALUES sub-clauses and computed names are handled', () => {
	assert.deepEqual(check('values "bShowFrame" range [0, 1]'), []);
	assert.deepEqual(check('values "iDetailLevel" 1, 2, custom'), []);
	// A name built from an expression cannot be resolved.
	assert.deepEqual(check('values "order_" + STR(iDetailLevel, 1, 0) 1, 2'), []);
});
