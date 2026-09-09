/**
 * A variable written and never read.
 *
 * Every "not flagged" case below is a shape the corpus holds, and each is a
 * grey line through working code if the rule behind it is dropped: the master
 * script publishing downward, the master's subroutines reading upward, the
 * counter of a `FOR` that is only counting, and the several ways a name in a
 * GDL statement turns out not to be a variable at all.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { DiagnosticSeverity, DiagnosticTag } from 'vscode-languageserver/node';
import { analyze } from '../gdl/analyzer';
import { provideUnusedDiagnostics } from '../providers/unused';

// A path with no `paramlist.xml` above it, so the library part is absent and
// only the single-script rules are exercised.
const URI = 'file:///Obj/scripts/3d.gdl';

function check(text: string, uri = URI): string[] {
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideUnusedDiagnostics(analyze(uri, text), td).map((d) => d.message);
}

// --- the shape this exists for ----------------------------------------------

test('a variable computed and never read is flagged', () => {
	assert.deepEqual(check('_oldOffset = wallThk / 2\nADDZ 1'), [
		'`_oldOffset` is assigned but never read.',
	]);
});

test('it is a hint tagged Unnecessary, so the editor greys it', () => {
	const text = '_leftover = A * 2';
	const td = TextDocument.create(URI, 'gdl-hsf', 1, text);
	const [d] = provideUnusedDiagnostics(analyze(URI, text), td);
	assert.equal(d.severity, DiagnosticSeverity.Hint);
	assert.deepEqual(d.tags, [DiagnosticTag.Unnecessary]);
});

test('every write is greyed, not only the first', () => {
	// Reporting once per name read as the check being broken when `arrays.ts`
	// tried it; a later assignment carrying no fade looks deliberate.
	assert.deepEqual(check('_t = A * 2\nADDZ 1\n_t = A * 3'), [
		'`_t` is assigned but never read.',
		'`_t` is assigned but never read.',
	]);
});

test('the range covers only the leading segment of a dotted target', () => {
	const text = '_drods.f = A / 2';
	const td = TextDocument.create(URI, 'gdl-hsf', 1, text);
	const [d] = provideUnusedDiagnostics(analyze(URI, text), td);
	assert.deepEqual(d.range, { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } });
});

test('a DIM declares without computing, so it is left alone', () => {
	assert.deepEqual(check('DIM _spare[4]'), []);
});

test('a variable used only in a later clause of the same line is not flagged', () => {
	assert.deepEqual(check('IF a THEN _t = A / 2 ELSE ADDZ _t'), []);
});

// --- read, in shapes that are easy to miss ----------------------------------

test('a read inside a command argument counts', () => {
	assert.deepEqual(check('_w = A / 2\nBLOCK _w, 1, 1'), []);
});

test('a read on the right of another assignment counts', () => {
	assert.deepEqual(check('_w = A / 2\n_h = _w * 2\nBLOCK 1, 1, _h'), []);
});

test('a counter only ever incremented is left alone', () => {
	// `_n = _n + 1` reads `_n`, so the name is live by this check's reckoning
	// even though nothing outside the increment ever looks at it. Telling the
	// two apart means asking whether a read only ever feeds a write of the same
	// name, which is flow analysis; the lenient answer is taken instead.
	assert.deepEqual(check('_n = 1\n_n = _n + 1'), []);
});

test('a group name handed over through a variable counts as a read', () => {
	assert.deepEqual(check('gr_toplace = "Object_stretched"\nPLACEGROUP gr_toplace'), []);
});

test('a subroutine name jumped through counts as a read', () => {
	assert.deepEqual(check('_substr = "EndBlock"\nGOSUB _substr'), []);
});

// --- names that are not variables of this script ----------------------------

test('a FOR counter need not be read', () => {
	// `FOR i = 1 TO 5 ... NEXT i` is how GDL spells "do this five times".
	assert.deepEqual(check('FOR i = 1 TO 5\n\tADDZ 1\nNEXT i'), []);
});

test('a global written for something else to read is not flagged', () => {
	assert.deepEqual(check('GLOB_USER_1 = 3'), []);
});

test('a fixed parameter the keyword table knows is not flagged', () => {
	assert.deepEqual(check('ac_bottomlevel = 0'), []);
});

test('a PARAMETERS target addresses a parameter list, not a variable', () => {
	assert.deepEqual(check('PARAMETERS zzyzx_leftover = 1'), []);
});

test("a macro's parameter name is the macro's, not ours", () => {
	assert.deepEqual(check('CALL "m" PARAMETERS i_style_leftover = 1'), []);
});

test('a value passed to a macro is still read', () => {
	assert.deepEqual(check('_style = 3\nCALL "m" PARAMETERS i_style = _style'), []);
});

test('a dict member is not a variable of its own', () => {
	// The lexer breaks a dotted path at a subscript, so `edge` arrives alone
	// with the `.` in front of it — `arrays.ts` meets the same shape.
	assert.deepEqual(check('_pbuf = 1\nBLOCK _pbuf.line[1].edge, 1, 1'), []);
});

// --- calls that write back into their arguments -----------------------------

test('a variable filled in by REQUEST is not flagged', () => {
	// `REQUEST` reads some arguments and writes others, and which is which is
	// unknowable — so every one is taken as read, the lenient answer.
	assert.deepEqual(check('n = REQUEST ("PEN_OF_RGB", "1 1 1", _pen)\nBLOCK n, 1, 1'), []);
});

test('a variable filled in by RETURNED_PARAMETERS is not flagged', () => {
	assert.deepEqual(check('CALL "m" RETURNED_PARAMETERS _ok, _res'), []);
});

test('a variable passed into LIBRARYGLOBAL is not flagged', () => {
	assert.deepEqual(check('_which = "pen"\nn = LIBRARYGLOBAL ("MARKERS", _which, _p)\nBLOCK n, 1, 1'), []);
});

// --- a declaration is not work ----------------------------------------------

test('a constant bound to a literal is a declaration, not a leftover', () => {
	// A constant table is written out complete on purpose: `SILL_TIMBER = 1`
	// stays even in an object that only ever builds a metal sill. 6538 corpus
	// sites, and greying them would be telling the author to prune their enum.
	assert.deepEqual(check('SILL_TIMBER = 1\nSILL_BRICK = 2\nADDZ 1'), []);
});

test('a constant bound to a negative literal is a declaration too', () => {
	assert.deepEqual(check('_off = -0.25'), []);
});

test('a constant bound to a string literal is a declaration', () => {
	assert.deepEqual(check('_label = `Festverglast`'), []);
});

test('only the computed write is greyed, not the literal seeding it', () => {
	// The literal is a declaration and costs nothing; the arithmetic below it is
	// the work nothing consumes, so that is the line to mark.
	assert.deepEqual(check('_t = 0\n_t = A * 2'), ['`_t` is assigned but never read.']);
});

test('the binding a REQUEST needs in order to be made is not a use', () => {
	// GDL has no statement form for these, so the result has to go somewhere;
	// `rrr` is where the corpus puts it, 648 times.
	assert.deepEqual(check('rrr = REQUEST ("View_Rotangle", "", _a)\nADDZ _a'), []);
});

test('a scratch name reused for a call keeps its discard sites clean', () => {
	// `rrr` is thrown a dozen results in a real script. One line of arithmetic
	// into it must not turn the other eleven grey.
	assert.deepEqual(check('rrr = REQUEST ("View_Rotangle", "", _a)\nADDZ _a\nrrr = A * 2'), [
		'`rrr` is assigned but never read.',
	]);
});

test('GET consumes the parameter buffer, so a discarded GET is not waste', () => {
	// `dummy = GET (1)` is how the corpus skips a value; the pointer moving is
	// the whole point of the line.
	assert.deepEqual(check('dummy = GET (1)'), []);
});

test('the call has to be the whole right-hand side to be a discard', () => {
	// `GET (1) + GET (1)` ends on a bracket too, but it is arithmetic, and a
	// result someone meant to keep.
	assert.deepEqual(check('dummy = GET (1) + GET (1)'), [
		'`dummy` is assigned but never read.',
	]);
});
