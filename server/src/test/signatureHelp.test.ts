/**
 * Signature help and the mask inlay hints.
 *
 * Both read the same table, so both are pinned down here against pages written
 * in the guide's shape (see `commandDocs.test.ts` for why they are synthetic).
 *
 * The case that matters is the repeating tail: `POLY2_B` is four fixed
 * arguments and then three per vertex, so the useful answer forty values in is
 * "`y8`", never "argument 27".
 */

import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { setCommandDocsRoot } from '../gdl/commandDocs';
import { provideSignatureHelp } from '../providers/signatureHelp';
import { provideInlayHints } from '../providers/inlayHints';

const root = mkdtempSync(join(tmpdir(), 'gdl-sighelp-'));
after(() => rmSync(root, { recursive: true, force: true }));

const NB = ' ';

writeFileSync(
	join(root, 'POLY2_B.html'),
	`<html><body class="gdlcommand">
	<pre class="programlisting"><b id="POLY2_B_keyword_1">POLY2_B</b> n, frame_fill, fill_pen, fill_background_pen, x1, y1, s1, ..., xn, yn, sn</pre>
	<div><div><code><b>n:${NB}</b></code>number of nodes.</div></div>
	<div><div><code><b>fill_pen:${NB}</b></code>fill pencolor number.</div></div>
	<div><code>frame_fill${NB}=${NB}j<sub>1</sub>${NB}+${NB}2*j<sub>2</sub>${NB}+${NB}4*j<sub>3</sub>${NB}+${NB}64*j<sub>7</sub></code>, where each j can be 0 or 1.</div>
	<div><code>j<sub>1</sub>:${NB}</code>draw contour,</div>
	<div><code>j<sub>2</sub>:${NB}</code>draw fill,</div>
	<div><code>j<sub>3</sub>:${NB}</code>close an open polygon,</div>
	<div><code>j<sub>7</sub>:${NB}</code>fill is cover fill (only if j6 = 0),</div>
	<div><code>si${NB}=${NB}j<sub>1</sub>${NB}+${NB}16*j<sub>5</sub></code>, where each j can be 0 or 1.</div>
	<div><code>j<sub>1</sub>:${NB}</code>next segment is visible,</div>
	<p>Related in 2D Shapes</p></body></html>`,
	'utf8',
);
setCommandDocsRoot(root);

const uri = URI.file(join('/tmp', 'TestObject', 'scripts', '2d.gdl')).toString();

function docFor(text: string) {
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return { td, gdl: analyze(uri, text) };
}

/** The active parameter's name, as the signature spells it. */
function activeAt(text: string, line: number, character: number): string | undefined {
	const { td, gdl } = docFor(text);
	const help = provideSignatureHelp(gdl, td, { line, character });
	if (!help) return undefined;
	const signature = help.signatures[help.activeSignature ?? 0];
	const active = signature.parameters?.[signature.activeParameter ?? 0];
	if (!active || !Array.isArray(active.label)) return undefined;
	return signature.label.slice(active.label[0], active.label[1]);
}

/** The documentation shown for the active parameter. */
function activeDoc(text: string, line: number, character: number): string {
	const { td, gdl } = docFor(text);
	const help = provideSignatureHelp(gdl, td, { line, character });
	const signature = help?.signatures[help.activeSignature ?? 0];
	const active = signature?.parameters?.[signature.activeParameter ?? 0];
	const value = active?.documentation;
	return typeof value === 'string' ? value : (value?.value ?? '');
}

function hints(text: string): string[] {
	const { td, gdl } = docFor(text);
	return provideInlayHints(gdl, td, {
		start: { line: 0, character: 0 },
		end: { line: 999, character: 0 },
	}).map((h) => String(h.label));
}

const WRAPPED = [
	'poly2_b 5, 1+2+64, gs_fill_pen, gs_back_pen,',
	'\t-RAD, 0,      1,',
	'\t-RAD, -0.007, 1,',
	'\t RAD, 0,      1',
].join('\n');

test('the fixed arguments are counted from the command word', () => {
	assert.equal(activeAt(WRAPPED, 0, 9), 'n');
	assert.equal(activeAt(WRAPPED, 0, 13), 'frame_fill');
	assert.equal(activeAt(WRAPPED, 0, 24), 'fill_pen');
	assert.equal(activeAt(WRAPPED, 0, 38), 'fill_background_pen');
});

test('the cursor on the command word itself is not answered', () => {
	// A popup over a name still being typed is noise.
	assert.equal(activeAt(WRAPPED, 0, 4), undefined);
});

test('an argument past the fixed part folds into the repeating group', () => {
	// The whole point: 27 values in, the useful answer is `y8`, not `argument 27`.
	assert.equal(activeAt(WRAPPED, 1, 2), 'x1');
	assert.equal(activeAt(WRAPPED, 1, 7), 'y1');
	assert.equal(activeAt(WRAPPED, 1, 15), 's1');
	assert.equal(activeAt(WRAPPED, 2, 9), 'y1');
	assert.match(activeDoc(WRAPPED, 2, 9), /this is y2/);
	assert.match(activeDoc(WRAPPED, 3, 15), /this is s3/);
});

test('a bitmask argument carries its table while it is being typed', () => {
	const doc = activeDoc(WRAPPED, 0, 13);
	assert.match(doc, /`1` — draw contour/);
	assert.match(doc, /`64` — fill is cover fill/);
});

test('a command the guide does not cover is not answered', () => {
	assert.equal(activeAt('cprism_ "mat", 4, 1,\n\t0, 0, 15', 1, 3), undefined);
	assert.equal(activeAt('x = 1 + 2', 0, 8), undefined);
});

test('a literal mask is decoded in place', () => {
	assert.deepEqual(hints('poly2_b 4, 1+2, 1, 2, 0, 0, 1'), ['draw contour + draw fill']);
	assert.deepEqual(hints('poly2_b 4, 1 + 2 + 64, 1, 2, 0, 0, 1'), [
		'draw contour + draw fill + fill is cover fill',
	]);
});

test('a mask holding a name is left alone', () => {
	// `1 + 2 * has_fill + 4` — 341 of the corpus's masks, unknowable statically.
	assert.deepEqual(hints('poly2_b 4, 1 + 2 * has_fill + 4, 1, 2, 0, 0, 1'), []);
	assert.deepEqual(hints('poly2_b 4, poly_flag, 1, 2, 0, 0, 1'), []);
});

test('the repeating tail is never hinted', () => {
	// `si` is a bitmask too, one per vertex — a polygon with forty of them would
	// vanish under its own annotation.
	const many = ['poly2_b 3, 1, 1, 2,', '\t0, 0, 1,', '\t1, 0, 1,', '\t1, 1, 1'].join('\n');
	assert.equal(hints(many).length, 1, 'only frame_fill, never the per-vertex si');
});

test('a hint outside the requested range is not returned', () => {
	const { td, gdl } = docFor('poly2_b 4, 1+2, 1, 2, 0, 0, 1\npoly2_b 4, 1+4, 1, 2, 0, 0, 1');
	const first = provideInlayHints(gdl, td, {
		start: { line: 0, character: 0 },
		end: { line: 0, character: 29 },
	});
	assert.equal(first.length, 1);
	assert.match(String(first[0].label), /draw fill/);
});
