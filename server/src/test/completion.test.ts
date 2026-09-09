/**
 * Completion tests, run against the real HSF fixture.
 *
 * The interesting part is the master script: it runs before every other script,
 * so what it assigns is shared state the whole library part can read.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { URI } from 'vscode-uri';
import { analyze } from '../gdl/analyzer';
import { CompletionItemKind } from 'vscode-languageserver/node';
import { provideCompletion } from '../providers/completion';
import { setReferenceRoot } from '../gdl/referenceDocs';

const OBJECT_ROOT = join(__dirname, '..', '..', '..', 'TestObject', 'TestObject');
const scriptUri = (name: string) => URI.file(join(OBJECT_ROOT, 'scripts', name)).toString();

/** Nothing open in an editor, so the master script is read from disk. */
const noOpenDocs = () => undefined;

function complete(script: string, text?: string) {
	const uri = scriptUri(script);
	const source = text ?? readFileSync(URI.parse(uri).fsPath, 'utf8');
	return provideCompletion(analyze(uri, source), noOpenDocs);
}

const labelsFrom = (items: ReturnType<typeof complete>, detail: string) =>
	items.filter((i) => i.detail === detail).map((i) => i.label);

/**
 * Everything 1d.gdl publishes: `gDetailFactor`, and the named values it defines
 * for `iMarkerDir` — which are ordinary master-script variables, whatever they
 * are used for later.
 */
const MASTER_NAMES = [
	'gDetailFactor',
	'DIR_PERPENDICULAR',
	'DIR_ALIGNED',
	'DIR_HORIZONTAL',
	'DIR_VERTICAL',
	'stMarkerDir',
];

test('master script variables are offered in the other scripts', () => {
	// gDetailFactor is assigned in 1d.gdl and is in scope everywhere.
	assert.deepEqual(labelsFrom(complete('3d.gdl'), 'master script variable'), MASTER_NAMES);
	assert.deepEqual(labelsFrom(complete('2d.gdl', 'count = 1'), 'master script variable'), MASTER_NAMES);
});

test('underscore-prefixed master variables stay private', () => {
	// `_scratchAngle` is assigned in 1d.gdl but marked private by convention.
	assert.equal(
		complete('3d.gdl').some((i) => i.label === '_scratchAngle'),
		false,
	);
	assert.equal(
		complete('vl.gdl').some((i) => i.label === '_scratchAngle'),
		false,
	);
});

test('the master script does not offer its own variables twice', () => {
	const items = complete('1d.gdl');
	assert.deepEqual(labelsFrom(items, 'master script variable'), []);
	// They are still there as ordinary local variables of this script.
	assert.equal(items.some((i) => i.label === 'gDetailFactor'), true);
	assert.equal(items.some((i) => i.label === '_scratchAngle'), true);
});

test('parameters outrank master variables and local ones', () => {
	const items = complete('3d.gdl');
	const sortOf = (label: string) => items.find((i) => i.label === label)?.sortText ?? '';
	assert.ok(sortOf('zzyzx') < sortOf('gDetailFactor'), 'parameter should sort before master var');
	assert.ok(sortOf('gDetailFactor') < sortOf('BLOCK'), 'master var should sort before keywords');
});

test('a name is offered once, by its most specific source', () => {
	const labels = complete('3d.gdl').map((i) => i.label);
	assert.equal(new Set(labels).size, labels.length, 'completion labels must be unique');
});

test('keywords are still filtered by script kind', () => {
	const items = complete('3d.gdl');
	assert.equal(items.some((i) => i.label === 'BLOCK'), true);
	assert.equal(items.some((i) => i.label === 'CIRCLE2'), false);
	assert.equal(items.some((i) => i.label === 'UI_PAGE'), false);
});


// --- values, which outrank every other source ---------------------------------

/**
 * Completes at the cursor marked `\u2038`, which is removed first. `triggered`
 * says the editor fired on the operator rather than being asked.
 */
function completeAt(script: string, text: string, triggered: boolean) {
	const offset = text.indexOf('\u2038');
	assert.notEqual(offset, -1, 'the test text must carry a cursor');
	const source = text.slice(0, offset) + text.slice(offset + 1);
	const uri = scriptUri(script);
	return provideCompletion(analyze(uri, source), noOpenDocs, { offset, triggered });
}

const valueLabels = (items: ReturnType<typeof completeAt>) =>
	items.filter((i) => i.kind === CompletionItemKind.EnumMember).map((i) => i.label);

test('the operator answers with values and nothing else', () => {
	// iMarkerDir is restricted by vl.gdl to four named values from 1d.gdl.
	const items = completeAt('3d.gdl', 'if iMarkerDir = \u2038', true);
	assert.deepEqual(items.map((i) => i.label), [
		'DIR_PERPENDICULAR',
		'DIR_ALIGNED',
		'DIR_HORIZONTAL',
		'DIR_VERTICAL',
	]);
	// The caption rides along in `detail`, where the list itself shows it.
	assert.equal(items[0].detail, 'Perpendicular to the marker axis');
});

test('the space after the operator still answers', () => {
	// The space is what closes the list VS Code opened on the `=`, so it is a
	// trigger character too — see `server.ts`. Nobody writes `iMarkerDir =DIR…`,
	// so this is the path the feature is actually used through.
	const labels = (text: string) => completeAt('3d.gdl', text, true).map((i) => i.label);
	assert.deepEqual(labels('if iMarkerDir =\u2038'), labels('if iMarkerDir = \u2038'));
	// However much of it there is, and whichever operator it follows.
	assert.deepEqual(labels('if iMarkerDir =   \u2038').length, 4);
	assert.deepEqual(labels('if iMarkerDir =\t\u2038').length, 4);
	assert.deepEqual(labels('if iMarkerDir <> \u2038').length, 4);
	assert.deepEqual(labels('if iMarkerDir # \u2038').length, 4);
	// A space that follows something else is not a value position.
	assert.deepEqual(labels('if iMarkerDir = 1 \u2038'), []);
	assert.deepEqual(labels('addx 1 \u2038'), []);
});

test('the operator says nothing where no values are known', () => {
	// A plain variable has no value list, and popping the whole keyword table
	// after every assignment in the file would be a nuisance.
	assert.deepEqual(completeAt('3d.gdl', 'count = \u2038', true), []);
	assert.deepEqual(completeAt('3d.gdl', 'addx \u2038', true), []);
});

test('being asked puts the values first and keeps the ordinary list', () => {
	const items = completeAt('3d.gdl', 'if iMarkerDir = \u2038', false);
	assert.deepEqual(valueLabels(items), [
		'DIR_PERPENDICULAR',
		'DIR_ALIGNED',
		'DIR_HORIZONTAL',
		'DIR_VERTICAL',
	]);
	// `iMarkerDir = iDefaultDir` is perfectly good GDL, so the names stay.
	assert.equal(items.some((i) => i.label === 'bShowFrame'), true);
	assert.equal(items.some((i) => i.label === 'BLOCK'), true);
	// …but the values sort above all of them.
	const first = [...items].sort((a, b) => (a.sortText ?? '').localeCompare(b.sortText ?? ''))[0];
	assert.equal(first.label, 'DIR_PERPENDICULAR');
});

test('a global is answered from the reference guide', () => {
	// The guide is not vendored, so a page is rebuilt in the shape it ships in —
	// the same arrangement `hover.test.ts` and `valueLists.test.ts` use.
	const root = mkdtempSync(join(tmpdir(), 'gdl-completion-'));
	writeFileSync(
		join(root, 'GLOB_VIEW_TYPE.html'),
		`<html><body class="gdlglobal"><table>
			<tr><td><b>GLOB_VIEW_TYPE</b></td><td>type of current view</td></tr>
			<tr><td colspan="2" style="padding-left:1em; font-style: italic">
				<p>2 - 2D (Floor Plan)</p><p>3 - 3D</p>
			</td></tr>
		</table></body></html>`,
		'utf8',
	);
	try {
		setReferenceRoot(root);
		const items = completeAt('3d.gdl', 'if GLOB_VIEW_TYPE = \u2038', true);
		assert.deepEqual(items.map((i) => `${i.label}:${i.detail}`), ['2:2D (Floor Plan)', '3:3D']);
	} finally {
		setReferenceRoot(undefined);
		rmSync(root, { recursive: true, force: true });
	}
});

test('asking outside a value position is the ordinary list', () => {
	// The feature is additive: nothing about the old behaviour moves.
	const plain = provideCompletion(analyze(scriptUri('3d.gdl'), 'count = 1'), noOpenDocs);
	const asked = completeAt('3d.gdl', 'count = 1\naddx \u2038', false);
	assert.deepEqual(valueLabels(asked), []);
	assert.deepEqual(asked.map((i) => i.label).sort(), plain.map((i) => i.label).sort());
});
