/**
 * Reference-guide parsing tests.
 *
 * The pages here are written by the test in the shape the real ones have —
 * the guide's own text is never copied into this repo. What is being pinned
 * down is the awkward part of that shape: the availability matrix, which draws
 * its answers as tick and cross *images* and merges cells when several columns
 * share one mark.
 */

import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { referenceDoc, setReferenceRoot } from '../gdl/referenceDocs';
import { keywordsFor, lookup, validScripts } from '../gdl/keywords';

const root = mkdtempSync(join(tmpdir(), 'gdl-reference-'));
after(() => rmSync(root, { recursive: true, force: true }));

const CHECK = '<img alt="Check" style="width:50%;" src="Images/GDL_Images/GDL_CheckIcon.png"/>';
const ERROR = '<img alt="Error" style="width:50%;" src="Images/GDL_Images/GDL_ErrorIcon.png"/>';

/** One cell of the matrix: a label div followed by its mark div. */
const cell = (label: string, mark: string) =>
	`<div style="display: table-cell; width: 12%;">${label}</div><div style="display: table-cell; width: 4%;">${mark}</div>`;

/**
 * A page in the shape the guide uses for globals. `matrix` is the row's cells,
 * already paired up; omitting it makes a page with no availability row, which
 * three quarters of the real ones are.
 */
function writePage(name: string, summary: string, details: string[] = [], matrix?: string) {
	const paragraphs = details.map((d) => `<p>\n    ${d}\n</p>`).join('\n');
	writeFileSync(
		join(root, `${name}.html`),
		`<html><body class="gdlglobal"><table>
			<tr><td style="width:37%"><b>${name}</b></td><td style="width:63%">${summary}</td></tr>
			${matrix ? `<tr colspan="2"><td colspan="2"><div style="display: table;"><div style="display:table-row;vertical-align:middle;">${matrix}</div></div></td></tr>` : ''}
			${details.length ? `<tr><td colspan="2" style="padding-left:1em; font-style: italic">${paragraphs}</td></tr>` : ''}
		</table></body></html>`,
		'utf8',
	);
}

// The everyday shape: one mark per column, and a plain default.
writePage(
	'GLOB_SCALE',
	'test gloss for the drawing scale',
	['test note about the current window'],
	cell('2D', CHECK) + cell('3D', CHECK) + cell('UI', ERROR) + cell('Parameter', ERROR) + cell('Property', ERROR) + cell('Default', '100'),
);
// Merged cells: three columns sharing one cross, and no default value.
writePage(
	'GLOB_VIEW_TYPE',
	'test gloss with merged cells',
	[],
	cell('2D', CHECK) + cell('3D', CHECK) + cell('UI Parameter Property', ERROR) + cell('Default', '-'),
);
// A default that is itself bracketed, which must not read as a mark.
writePage(
	'GLOB_PROJECT_DATE',
	'test gloss with an array default',
	[],
	cell('2D', CHECK) + cell('3D', CHECK) + cell('UI', ERROR) + cell('Parameter', ERROR) + cell('Property', CHECK) + cell('Default', '[0, 0, 0, 0, 0, 0]'),
);
// Three quarters of the real pages have no matrix at all.
writePage('SYMB_MIRRORED', 'test gloss for a mirrored part', ['0-no, 1-yes &amp; nothing else']);

test('the matrix says which scripts are ruled out, and the default', () => {
	setReferenceRoot(root);
	const doc = referenceDoc('GLOB_SCALE');
	assert.deepEqual([...(doc?.excludedScripts ?? [])].sort(), ['pr', 'ui', 'vl']);
	assert.equal(doc?.defaultValue, '100');
});

test('a merged cell rules out every column it spans', () => {
	setReferenceRoot(root);
	const doc = referenceDoc('GLOB_VIEW_TYPE');
	assert.deepEqual([...(doc?.excludedScripts ?? [])].sort(), ['pr', 'ui', 'vl']);
	// `-` is the guide's placeholder for "no default", not a value.
	assert.equal(doc?.defaultValue, undefined);
});

test('a bracketed default is text, not a mark', () => {
	setReferenceRoot(root);
	const doc = referenceDoc('GLOB_PROJECT_DATE');
	assert.equal(doc?.defaultValue, '[0, 0, 0, 0, 0, 0]');
	// Property is ticked here, so only UI and the parameter script are out.
	assert.deepEqual([...(doc?.excludedScripts ?? [])].sort(), ['ui', 'vl']);
});

test('a page with no matrix rules nothing out', () => {
	setReferenceRoot(root);
	const doc = referenceDoc('SYMB_MIRRORED');
	assert.ok(doc, 'the page should still parse');
	assert.equal(doc.excludedScripts, undefined);
	assert.equal(doc.defaultValue, undefined);
});

test('the matrix narrows where a keyword is valid', () => {
	setReferenceRoot(root);
	const kw = lookup('GLOB_SCALE');
	assert.ok(kw, 'GLOB_SCALE should be in the keyword table');
	// The vendored list credits every global to every script.
	assert.equal(kw.scripts.length, 8);
	assert.deepEqual([...validScripts(kw)], ['1d', '2d', '3d', 'fwm', 'bwm']);
	// Which is what completion offers from.
	assert.ok(!keywordsFor('vl').some((k) => k.name === 'GLOB_SCALE'));
	assert.ok(keywordsFor('2d').some((k) => k.name === 'GLOB_SCALE'));
});

test('the matrix never widens a keyword', () => {
	setReferenceRoot(root);
	// SYMB_MIRRORED has no matrix, so the keyword table has the only answer —
	// and a hand-narrowed entry in data/keywords.gdl must survive untouched.
	const kw = lookup('SYMB_MIRRORED');
	assert.ok(kw);
	assert.deepEqual([...validScripts(kw)], [...kw.scripts]);
});

test('without the reference guide the keyword table stands alone', () => {
	setReferenceRoot(undefined);
	const kw = lookup('GLOB_SCALE');
	assert.ok(kw);
	assert.equal(validScripts(kw).length, 8);
	assert.ok(keywordsFor('vl').some((k) => k.name === 'GLOB_SCALE'));
});
