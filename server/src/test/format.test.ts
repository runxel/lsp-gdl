/**
 * Argument-list alignment.
 *
 * Two invariants matter more than any single layout, and both are asserted
 * below on every case: the formatter must be **idempotent** (a second run is a
 * no-op) and it must be **token-preserving** (re-tokenising the result gives
 * back the same tokens, so it can never change what a script does). The rest of
 * the cases are the shapes that must be left alone.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { tokenize } from '../gdl/lexer';
import { provideFormattingEdits, type AlignOptions } from '../providers/format';

const URI = 'file:///Obj/scripts/3d.gdl';

const SPACES: AlignOptions = { tabSize: 4, insertSpaces: true };
const TABS: AlignOptions = { tabSize: 4, insertSpaces: false };

/** Applies the edits back to front, which is what a client does. */
function applyOnce(text: string, opts: AlignOptions): string {
	const td = TextDocument.create(URI, 'gdl-hsf', 1, text);
	const edits = provideFormattingEdits(analyze(URI, text), td, opts);
	return TextDocument.applyEdits(td, edits);
}

/** The signature a token stream keeps across a legal reformat. */
function shape(text: string): string {
	return tokenize(text)
		.filter((t) => t.type !== 'newline')
		.map((t) => `${t.type}:${t.text}`)
		.join('|');
}

function format(text: string, opts: AlignOptions = SPACES): string {
	const once = applyOnce(text, opts);
	assert.equal(applyOnce(once, opts), once, 'formatting is not idempotent');
	assert.equal(shape(once), shape(text), 'formatting changed the token stream');
	return once;
}

// --- what it is for ---------------------------------------------------------

test('a continued list is aligned into columns', () => {
	assert.equal(
		format(['put \\', '\t1, 1.12345, sr,', '\t1.0394*abc, 0, s'].join('\n')),
		['put \\', '\t1,          1.12345, sr,', '\t1.0394*abc, 0,       s'].join('\n'),
	);
});

test('a list continued by its trailing comma is aligned too', () => {
	assert.equal(
		format(['put 1, 1.12345, sr,', '    1.0394*abc, 0, s'].join('\n')),
		// Column 0 is `put 1,` on one row and `1.0394*abc,` on the other, and
		// the indent is the author's, so column 1 clears the wider of the two.
		['put 1,          1.12345, sr,', '    1.0394*abc, 0,       s'].join('\n'),
	);
});

test('a column that is already wide enough is left where it is', () => {
	const text = ['put 1,      2,', '    333333, 4'].join('\n');
	assert.equal(format(text), text);
});

test('padding follows the editor: tabs land on tab stops', () => {
	assert.equal(
		format(['put \\', '\tab, c,', '\td, ef'].join('\n'), TABS),
		['put \\', '\tab,\tc,', '\td,\tef'].join('\n'),
	);
	// A cell ending exactly on a tab stop still gets a full tab, never nothing.
	assert.equal(
		format(['put \\', '\tabc, d,', '\te, f'].join('\n'), TABS),
		['put \\', '\tabc,\td,', '\te,\t\tf'].join('\n'),
	);
});

test('a bracketed argument is one cell, not several', () => {
	assert.equal(
		format(['put str(a, 1, 0), b,', '    c, dddd'].join('\n')),
		['put str(a, 1, 0), b,', '    c,            dddd'].join('\n'),
	);
});

test('a head row carrying the command does not have to match the table', () => {
	// `Wandarmatur AOL/2d.gdl`, and the shape of nearly every coordinate list in
	// the corpus: four cells of preamble over rows of three. The head takes no
	// part — its own spacing is left exactly as written — and the rows below line
	// up with each other.
	assert.equal(
		format(
			[
				'poly2_b 5, 1+2, fill_pen, back_pen,',
				'    -RAD, 0, 1,',
				'    -RAD, -0.007, 1,',
				'    RAD, 0, -1',
			].join('\n'),
		),
		[
			'poly2_b 5, 1+2, fill_pen, back_pen,',
			'    -RAD, 0,      1,',
			'    -RAD, -0.007, 1,',
			'    RAD,  0,      -1',
		].join('\n'),
	);
});

test('...but a head row that does match still takes part', () => {
	assert.equal(
		format(['prism_ 3, 0.1,', '    1, 2,', '    33333, 4'].join('\n')),
		['prism_ 3,  0.1,', '    1,     2,', '    33333, 4'].join('\n'),
	);
});

test('the value rows themselves must still agree', () => {
	// The head being exempt is not a licence to align a wrapped stream: these
	// rows are pairs that ran out of line, not columns.
	const text = [
		'values{2} "iPanelType" 1, "Typ 1", 2, "Typ 2",',
		'    3, "Typ 3", 4, "Typ 4", 5, "Typ 5",',
		'    6, "Typ 6", 7, "Typ 7"',
	].join('\n');
	assert.equal(format(text), text);
});

test('the last row may not run short either', () => {
	// It is the one row that could honestly end early, but letting it off makes
	// a table of the wrapped `VALUES` stream above, whose rows agree by accident
	// and whose remainder is exactly this shape.
	const text = ['put 1, 2, 3,', '    44444, 5, 6,', '    7, 8'].join('\n');
	assert.equal(format(text), text);
});

// --- the marker columns -----------------------------------------------------

test('a lone trailing backslash is not dragged out to the table width', () => {
	assert.equal(
		format(['put \\', '\t1, 22222222,', '\t3, 4'].join('\n')),
		['put \\', '\t1, 22222222,', '\t3, 4'].join('\n'),
	);
});

test('backslashes on several rows line up with each other', () => {
	// `then` is a row of this statement too — the `\` joined it — but it carries
	// no marker of its own, so it takes no part in the column.
	assert.equal(
		format(['if a | \\', '   bbbb | \\', '   c \\', 'then'].join('\n')),
		['if a |    \\', '   bbbb | \\', '   c      \\', 'then'].join('\n'),
	);
	assert.equal(
		format(['x = a | \\', '    bbbbbb | \\', '    c'].join('\n'), TABS),
		['x = a |\t\t\t\\', '    bbbbbb |\t\\', '    c'].join('\n'),
	);
});

test('trailing comments get a column of their own', () => {
	assert.equal(
		format(['put 1, 2, ! first', '    3333, 4 ! second'].join('\n')),
		['put 1,    2, ! first', '    3333, 4  ! second'].join('\n'),
	);
});

test('a comment inside a continuation is left untouched', () => {
	// The comment is a no-op that the continuation runs straight through, and
	// it is not a row of the table — see the lexer notes on this shape.
	const text = ['x = (a | \\', '     !b | \\', '     c)'].join('\n');
	assert.equal(format(text), text);
});

test('trailing whitespace goes from a statement that was aligned', () => {
	assert.equal(
		format(['put 1, 2,   ', '    3333, 4  '].join('\n')),
		['put 1,    2,', '    3333, 4'].join('\n'),
	);
});

test('...but a statement that needed no alignment keeps even that', () => {
	// Otherwise the command would put lines in the diff it was never asked to
	// touch — trimming a file is `files.trimTrailingWhitespace`'s job, not ours.
	const text = ['put 1, 2,   ', '    3, 4  '].join('\n');
	assert.equal(format(text), text);
});

// --- the 255-character limit ------------------------------------------------

test('a statement is left alone when alignment would pass 255 characters', () => {
	// Neither row is near the limit as written: one is long in column 0, the
	// other long in column 1. Lining the two columns up puts the second row's
	// long cell out past 255, so nothing at all is changed — a half-aligned
	// table is worse than an unaligned one, and a formatter must never be the
	// thing that stops a script compiling.
	const wide = 'x'.repeat(240);
	const text = [`put ${wide}, c`, `    b, ${wide}`].join('\n');
	assert.ok(text.split('\n').every((line) => line.length <= 255));
	assert.equal(format(text), text);
});

test('a row that is already over the limit is not widened', () => {
	const text = [`put ${'x'.repeat(260)}, 1,`, '    a, 2'].join('\n');
	assert.equal(format(text), text);
});

test('the limit is measured in characters, so a tab counts as one', () => {
	// Archicad reads a line, not a rendering of one, so the guard counts
	// characters: tab padding buys width that space padding could not.
	const wide = 'x'.repeat(240);
	const tabbed = format([`put ${wide}, 1,`, '\ta, 2'].join('\n'), TABS);
	for (const line of tabbed.split('\n')) assert.ok(line.length <= 255, line);
});

// --- shapes that must be left alone -----------------------------------------

test('a single-line statement is never touched', () => {
	assert.equal(format('put 1,  2,   3'), 'put 1,  2,   3');
	assert.equal(format('hotspot2 x, y   '), 'hotspot2 x, y   ');
});

test('a second statement on the row stops the alignment', () => {
	const text = ['put 1, 22,', '    3, 4 : addx 1'].join('\n');
	assert.equal(format(text), text);
});

test('an unterminated string is left to the diagnostics', () => {
	const text = ['put "a, 1,', '    22, 3'].join('\n');
	assert.equal(format(text), text);
});

test('unbalanced brackets are left alone', () => {
	const text = ['put (a, 1,', '    22, 3'].join('\n');
	assert.equal(format(text), text);
});

test('a row that opens inside brackets is not a table row', () => {
	const text = ['put str(a,', '    1, 0), bb,', '    c, d'].join('\n');
	assert.equal(format(text), text);
});

test('a string continued across lines is left alone', () => {
	const text = ['put "long \\', '    text", 1,', '    22, 3'].join('\n');
	assert.equal(format(text), text);
});

// --- range formatting -------------------------------------------------------

test('range formatting touches only the statements it covers', () => {
	const text = ['put 1, 22,', '    3, 4', 'put 5, 66,', '    7, 8'].join('\n');
	const td = TextDocument.create(URI, 'gdl-hsf', 1, text);
	const edits = provideFormattingEdits(analyze(URI, text), td, SPACES, {
		start: { line: 0, character: 0 },
		end: { line: 1, character: 0 },
	});
	const out = TextDocument.applyEdits(td, edits);
	assert.equal(out, ['put 1, 22,', '    3, 4', 'put 5, 66,', '    7, 8'].join('\n'));
	assert.ok(edits.every((e) => e.range.start.line <= 1));
});

// --- line endings -----------------------------------------------------------

test('CRLF and lone-CR files align the same as LF ones', () => {
	const lf = ['put \\', '\t1, 22222,', '\t333, 4'].join('\n');
	assert.equal(
		format(lf.replace(/\n/g, '\r\n')).replace(/\r\n/g, '\n'),
		format(lf),
	);
	assert.equal(format(lf.replace(/\n/g, '\r')).replace(/\r/g, '\n'), format(lf));
});
