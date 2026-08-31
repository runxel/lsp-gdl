/**
 * Jump-label checks for `GOSUB` and `GOTO`.
 *
 * A jump to a label that does not exist stops the object, reachable or not, so
 * this is one of the few checks that is an outright error. The corpus reports
 * three hits across 2448 files — two rename leftovers in one UI script and one
 * in a 2D script — so, as with `commas.ts` and `operators.ts`, the cases here
 * carry most of the proof that it still fires.
 *
 * The two collision checks are the other way round: 2458 corpus files hold no
 * label defined twice and none sharing a name with the master script, so the
 * cases here carry the whole proof that they fire at all.
 *
 * Every shape below is one the corpus actually holds.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity } from 'vscode-languageserver/node';
import { analyze } from '../gdl/analyzer';
import { provideLabelDiagnostics } from '../providers/labels';
import { invalidateMasterScriptCache, type TextResolver } from '../gdl/masterScript';

const FIXTURES = join(__dirname, '..', '..', '..', 'TestObject');
const uriFor = (script: string) =>
	URI.file(join(FIXTURES, 'TestObject', 'scripts', script)).toString();

const NO_TEXT: TextResolver = () => undefined;

function checkFull(text: string, script = '3d.gdl', resolve: TextResolver = NO_TEXT) {
	invalidateMasterScriptCache();
	const uri = uriFor(script);
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideLabelDiagnostics(analyze(uri, text), td, resolve);
}

function check(text: string, script = '3d.gdl', resolve: TextResolver = NO_TEXT) {
	return checkFull(text, script, resolve).map((d) => d.message);
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
	// Numeric labels match by value.
	assert.deepEqual(check('gosub 100\nend\n0100:\nreturn'), []);
});

test('a named label is matched as the string literal it is', () => {
	// Confirmed by the project owner, and the one place GDL is not
	// case-insensitive: `"tapPage":` and `GOSUB "TAPPAGE"` are two different
	// names, so the jump reaches nothing at all. The near-miss is named in the
	// message, that being much likelier a typo than a coincidence.
	const messages = check('gosub "TAPPAGE"\nend\n"tapPage":\nreturn');
	assert.equal(messages.length, 1);
	assert.match(messages[0], /No label `TAPPAGE`/);
	assert.match(messages[0], /`tapPage` differs only in case/);
	// With no such label anywhere, there is nothing to point at.
	assert.doesNotMatch(check('gosub "gone"\nend\n"tapPage":\nreturn')[0], /differs only in case/);
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

test('a label defined twice in one script is an error', () => {
	// Confirmed by the project owner: a reused label is a hard failure. Archicad
	// detects it and the object does not run, so this is an error rather than a
	// remark about dead code.
	const [diagnostic, ...rest] = checkFull('gosub "draw"\nend\n"draw":\nreturn\n"draw":\nreturn');
	assert.deepEqual(rest, []);
	assert.equal(diagnostic.severity, DiagnosticSeverity.Error);
	assert.match(diagnostic.message, /Label `draw` is already defined in this script, at line 3/);
	assert.match(diagnostic.message, /stops the object/);
	// The jump itself is not reported as well — the label does exist.
	assert.doesNotMatch(diagnostic.message, /No label/);
});

test('a numeric label spelt two ways is one reused label', () => {
	// `0100:` answers `GOSUB 100`, so this is the same label defined twice.
	const messages = check('goto 100\nend\n0100:\nreturn\n100:\nreturn');
	assert.equal(messages.length, 1);
	assert.match(messages[0], /`0100` and `100` are one label: a numeric label is matched by value\./);
	// Spelt identically, there is nothing to explain.
	assert.doesNotMatch(check('"draw":\nreturn\n"draw":\nreturn')[0], /are one label/);
});

test('two named labels differing only in case are a warning, not a reuse', () => {
	// GDL keeps them apart — they are string literals — so nothing is broken.
	// A reader cannot keep them apart, which is the whole of the complaint.
	const [diagnostic] = checkFull('gosub "TapPage"\nend\n"TapPage":\nreturn\n"tappage":\nreturn');
	assert.equal(diagnostic.severity, DiagnosticSeverity.Warning);
	assert.match(
		diagnostic.message,
		/Label `tappage` differs from `TapPage` at line 3 only in case\./,
	);
	assert.match(diagnostic.message, /two subroutines, and no jump can reach both/);
});

test('a third definition is reported too, always against the first', () => {
	const messages = check('"draw":\nreturn\n"draw":\nreturn\n"draw":\nreturn');
	assert.equal(messages.length, 2);
	for (const message of messages) assert.match(message, /at line 1\./);
});

test('two labels of different names are left alone', () => {
	assert.deepEqual(check('"draw":\nreturn\n"erase":\nreturn'), []);
	assert.deepEqual(check('100:\nreturn\n200:\nreturn'), []);
});

test('a label repeated outside a library part is still reported', () => {
	// Unlike the missing-label check, this one needs nothing from the part.
	const uri = URI.file(join(FIXTURES, 'scratch', 'scripts', '3d.gdl')).toString();
	const text = '"draw":\nreturn\n"draw":\nreturn';
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	const messages = provideLabelDiagnostics(analyze(uri, text), td, NO_TEXT);
	assert.equal(messages.length, 1);
	assert.match(messages[0].message, /already defined in this script/);
});

test('a label the master script also defines is the same reuse', () => {
	// The master runs before this script, so by the time labels are resolved
	// the name is defined twice in one program — the same hard failure.
	const master = '"shared - init":\nreturn';
	const resolve: TextResolver = (uri) => (uri === uriFor('1d.gdl') ? master : undefined);

	const [diagnostic, ...rest] = checkFull(
		'gosub "shared - init"\nend\n"shared - init":\nreturn',
		'3d.gdl',
		resolve,
	);
	assert.deepEqual(rest, []);
	assert.equal(diagnostic.severity, DiagnosticSeverity.Error);
	assert.match(
		diagnostic.message,
		/Label `shared - init` is also defined in the master script, at line 1/,
	);
	assert.match(diagnostic.message, /stops the object/);
	// A name the master does not define is nobody's business.
	assert.deepEqual(check('"local only":\nreturn', '3d.gdl', resolve), []);
});

test('a name differing from the master\'s only in case is a warning', () => {
	const resolve: TextResolver = (uri) =>
		uri === uriFor('1d.gdl') ? '"Shared - Init":\nreturn' : undefined;

	const [diagnostic] = checkFull('"shared - init":\nreturn', '3d.gdl', resolve);
	assert.equal(diagnostic.severity, DiagnosticSeverity.Warning);
	assert.match(
		diagnostic.message,
		/differs from `Shared - Init` in the master script, at line 1, only in case/,
	);
});

test('the master script is not judged against itself', () => {
	// Nothing runs before `1d.gdl`, so it can collide with no other script.
	assert.deepEqual(check('"shared - init":\nreturn', '1d.gdl'), []);
});
