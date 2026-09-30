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
import { provideCodeActions, type QuickFix } from '../providers/codeActions';
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
	// A named label keeps its case — it is compared as a string literal, unlike
	// everything else in GDL — while a numeric one is keyed by value.
	const doc = analyze(URI_3D, '0100:\n\treturn\n"namedRoutine":\n\treturn');
	assert.deepEqual([...doc.labels.keys()].sort(), ['100', 'namedRoutine']);
});

test('a label ends its own statement', () => {
	// `500:\tLINE2 0, -body_wid, 0` — code written after a label on the same
	// line is a statement of its own, and the label still reads as a label.
	const doc = analyze(URI_3D, '500:\tline2 0, -0.1, 0');
	assert.deepEqual([...doc.labels.keys()], ['500']);
	assert.deepEqual(doc.statements.map((s) => s.head), [undefined, 'line2']);
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
		// The trailing `addx` is not decoration: without a reader, `unused.ts`
		// greys all three, and this case is about block balance.
		messages('if a then x = 1 else\n\tif b then y = 2 else\n\t\tz = 3\n\tendif\nendif\naddx x + y + z'),
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

test('a block keyword swallowed by a `\\` continuation is reported', () => {
	// Reported by the project owner: the continuation runs through the blank
	// line, so the ELSE is joined onto the PUT and the IF never sees it.
	const text = 'if i_style = STYLE_FRAMED then\n\t\tput \\\n\n\telse\n\t\taddx 1\nendif';
	const [d, ...rest] = diagnose(text).filter((d) => /continues the statement/.test(d.message));
	assert.deepEqual(rest, []);
	assert.equal(
		d.message,
		'This `\\` continues the statement into `ELSE` on line 4, which then reads as part of `PUT` ' +
			'rather than as a statement of its own.',
	);
	assert.deepEqual(d.range, { start: { line: 1, character: 6 }, end: { line: 1, character: 7 } });

	// A comment line carries the continuation just as a blank one does.
	assert.match(messages('if a then\n\tput 1, \\\n\t! note\nendif').join('\n'), /into `ENDIF` on line 4/);
	assert.match(messages('for i = 1 to 3\n\taddx 1 \\\nnext i').join('\n'), /into `NEXT` on line 3/);
	// After THEN, the command after it is the one that swallowed the keyword.
	assert.match(messages('if a then\n\tif b then addx \\\nendif').join('\n'), /into `ENDIF` .* `ADDX`/);
});

test('a wrapped one-line IF keeps its own ELSE', () => {
	const found = (text: string) => messages(text).filter((m) => /continues the statement/.test(m));
	assert.deepEqual(found('if a then addx 1 \\\n\telse addy 1'), []);
	assert.deepEqual(found('if a | \\\n\tb then addx 1 \\\nelse addy 1'), []);
	// A plain line break ends the statement, as ever.
	assert.deepEqual(found('if a then\n\taddx 1\nelse\n\taddy 1\nendif'), []);
});

test('a `THEN` stranded by a missing `\\` is reported, with the fix', () => {
	// Reported by the project owner: the last row of a wrapped condition lost
	// its `\\`, so the IF ends at `bar` and THEN heads a statement of its own.
	// Before this the block form said only "ENDIF without a matching IF", and
	// the one-line form nothing at all.
	const text = 'if foo & \\\n\tbar\nthen\n\taddx 1\nendif';
	const [d, ...rest] = diagnose(text);
	assert.deepEqual(rest, []);
	assert.equal(
		d.message,
		'`THEN` stands on a line of its own — the `IF` above it ends at line 2, which is missing a `\\`.',
	);
	assert.equal(d.severity, 1 /* Error */);
	assert.deepEqual(d.range, { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } });

	// The fix goes straight after the last token, and leaves a clean script.
	const [action, ...more] = provideCodeActions(URI_3D, [d]);
	assert.deepEqual(more, []);
	const [edit] = action.edit!.changes![URI_3D];
	assert.deepEqual(edit, { range: { start: { line: 1, character: 4 }, end: { line: 1, character: 4 } }, newText: ' \\' });
	const fixed = TextDocument.applyEdits(TextDocument.create(URI_3D, 'gdl', 1, text), [edit]);
	assert.equal(fixed, 'if foo & \\\n\tbar \\\nthen\n\taddx 1\nendif');
	assert.deepEqual(messages(fixed), []);

	assert.match(messages('if foo & \\\n\tbar\nthen addx 1').join('\n'), /`THEN` stands on a line of its own/);
	// No `\\` at all, and a line break still standing between the two.
	assert.match(messages('if foo\n\nthen addx 1').join('\n'), /ends at line 1/);
	assert.match(messages('for i = 1\n\tto 3\n\taddx 1\nnext i').join('\n'), /`TO` stands .* `FOR` above it/);
});

test('the `\\` goes ahead of a trailing comment, and inside the line limit', () => {
	const fix = (text: string) => diagnose(text).find((d) => /stands on a line/.test(d.message))?.data;
	assert.deepEqual(fix('if foo &\\\n\tbar\t! note\nthen addx 1'), {
		quickFix: {
			title: 'Continue the statement with `\\`',
			edits: [{ range: { start: { line: 1, character: 4 }, end: { line: 1, character: 4 } }, newText: ' \\' }],
		},
	});
	// Archicad refuses a line over 255 characters, so the fix never writes one.
	const long = (n: number) => `if ${'a'.repeat(n - 3)}\nthen addx 1`;
	assert.equal((fix(long(253)) as QuickFix).quickFix.edits[0].newText, ' \\');
	assert.equal((fix(long(254)) as QuickFix).quickFix.edits[0].newText, '\\');
	assert.equal(fix(long(255)), undefined);
});

test('a `THEN` is not stranded when the statement above did not want it', () => {
	const found = (text: string) => messages(text).filter((m) => /stands on a line/.test(m));
	// `IF a GOTO 100` is complete without one.
	assert.deepEqual(found('if a goto 100\nthen addx 1'), []);
	assert.deepEqual(found('if a then\n\taddx 1\nendif'), []);
	assert.deepEqual(found('for i = 1 to 3 : next i'), []);
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
