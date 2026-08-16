/**
 * Completion tests, run against the real HSF fixture.
 *
 * The interesting part is the master script: it runs before every other script,
 * so what it assigns is shared state the whole library part can read.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { URI } from 'vscode-uri';
import { analyze } from '../gdl/analyzer';
import { provideCompletion } from '../providers/completion';

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

test('master script variables are offered in the other scripts', () => {
	// gDetailFactor is assigned in 1d.gdl and is in scope everywhere.
	assert.deepEqual(labelsFrom(complete('3d.gdl'), 'master script variable'), ['gDetailFactor']);
	assert.deepEqual(
		labelsFrom(complete('2d.gdl', 'count = 1'), 'master script variable'),
		['gDetailFactor'],
	);
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
