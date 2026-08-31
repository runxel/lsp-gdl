/**
 * Colour swatches and the picker's edits.
 *
 * A swatch is a claim about what the numbers mean, and the edit behind it
 * rewrites working code — so both directions are tested here. Every shape below
 * is one the corpus actually holds: the `MAT_PLASTIC` constant type, the
 * `172/255` fraction, the tab-aligned triple with a comment wrapped into the
 * middle of it, and the `"255 0 0"` that is not a GDL colour at all.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { Color } from 'vscode-languageserver/node';
import { analyze } from '../gdl/analyzer';
import { provideColorPresentations, provideDocumentColors } from '../providers/colors';

const uri = URI.file(join(__dirname, '..', '..', '..', 'TestObject', 'TestObject', 'scripts', '3d.gdl')).toString();

function doc(text: string) {
	return { gdl: analyze(uri, text), td: TextDocument.create(uri, 'gdl-hsf', 1, text) };
}

/** The source text each swatch covers, paired with its colour. */
function swatches(text: string): [string, [number, number, number]][] {
	const { gdl, td } = doc(text);
	return provideDocumentColors(gdl, td).map((c) => [
		text.slice(td.offsetAt(c.range.start), td.offsetAt(c.range.end)),
		[c.color.red, c.color.green, c.color.blue],
	]);
}

/** The document as the picker would leave it, having chosen `picked`. */
function pick(text: string, picked: [number, number, number], index = 0): string {
	const { gdl, td } = doc(text);
	const info = provideDocumentColors(gdl, td)[index];
	assert.ok(info, 'expected a swatch to pick');

	const colour = Color.create(picked[0], picked[1], picked[2], 1);
	const presentations = provideColorPresentations(gdl, td, colour, info.range);
	if (presentations.length === 0) return text;

	const edit = presentations[0].textEdit;
	assert.ok(edit, 'a presentation must carry its own edit');
	return (
		text.slice(0, td.offsetAt(edit.range.start)) + edit.newText + text.slice(td.offsetAt(edit.range.end))
	);
}

test('DEFINE MATERIAL: the surface triple is the swatch', () => {
	assert.deepEqual(swatches('define material "Cover white" 4, 0.95, 0.95, 0.95\n'), [
		['0.95, 0.95, 0.95', [0.95, 0.95, 0.95]],
	]);
});

test('the type may be a constant, which nothing here needs to fold', () => {
	// `MAT_PLASTIC` is how most of the corpus writes it — the surface triple
	// opens the argument list whatever the type turns out to be.
	assert.deepEqual(swatches('define material "srf_builtin_black" MAT_PLASTIC,\n\t0.12, 0.12, 0.14\n'), [
		['0.12, 0.12, 0.14', [0.12, 0.12, 0.14]],
	]);
});

test('the comma between name and type is optional, and both spellings read alike', () => {
	// The guide writes `DEFINE MATERIAL name [,] type`; the corpus uses both.
	const expected: [string, [number, number, number]][] = [['1, 0, 0', [1, 0, 0]]];
	assert.deepEqual(swatches('define material "red" 2, 1, 0, 0\n'), expected);
	assert.deepEqual(swatches('define material "red", 2, 1, 0, 0\n'), expected);
});

test('a channel folded from literals counts', () => {
	// `DORMAKABA_ACS_access_control_macro/1d.gdl` writes its greys as fractions.
	assert.deepEqual(swatches('define material "ALUMINIUM_DK" 0, 172/255, 172/255, 172/255,\n\t0.85\n'), [
		['172/255, 172/255, 172/255', [172 / 255, 172 / 255, 172 / 255]],
	]);
});

test('a computed channel is not a colour', () => {
	// 13 of the corpus's 174 DEFINE MATERIALs read their channels from
	// variables — `col_custom_bookmat[1][1]`, `gs_color_red`, `colors.c[i].r`.
	assert.deepEqual(swatches('define material "free" mattype, red_r, green_r, blue_r\n'), []);
	assert.deepEqual(swatches('define material "m" 2, col[1][1], col[1][2], col[1][3]\n'), []);
});

test('a channel out of [0.0..1.0] is not a colour', () => {
	// The guide gives every one of these as [0.0..1.0]. `"255 0 0"` is real —
	// one corpus part writes its red pen that way — and is not a GDL colour.
	assert.deepEqual(swatches('define material "m" 2, 255, 0, 0\n'), []);
	assert.deepEqual(swatches('n = request ("PEN_OF_RGB", "255 0 0", _redpen)\n'), []);
	assert.deepEqual(swatches('define material "m" 2, -0.5, 0, 0\n'), []);
});

test('DEFINE MATERIAL BASED_ON is a different command', () => {
	// Its arguments are `name = value` pairs, not a triple — and it shares the
	// first two words, with or without the optional comma after the name.
	assert.deepEqual(swatches('define material "s" based_on matName parameters gs_mat_transparent = 0.5\n'), []);
	assert.deepEqual(swatches('define material "s",\n\tbased_on _srf,\n\tparameters gs_mat_surface_r = 0.8\n'), []);
});

test('PEN_OF_RGB: the swatch sits inside the quotes', () => {
	// 37 corpus calls spell white exactly this way.
	assert.deepEqual(swatches('request("Pen_of_RGB", "1 1 1", _pen_white)\n'), [['1 1 1', [1, 1, 1]]]);
	assert.deepEqual(swatches('request("pen_of_RGB", "0.9 0.1 0.1", _pen_red)\n'), [
		['0.9 0.1 0.1', [0.9, 0.1, 0.1]],
	]);
});

test('only the PEN_OF_RGB question opens a colour', () => {
	// `RGB_OF_PEN` answers with the colour, it is not given one; and no other
	// request reads a triple out of a string.
	assert.deepEqual(swatches('request("RGB_OF_PEN", 1, r, g, b)\n'), []);
	assert.deepEqual(swatches('text2 0, 0, "1 1 1"\n'), []);
	// A variable the script never assigns a literal to has no colour to show.
	assert.deepEqual(swatches('request("Pen_of_RGB", rgb_white, _pen_white)\n'), []);
});

test('picking rewrites only the numbers, keeping the separators', () => {
	// The tab alignment is the author's, and `format.ts` put it there.
	assert.equal(
		pick('define material "m" 0,\n\t1.000000,\t1.000000,\t1.000000,\n\t0.5\n', [0, 0.5, 1]),
		'define material "m" 0,\n\t0,\t0.5,\t1,\n\t0.5\n',
	);
	assert.equal(pick('request("Pen_of_RGB", "1 1 1", p)\n', [1, 0, 0]), 'request("Pen_of_RGB", "1 0 0", p)\n');
});

test('a comment wrapped into the middle of a triple survives the edit', () => {
	// `Mat_1` in the corpus wraps its surface RGB across lines with the guide's
	// own `!surface RGB` note between the channels. Replacing the whole span
	// with a freshly formatted triple would delete it.
	const source = 'define material "Mat_1" 0,\n\t0.752941, ! surface RGB\n\t0.752941, 0.752941,\n\t0.5\n';
	assert.equal(
		pick(source, [1, 1, 1]),
		'define material "Mat_1" 0,\n\t1, ! surface RGB\n\t1, 1,\n\t0.5\n',
	);
});

test('a picked colour is written to six decimals, and round-trips', () => {
	// The picker quantises to 8 bits, so six places name every colour it can
	// return exactly — `0.329412` is 84/255, as the corpus writes it.
	const written = pick('define material "m" 2, 0, 0, 0\n', [84 / 255, 1, 0]);
	assert.equal(written, 'define material "m" 2, 0.329412, 1, 0\n');
	assert.deepEqual(swatches(written)[0][1], [0.329412, 1, 0]);
});

test('no presentation is offered that would push a line past 255 characters', () => {
	// Alignment only ever lengthens a line, and Archicad fails a script with a
	// longer one rather than truncating it — the call `format.ts` makes too.
	const statement = 'define material "m" 2, 0, 0, 0';
	const pad = ' '.repeat(254 - statement.length - ' ! x'.length);
	const source = `${statement}${pad} ! x\n`;
	assert.equal(source.split('\n')[0].length, 254);
	// The colour is still shown…
	assert.equal(swatches(source).length, 1);
	// …but picking a longer one is declined rather than breaking the script.
	assert.equal(pick(source, [84 / 255, 84 / 255, 84 / 255]), source);
	// A colour that fits is still offered.
	assert.equal(pick(source, [1, 1, 1]), source.replace('2, 0, 0, 0', '2, 1, 1, 1'));
});

test('a single-line conditional does not run past its clause', () => {
	// `1 ELSE` is not a channel, so the clause has to end where THEN/ELSE does.
	assert.deepEqual(swatches('if a then define material "m" 2, 1, 1, 1 else addx 1\n'), [
		['1, 1, 1', [1, 1, 1]],
	]);
});

// --- the indirect spelling ---------------------------------------------------

test('a colour handed to PEN_OF_RGB through a variable is found at its assignment', () => {
	// The shape `aol_signage/2d.gdl` and the two Verkehrs* parts are written in:
	// a table of named colours, then the requests that turn them into pens.
	const source = 'rgb_white = "1 1 1"\nrgb_red = "0.713725 0.078431 0.07451"\n'
		+ 'rrr = request("Pen_of_RGB", rgb_white, _pen_white)\n'
		+ 'rrr = request("Pen_of_RGB", rgb_red, _pen_red)\n';
	assert.deepEqual(swatches(source), [
		['1 1 1', [1, 1, 1]],
		['0.713725 0.078431 0.07451', [0.713725, 0.078431, 0.07451]],
	]);
});

test('the request may come before the assignment, so the whole script is read', () => {
	// Whether `x = "1 1 1"` is a colour depends on a request that may be a
	// hundred lines away in either direction — hence two passes, as in groups.ts.
	assert.deepEqual(swatches('request("Pen_of_RGB", c, p)\nc = "0 1 0"\n'), [['0 1 0', [0, 1, 0]]]);
});

test('only a variable actually handed over is followed', () => {
	// `_other` is never requested, so its string is just a string.
	assert.deepEqual(swatches('_other = "1 1 1"\nrequest("Pen_of_RGB", c, p)\nc = "0 0 0"\n'), [
		['0 0 0', [0, 0, 0]],
	]);
});

test('a computed argument names nothing that can be followed', () => {
	// `Color Tool AOL/2d.gdl` builds its string with `str()`, and
	// `NURBSGDLTemplate/3d.gdl` with `STRSUB` — 3 of the corpus's 88 calls are
	// unknowable this way, and none of them is offered a swatch.
	const source = 'a = "1 1 1"\nb = "0 0 0"\nrequest("pen_of_rgb", a + " " + b, p)\n';
	assert.deepEqual(swatches(source), []);
});

test('the assignment obeys indirect.ts: a comparison is not one', () => {
	// `=` is both operators in GDL, as everywhere else here.
	assert.deepEqual(swatches('request("Pen_of_RGB", c, p)\nif c = "1 1 1" then addx 1\n'), []);
	// And only a lone literal counts — a built-up string is unknowable.
	assert.deepEqual(swatches('request("Pen_of_RGB", c, p)\nc = "1 1 " + s\n'), []);
});

test('the variable may be a whole path, on both sides', () => {
	// Colours are routinely tabulated into an array and picked out by index.
	assert.deepEqual(swatches('_rgb[1] = "1 0 0"\nrequest("Pen_of_RGB", _rgb[i], p)\n'), [
		['1 0 0', [1, 0, 0]],
	]);
});

test('an indirect swatch is picked at its assignment, quoting untouched', () => {
	// The leading space inside `_rgb_grey` is the author's; three corpus parts
	// write it that way, and it survives the edit.
	const source = "_rgb_grey = ' 0.51 0.53 0.54'\nrequest(\"Pen_of_RGB\", _rgb_grey, p)\n";
	assert.equal(pick(source, [1, 1, 1]), "_rgb_grey = ' 1 1 1'\nrequest(\"Pen_of_RGB\", _rgb_grey, p)\n");
});
