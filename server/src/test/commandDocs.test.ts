/**
 * Reading command syntax and bit tables out of the reference guide.
 *
 * As in `referenceDocs.test.ts`, the pages are written by the test in the shape
 * the real ones have — the guide's own text is never copied into this repo.
 * Every shape below is one that broke an earlier version of the parser, and the
 * non-breaking spaces are load-bearing: that is how the guide is really written,
 * and a pattern spelt with ordinary spaces silently matches nothing.
 */

import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandDoc, setCommandDocsRoot } from '../gdl/commandDocs';

const root = mkdtempSync(join(tmpdir(), 'gdl-commands-'));
after(() => rmSync(root, { recursive: true, force: true }));

/** The guide separates every token of a formula with one of these. */
const NB = ' ';

/** `<pre>` syntax line, as DocBook emits it. */
const listing = (name: string, args: string) =>
	`<pre class="programlisting"><b id="${name}_keyword_2.8.3">${name}</b> ${args}</pre>`;

/** `<code><b>name: </b></code>gloss` — one argument's documentation. */
const gloss = (name: string, text: string) =>
	`<div style="margin-left: 1em"><div style="text-indent: -1em"><code><b>${name}:${NB}</b></code>${text}</div></div>`;

/** A bitmask: the formula, then the meaning of each `j`. */
function formula(arg: string, bits: [weight: number, index: number, text?: string][]): string {
	const sum = bits
		.map(([w, j]) => (w === 1 ? `j<sub>${j}</sub>` : `${w}*j<sub>${j}</sub>`))
		.join(`${NB}+${NB}`);
	const lines = bits
		.filter(([, , text]) => text)
		.map(([, j, text]) => `<div><code>j<sub>${j}</sub>:${NB}</code>${text},</div>`)
		.join('');
	return `<div><code>${arg}${NB}=${NB}${sum}</code>, where each j can be 0 or 1.</div>${lines}`;
}

/** `section` decides whether the page is indexed at all. */
function writePage(file: string, body: string, section = '2D Shapes') {
	writeFileSync(
		join(root, `${file}.html`),
		`<html><body class="gdlcommand">${body}<p>Related in ${section}</p></body></html>`,
		'utf8',
	);
}

// `POLY2_`: two masks sharing one run of `j` lines, and a repeating tail.
writePage(
	'POLY2_',
	listing('POLY2_', 'n, frame_fill, x1, y1, s1, ..., xn, yn, sn') +
		gloss('n', 'number of nodes.') +
		gloss('x1, y1, ..., xn, yn', 'coordinates of each node.') +
		formula('frame_fill', [
			[1, 1, 'draw contour'],
			[2, 2, 'draw fill'],
			[4, 3, 'close an open polygon'],
			[32, 6, 'fill is cut fill (default is drafting fill)'],
		]) +
		formula('si', [
			[1, 1, 'next segment is visible'],
			[16, 5, 'next segment is inner line'],
		]),
);

// `POLY2_B`: glosses only what it adds, and defers the rest in prose.
writePage(
	'POLY2_B',
	listing('POLY2_B', 'n, frame_fill, fill_pen, fill_background_pen, x1, y1, s1, ..., xn, yn, sn') +
		'<p>Advanced versions of the POLY2_ command , with additional parameters.</p>' +
		gloss('fill_pen', 'fill pencolor number.'),
);

// `POLY2_B{4}`: the braced name, no link at all, two steps from the table.
writePage(
	'POLY2_B4',
	listing('POLY2_B{4}', 'n, frame_fill, fill_pen, gradientInnerRadius, x1, y1, s1, ..., xn, yn, sn') +
		'<p>Advanced version of POLY2_ B{3}, where the inner radius can be set.</p>',
);
writePage(
	'POLY2_B3',
	listing('POLY2_B{3}', 'n, frame_fill, fill_pen, mxx, x1, y1, s1, ..., xn, yn, sn') +
		'<p>Advanced version of the POLY2_B command , where the fill orientation is a matrix.</p>',
);

// `POLY2_B{5}`: declares a shorter frame_fill of its own, having moved the
// cut/cover bits out into another argument.
writePage(
	'POLY2_B5',
	listing('POLY2_B{5}', 'n, frame_fill, fillcategory, x1, y1, s1, ..., xn, yn, sn') +
		'<p>Advanced version of POLY2_B{4}, where the fill category is separate.</p>' +
		formula('frame_fill', [
			[1, 1, 'draw contour'],
			[2, 2, 'draw fill'],
		]),
);

// `HOTSPOT2`: optionality brackets nested six deep.
writePage(
	'HOTSPOT2',
	listing('HOTSPOT2', 'x, y [, unID [, paramReference [, flags [, displayParam [, "customDescription"]]]]]'),
);

// `SPLINE2A`: an ellipsis with no comma after it.
writePage(
	'SPLINE2A',
	listing('SPLINE2A', 'n, status, x1, y1, angle1, ... xn, yn, anglen'),
);

// `FRAGMENT2`: two syntax lines on one page.
writePage(
	'FRAGMENT2',
	listing('FRAGMENT2', 'fragment_index, use_current_attributes_flag') +
		listing('FRAGMENT2', 'ALL, use_current_attributes_flag'),
);

// `PROJECT2{4}`: repeats twice, the second tail indexed by an expression.
writePage(
	'PROJECT24',
	listing('PROJECT2{4}', 'angle, numCutplanes, cutplaneHeight1, ..., cutplaneHeightn, method1, ... method(numCutplanes+1)'),
);

// A 3D command: out of scope while the baseline was 2D, indexed now.
writePage('CPRISM_', listing('CPRISM_', 'top_material, n, h'), '3D Shapes');

// Control statements: the guide writes them as sentences, not argument lists.
writePage('IF', listing('IF', 'condition THEN statement [ ELSE statement]'), 'Control Statements');
writePage('RETURN', listing('RETURN', ''), 'Control Statements');

// A countable head with a clause running off the end of it.
writePage(
	'PROJECT23',
	listing(
		'PROJECT2{3}',
		'projection_code, angle, method, parts [, backgroundColor][[,] PARAMETERS name1=value1, ..., namen=valuen]',
	) + formula('parts', [[1, 1, 'cut polygons'], [2, 2, 'cut polygon edges']]),
);

// `DELTOP.html` marks only `DEL` as its keyword, so it names `DEL.html`'s command.
writePage('DEL', listing('DEL', 'n [, begin_with]'), 'Coordinate Transformations');
writePage('DELTOP', listing('DEL', 'TOP'), 'Coordinate Transformations');

// One page, two commands, a syntax line each.
writePage(
	'ENDEXIT',
	listing('END', '[v1, v2, ..., vn]') + listing('EXIT', '[v1, v2, ..., vn]'),
	'Control Statements',
);

// The same argument given again, against two groups that are not modelled.
writePage('PUT', listing('PUT', 'expression [, expression, ...]'), 'Miscellaneous');
writePage(
	'TUBE',
	listing('TUBE', 'n, m, mask, u1, w1, s1, ... un, wn, sn, x1, y1, z1, angle1, ... xm, ym, zm, anglem'),
	'3D Shapes',
);

setCommandDocsRoot(root);

test('a command is keyed on the braced name, not the filename', () => {
	// The page is POLY2_B5.html; the lexer and the user both write POLY2_B{5}.
	assert.equal(commandDoc('poly2_b{5}')?.name, 'POLY2_B{5}');
	assert.equal(commandDoc('POLY2_B{5}')?.name, 'POLY2_B{5}');
	assert.equal(commandDoc('poly2_b5'), undefined);
});

test('every section is read', () => {
	// Scoped to 2D Shapes as a baseline, then widened to the whole guide.
	assert.ok(commandDoc('poly2_'), '2D Shapes');
	assert.ok(commandDoc('cprism_'), '3D Shapes');
});

test('a syntax line that is prose gets no signature at all', () => {
	// The guide writes the control statements as sentences. Counting commas
	// through `IF condition THEN statement [ ELSE statement]` would put the
	// cursor on an argument that is not there.
	assert.equal(commandDoc('if')?.signatures.length, 0);
	assert.equal(commandDoc('return')?.signatures.length, 0);
});

test('a countable head is kept even when the tail is prose', () => {
	// `PROJECT2{3} …, parts [, backgroundColor, …][[,] PARAMETERS name1=value1]`
	// — the first arguments are an ordinary list and `parts` is a mask among
	// them; only the trailing PARAMETERS clause cannot be counted.
	const params = commandDoc('project2{3}')?.signatures[0].params.map((p) => p.name);
	assert.deepEqual(params, ['projection_code', 'angle', 'method', 'parts', 'backgroundColor']);
	// …and the mask among them still decodes.
	assert.ok(commandDoc('project2{3}')?.masks.get('parts'));
});

test('a page named after its command owns the name', () => {
	// `DELTOP.html` spells `<b>DEL</b> TOP`, so it names the same keyword as
	// `DEL.html` — which is the page that actually documents `DEL`.
	assert.match(commandDoc('del')?.signatures[0].label ?? '', /^DEL n/);
});

test('both commands of a shared page answer to it', () => {
	// `END / EXIT` is one page with a syntax line each.
	assert.equal(commandDoc('exit')?.signatures[0].label, commandDoc('end')?.signatures[0].label);
});

test('an argument may simply be given again', () => {
	// `PUT expression [, expression, ...]` — the same argument, repeated.
	const put = commandDoc('put')?.signatures[0];
	assert.equal(put?.variadic, true);
	assert.deepEqual(put?.params.map((p) => p.name), ['expression', 'expression']);
	// `TUBE` repeats twice and the second group is not modelled, so nothing is
	// claimed past the first ellipsis rather than clamping to the wrong slot.
	const tube = commandDoc('tube')?.signatures[0];
	assert.equal(tube?.variadic, undefined);
	assert.deepEqual(tube?.params.map((p) => p.name), ['n', 'm', 'mask', 'u1', 'w1', 's1']);
});

test('optionality brackets do not group arguments', () => {
	// `x, y [, unID [, paramReference …]]]` is seven arguments, not two.
	assert.deepEqual(
		commandDoc('hotspot2')?.signatures[0].params.map((p) => p.name),
		['x', 'y', 'unID', 'paramReference', 'flags', 'displayParam', '"customDescription"'],
	);
});

test('the repeating tail is proved against its own counterpart', () => {
	assert.deepEqual(commandDoc('poly2_')?.signatures[0].repeat, { start: 2, size: 3 });
	// An ellipsis with no comma after it, which only SPLINE2A writes.
	assert.deepEqual(commandDoc('spline2a')?.signatures[0].repeat, { start: 2, size: 3 });
	// Two tails, the second indexed by an expression: nothing is claimed rather
	// than something wrong.
	assert.equal(commandDoc('project2{4}')?.signatures[0].repeat, undefined);
});

test('a page with two syntax lines yields two signatures', () => {
	assert.equal(commandDoc('fragment2')?.signatures.length, 2);
	assert.match(commandDoc('fragment2')?.signatures[1].label ?? '', /FRAGMENT2 ALL,/);
});

test('an argument carries the guide’s gloss, groups included', () => {
	const params = commandDoc('poly2_')?.signatures[0].params ?? [];
	assert.match(params.find((p) => p.name === 'n')?.documentation ?? '', /number of nodes/);
	// `x1, y1, ..., xn, yn: coordinates` glosses each name it lists.
	assert.match(params.find((p) => p.name === 'y1')?.documentation ?? '', /coordinates/);
});

test('bit descriptions are scoped to their own formula', () => {
	// POLY2_ carries two tables sharing one run of `j` lines: frame_fill's bit 1
	// is "draw contour", si's bit 1 is "next segment is visible". Reading them
	// into one table gave frame_fill the meaning of si.
	const masks = commandDoc('poly2_')?.masks;
	assert.match(masks?.get('frame_fill')?.find((b) => b.weight === 1)?.text ?? '', /draw contour/);
	assert.match(masks?.get('si')?.find((b) => b.weight === 1)?.text ?? '', /next segment is visible/);
});

test('a page inherits the table of the command it says it advances', () => {
	// POLY2_B glosses only what it adds and defers the rest in prose.
	assert.match(
		commandDoc('poly2_b')?.masks.get('frame_fill')?.find((b) => b.weight === 2)?.text ?? '',
		/draw fill/,
	);
	// POLY2_B{4} carries no link at all, and reaches POLY2_ through {3} and B.
	assert.match(
		commandDoc('poly2_b{4}')?.masks.get('frame_fill')?.find((b) => b.weight === 1)?.text ?? '',
		/draw contour/,
	);
});

test('a variant’s own formula wins over the one it inherits', () => {
	// POLY2_B{5} moved the cut/cover bits out of frame_fill, so inheriting the
	// parent's shape would describe bits that no longer mean that.
	assert.deepEqual(
		commandDoc('poly2_b{5}')?.masks.get('frame_fill')?.map((b) => b.weight),
		[1, 2],
	);
});

test('an undescribed bit is kept, so the weights still add up', () => {
	writePage('TESTBITS', listing('TESTBITS', 'flags') + formula('flags', [[1, 1, 'first'], [2, 2]]));
	setCommandDocsRoot(undefined);
	setCommandDocsRoot(root);
	const bits = commandDoc('testbits')?.masks.get('flags');
	assert.deepEqual(bits, [{ weight: 1, text: 'first' }, { weight: 2 }]);
});
