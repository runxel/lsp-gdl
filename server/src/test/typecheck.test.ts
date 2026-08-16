/**
 * Type checker tests.
 *
 * The "no diagnostic" cases matter as much as the positive ones — each of them
 * is a false positive that the corpus sweep caught, and they are the reason the
 * checker is usable on real library code at all.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { analyze } from '../gdl/analyzer';
import { provideTypeDiagnostics } from '../providers/typecheck';

/** A script with no library part around it: parameters are unknown. */
const BARE = 'file:///scratch/scripts/3d.gdl';

/** A script inside the real HSF fixture, so paramlist.xml types apply. */
const FIXTURE = URI.file(
	join(__dirname, '..', '..', '..', 'TestObject', 'TestObject', 'scripts', '3d.gdl'),
).toString();

function check(text: string, uri = BARE): string[] {
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideTypeDiagnostics(analyze(uri, text), td).map((d) => d.message);
}

// --- the numeric/string divide ---------------------------------------------

test('a variable swapping between number and string is flagged', () => {
	assert.match(check('a = 1\na = "text"')[0], /holds a Integer value here but is assigned a String/);
	assert.match(check('s = "text"\ns = 1')[0], /holds a String value here but is assigned a Integer/);
});

test('int and float mix freely in a plain variable', () => {
	// GDL converts silently, and library code relies on it.
	assert.deepEqual(check('a = 1\na = 2.5'), []);
	assert.deepEqual(check('a = 2.5\na = 1'), []);
});

test('unknown values never produce a diagnostic', () => {
	// WALL_HEIGHT is a global; we have no type for it and must not invent one.
	assert.deepEqual(check('a = "text"\na = WALL_HEIGHT'), []);
	assert.deepEqual(check('a = 1\na = someMacroResult'), []);
});

// --- expression typing ------------------------------------------------------

test('comparisons are integers, whatever they compare', () => {
	// `(x = "BGS")` is a 0/1 test, not a string.
	assert.deepEqual(check('n = 1\nn = 4 + (side = "BGS")'), []);
	assert.deepEqual(check('n = 1\nn = (a # "VB") * 10'), []);
});

test('division and powers yield reals', () => {
	assert.deepEqual(check('dict d\nd.x = 1\nd.x = 7 / 2'), [
		'Dictionary key `d.x` already holds an Integer and will not widen — the fractional part is lost.',
	]);
});

test('imperial literals are reals', () => {
	assert.match(check('dict d\nd.x = 1\nd.x = -.25"')[0], /will not widen/);
});

test('string functions return strings, numeric ones numbers', () => {
	assert.match(check('a = 1\na = STR(x, 5, 2)')[0], /assigned a String/);
	assert.deepEqual(check('a = "x"\na = STR(y, 5, 2)'), []);
	// STRLEN counts characters — an integer, despite the string argument.
	assert.match(check('s = "x"\ns = STRLEN(t)')[0], /assigned a Integer/);
});

test('calls that write back into their arguments erase what we knew', () => {
	// LIBRARYGLOBAL fills the third argument, so its type is no longer known.
	assert.deepEqual(
		check('pen = ""\nn = LIBRARYGLOBAL("MARKERS", "pen", pen)\npen = 4'),
		[],
	);
	assert.deepEqual(check('v = ""\nn = REQUEST("View_Rotangle", "", v)\nv = 1'), []);
});

// --- the real-comparison trap ----------------------------------------------

test('comparing reals for exact equality is flagged', () => {
	assert.match(check('a = 1.5\nif a = 1.5 then addx 1')[0], /Comparing floating-point values/);
	assert.match(check('a = 1.5\nif a <> 2.0 then addx 1')[0], /Comparing floating-point values/);
	assert.match(check('a = 1.5\nif a # 0 then addx 1')[0], /Comparing floating-point values/);
});

test('integer comparisons and ordering tests are fine', () => {
	assert.deepEqual(check('a = 1\nif a = 2 then addx 1'), []);
	// `<` and `>` are safe on reals; only equality is unreliable.
	assert.deepEqual(check('a = 1.5\nif a > 2.0 then addx 1'), []);
	assert.deepEqual(check('a = 1.5\nif a <= 2.0 then addx 1'), []);
});

test('assignments are not mistaken for comparisons', () => {
	// The `=` after THEN assigns; only the one after IF compares.
	assert.deepEqual(check('h = 1.5\nif frame = 1 then h = 2.5'), []);
	assert.deepEqual(check('x = 0.5\nfor i = 1 to 3\n\tx = 1.5\nnext i'), []);
	// Macro call arguments are assignments too.
	assert.deepEqual(check('call "Logo" parameters x = 0.035, y = 0.02'), []);
});

// --- arrays -----------------------------------------------------------------

test('DIM resets an array, so it may be refilled with another type', () => {
	// The standard "value list" idiom: same array, different type per subroutine.
	assert.deepEqual(check('dim arr[]\narr[1] = "a"\ndim arr[]\narr[1] = 1'), []);
});

test('mixing types within one array fill is flagged', () => {
	assert.match(check('dim arr[]\narr[1] = 1\narr[2] = "a"')[0], /mixes types/);
});

// --- dictionaries -----------------------------------------------------------

test('a dictionary key holding an integer does not widen to a real', () => {
	assert.match(check('dict d\nd.x = 1\nd.x = 1.5')[0], /will not widen/);
});

test('a dictionary key may change between number and string', () => {
	// Legal per the guide, but worth a word since it is rarely deliberate.
	assert.match(check('dict d\nd.x = 1\nd.x = "hello"')[0], /changes from Integer to String/);
});

test('arrays nested in a dictionary are strictly typed', () => {
	// The guide calls `myArray[1] = 1 : myArray[2] = 1.0` a GDL error.
	const [message] = check('dict d\nd.arr[1] = 1\nd.arr[2] = 1.0');
	assert.match(message, /Array inside a dictionary must hold one type/);
});

// --- parameters -------------------------------------------------------------

test('an Integer parameter must not be given a real', () => {
	// iDetailLevel is <Integer> in the fixture's paramlist.xml.
	assert.match(
		check('iDetailLevel = 2.5', FIXTURE)[0],
		/Integer parameter — assigning a floating-point value truncates it/,
	);
	// Division is the usual way this happens.
	assert.match(check('parameters iDetailLevel = A / B', FIXTURE)[0], /truncates it/);
});

test('a Length parameter accepts both integers and reals', () => {
	assert.deepEqual(check('zzyzx = 3', FIXTURE), []);
	assert.deepEqual(check('zzyzx = 3.5', FIXTURE), []);
});

test('a parameter cannot cross the numeric/string divide', () => {
	assert.match(check('iDetailLevel = "two"', FIXTURE)[0], /cannot assign a String value/);
});

test('PARAMETERS assigns each target independently', () => {
	const messages = check('parameters zzyzx = 2.0, iDetailLevel = 1.5', FIXTURE);
	assert.equal(messages.length, 1);
	assert.match(messages[0], /iDetailLevel/);
});
