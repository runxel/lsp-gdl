/**
 * Analyzer and diagnostics tests.
 *
 * As with the lexer tests, the shapes here are taken from real library parts.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideDiagnostics } from '../providers/diagnostics';
import { scriptKindFromUri } from '../gdl/scriptKind';

const URI_3D = 'file:///Obj/scripts/3d.gdl';

function diagnose(text: string, uri = URI_3D) {
	const doc = analyze(uri, text);
	return provideDiagnostics(doc, TextDocument.create(uri, 'gdl', 1, text), 100);
}

const messages = (text: string, uri?: string) => diagnose(text, uri).map((d) => d.message);

test('script kind comes from the HSF filename', () => {
	assert.equal(scriptKindFromUri('file:///Obj/scripts/3d.gdl'), '3d');
	assert.equal(scriptKindFromUri('file:///Obj/scripts/vl.gdl'), 'vl');
	assert.equal(scriptKindFromUri('file:///Obj/scripts/1d.gdl'), '1d');
	assert.equal(scriptKindFromUri('file:///scratch.gdl'), undefined);
});

test('assignments define variables', () => {
	const doc = analyze(URI_3D, 'width = 2\nheight = width * 2');
	assert.deepEqual([...doc.variables.keys()].sort(), ['height', 'width']);
	assert.equal(doc.variables.get('width')?.references.length, 2);
});

test('PARAMETERS writes are marked as parameter writes', () => {
	const doc = analyze('file:///Obj/scripts/vl.gdl', 'a = 1\nparameters a = a, b = 2');
	assert.equal(doc.variables.get('a')?.isParameterWrite, true);
	assert.equal(doc.variables.get('b')?.isParameterWrite, true);
});

test('both label spellings are collected', () => {
	const doc = analyze(URI_3D, '100:\n\treturn\n"namedRoutine":\n\treturn');
	assert.deepEqual([...doc.labels.keys()].sort(), ['100', 'namedroutine']);
});

test('CALL records the macro dependency', () => {
	const doc = analyze(URI_3D, 'call "Wall Macro" parameters all');
	assert.deepEqual(doc.macroCalls.map((m) => m.name), ['Wall Macro']);
});

test('balanced blocks produce no diagnostics', () => {
	assert.deepEqual(messages('if a then\n\tblock 1,1,1\nendif'), []);
	assert.deepEqual(messages('for i = 1 to 3\n\taddx 1\nnext i'), []);
	assert.deepEqual(messages('while a do\n\taddx 1\nendwhile'), []);
	assert.deepEqual(messages('do\n\taddx 1\nwhile a'), []);
	assert.deepEqual(messages('group "g"\n\tblock 1,1,1\nendgroup'), []);
});

test('a single-line IF needs no ENDIF', () => {
	assert.deepEqual(messages('if a then addx 1'), []);
	assert.deepEqual(messages('if a then addx 1 else addy 1'), []);
});

test('a trailing ELSE opens a block that ENDIF closes', () => {
	// IF a THEN x ELSE
	//     IF b THEN y ELSE
	//         z
	//     ENDIF
	// ENDIF
	assert.deepEqual(
		messages('if a then x = 1 else\n\tif b then y = 2 else\n\t\tz = 3\n\tendif\nendif'),
		[],
	);
});

test('a whole loop on one line balances', () => {
	assert.deepEqual(messages('for i = 1 to n : cutend : next i'), []);
});

test('unbalanced blocks are reported', () => {
	assert.match(messages('if a then\n\tblock 1,1,1')[0], /never closed/);
	assert.match(messages('endif')[0], /without a matching/);
	assert.match(messages('for i = 1 to 3\n\taddx 1\nendif')[0], /does not close/);
});

test('a command from the wrong script is flagged', () => {
	assert.match(messages('circle2 0, 0, 1')[0], /not valid in the 3D script/);
});

test('the master script accepts commands from every script', () => {
	assert.deepEqual(messages('circle2 0, 0, 1', 'file:///Obj/scripts/1d.gdl'), []);
});

test('deprecated globals are hinted, not errored', () => {
	const [d] = diagnose('c_ = 3');
	assert.match(d.message, /deprecated/);
	assert.equal(d.severity, 4 /* Hint */);
});

test('unterminated strings are reported', () => {
	assert.match(messages('a = "oops')[0], /Unterminated string/);
});
