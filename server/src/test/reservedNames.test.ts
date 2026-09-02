/**
 * A GDL keyword claimed as a variable name.
 *
 * Like the comma, operator and bracket checks, this reports nothing across the
 * corpus — 151483 assignment targets and 4529 loop variables, none of them a
 * keyword — so these tests carry the whole burden of proving it still fires.
 * Every "not flagged" case below is a shape taken from real library code, and
 * the kinds deliberately left alone are each worth thousands of assignments in
 * that corpus.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideReservedNameDiagnostics } from '../providers/reservedNames';

const URI = 'file:///Obj/scripts/3d.gdl';

function check(text: string, uri = URI): string[] {
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideReservedNameDiagnostics(analyze(uri, text), td).map((d) => d.message);
}

// --- the shape this exists for ----------------------------------------------

test('a command used as a variable name is flagged', () => {
	assert.deepEqual(check('addx = foo + bar'), [
		'`ADDX` is a GDL command and cannot be used as a variable name.',
	]);
});

test('the canonical spelling is reported, whatever the author typed', () => {
	// GDL is case-insensitive, so the message names the keyword as the guide
	// spells it rather than echoing the mistake back.
	assert.deepEqual(check('AddX = 1'), [
		'`ADDX` is a GDL command and cannot be used as a variable name.',
	]);
});

test('a function and a word operator are flagged too', () => {
	assert.deepEqual(check('str = "abc"'), [
		'`STR` is a GDL function and cannot be used as a variable name.',
	]);
	// `AND`, `OR`, `MOD` and `EXOR` are identifiers to the lexer, which is
	// exactly why they are easy to reach for and just as reserved.
	assert.deepEqual(check('mod = 4'), [
		'`mod` is a GDL operator and cannot be used as a variable name.',
	]);
});

test('a reserved keyword says so in its own words', () => {
	// The guide's *Reserved Keywords* section: 28 names that "exist for
	// compatibility reasons or are not publicized" — no command anyone would
	// write, and taken all the same.
	assert.deepEqual(check('node = 3'), [
		'`NODE` is a reserved GDL keyword and cannot be used as a variable name.',
	]);
});

// --- every form that claims a name ------------------------------------------

test('an indexed or dotted target is judged by its head', () => {
	assert.deepEqual(check('pen[1] = 3'), [
		'`PEN` is a GDL command and cannot be used as a variable name.',
	]);
	// A dotted name lexes as one token and only its leading segment is a
	// variable of this script — the same half rename rewrites.
	assert.deepEqual(check('str.start = 1'), [
		'`STR` is a GDL function and cannot be used as a variable name.',
	]);
	// `_drods.f[1].gr` is the real corpus shape: subscripts and members mixed.
	assert.deepEqual(check('text.f[1].gr = "x"'), [
		'`TEXT` is a GDL command and cannot be used as a variable name.',
	]);
});

test('a FOR loop variable is a definition', () => {
	assert.deepEqual(check('for str = 1 to 5\nnext str'), [
		'`STR` is a GDL function and cannot be used as a variable name.',
	]);
});

test('LET is the legacy spelling of an assignment', () => {
	// ACLib's `Patch_Template/2d.gdl` writes `let textheight=0.005`.
	assert.deepEqual(check('let mesh = 0.005'), [
		'`MESH` is a GDL command and cannot be used as a variable name.',
	]);
});

test('a clause after THEN or ELSE is judged as well', () => {
	assert.deepEqual(check('if a then addx = 1'), [
		'`ADDX` is a GDL command and cannot be used as a variable name.',
	]);
	assert.deepEqual(check('if a then x = 1 else pen = 2'), [
		'`PEN` is a GDL command and cannot be used as a variable name.',
	]);
});

test('every claim in a statement is reported, not just the first', () => {
	assert.deepEqual(check('if a then addx = 1 else str = 2'), [
		'`ADDX` is a GDL command and cannot be used as a variable name.',
		'`STR` is a GDL function and cannot be used as a variable name.',
	]);
});

// --- `=` is both operators --------------------------------------------------

test('a comparison is not a claim', () => {
	// The trap that produced 3000+ bogus warnings in `typecheck.ts`: a single
	// `=` is assignment in one clause and equality in the next.
	assert.deepEqual(check('if pen = 3 then a = 1'), []);
	assert.deepEqual(check('if str(x, 1, 0) = "1" then a = 1'), []);
	assert.deepEqual(check('while pen = 3 do'), []);
});

test('a command called as a command is not a claim', () => {
	assert.deepEqual(check('addx 1'), []);
	assert.deepEqual(check('pen 3'), []);
	assert.deepEqual(check('addx dx, dy'), []);
	// A subscript on the *value* side must not be mistaken for the target's.
	assert.deepEqual(check('material mat[i]'), []);
});

// --- the kinds deliberately left alone --------------------------------------

test('a global may be assigned — the guide says so', () => {
	// "By using the "=" command, you can assign a numeric or string value to
	// local and global variables." `GLOB_USER_1`…`_20` exist to be written,
	// and ACLib's `Simple Door Opening/1d.gdl` swaps the WIDO_ jambs through a
	// temporary to mirror a reveal. 101 corpus assignments, none a mistake.
	assert.deepEqual(check('glob_user_1 = 2'), []);
	assert.deepEqual(check('temp = wido_right_jamb\nwido_right_jamb = wido_left_jamb\nwido_left_jamb = temp'), []);
});

test('a fixed parameter may be assigned — it is an ordinary parameter', () => {
	// "Within a script, the same rules apply to parameters as to local
	// variables." 1397 corpus assignments: `A`, `B`, `ZZYZX`, the `ifc_*`
	// outputs a door writes for the IFC export.
	assert.deepEqual(check('A = 1'), []);
	assert.deepEqual(check('zzyzx = 2.4'), []);
	assert.deepEqual(check('ac_bottomlevel = 0'), []);
	assert.deepEqual(check('ifc_LiningDepth = d'), []);
});

test('a name that merely resembles a keyword is left alone', () => {
	assert.deepEqual(check('addx_offset = 1'), []);
	assert.deepEqual(check('_pen = 3'), []);
	assert.deepEqual(check('penWidth = 3'), []);
});

// --- PARAMETERS addresses a list, not a variable ----------------------------

test('PARAMETERS names a parameter list and is skipped whole', () => {
	// This part's own list — `paramRefs.ts` checks those names against
	// `paramlist.xml`, which is the right check for them.
	assert.deepEqual(check('parameters pen = 3'), []);
	// And after `CALL`, the *macro's* list, which this object cannot see at
	// all. A macro parameter is routinely named after a command.
	assert.deepEqual(check('call "m", parameters material = 3, pen = 4'), []);
});

// --- degrading gracefully ---------------------------------------------------

test('an unbalanced subscript is left to the bracket check', () => {
	assert.deepEqual(check('pen[1 = 3'), []);
});

test('a keyword in an ordinary expression is untouched', () => {
	assert.deepEqual(check('a = sin(x) + str(y, 1, 0)'), []);
	assert.deepEqual(check('a = b mod 4'), []);
	assert.deepEqual(check('gosub "node"'), []);
});
