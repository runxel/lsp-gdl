/**
 * The parameter script reaches no other script.
 *
 * Confirmed by the project owner: `vl.gdl` runs only on certain occasions, and
 * nothing it does — a variable, a `DIM`, a `DEFINE` — is visible to any other
 * script. Its one way back into the object is `PARAMETERS`, which writes a
 * parameter. The master script is the opposite case, being prepended to every
 * other script.
 *
 * Every feature that reads across scripts is pinned here against that rule,
 * each case set beside its master-script twin so the difference is the point.
 * An earlier version gave `vl.gdl` the master's reach, and no test noticed.
 *
 * The scripts are supplied through the resolver, URI'd into `TestObject` so the
 * library part around them is real; every script not supplied reads as empty,
 * which keeps the fixture's own text out of the way.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import type { TextResolver } from '../gdl/masterScript';
import { provideArrayDiagnostics } from '../providers/arrays';
import { provideAttributeDiagnostics } from '../providers/attributes';
import { provideDefinition } from '../providers/definition';
import { provideRename } from '../providers/rename';
import { provideUnusedDiagnostics } from '../providers/unused';
import { declaredValues } from '../gdl/valueLists';

const FIXTURES = join(__dirname, '..', '..', '..', 'TestObject');
const scriptUri = (script: string) => URI.file(join(FIXTURES, 'TestObject', 'scripts', script)).toString();

/** The script under test, and the siblings around it; everything else is empty. */
function part(script: string, text: string, siblings: Record<string, string>) {
	const uri = scriptUri(script);
	const resolve: TextResolver = (u) => {
		if (u === uri) return text;
		for (const [name, source] of Object.entries(siblings)) if (u === scriptUri(name)) return source;
		return '';
	};
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return { doc: analyze(uri, text), td, resolve };
}

const messages = (diagnostics: { message: string }[]) => diagnostics.map((d) => d.message.split('`')[1]);

test('a pen set only in the parameter script reads as 0 elsewhere', () => {
	const fromVl = part('3d.gdl', 'pen penFrame', { 'vl.gdl': 'penFrame = 3' });
	assert.deepEqual(messages(provideAttributeDiagnostics(fromVl.doc, fromVl.td, fromVl.resolve)), ['penFrame']);

	const fromMaster = part('3d.gdl', 'pen penFrame', { '1d.gdl': 'penFrame = 3' });
	assert.deepEqual(provideAttributeDiagnostics(fromMaster.doc, fromMaster.td, fromMaster.resolve), []);
});

test('a DIM in the parameter script declares nothing elsewhere', () => {
	const fromVl = part('3d.gdl', 'x = aWidths[1]', { 'vl.gdl': 'dim aWidths[]' });
	assert.deepEqual(messages(provideArrayDiagnostics(fromVl.doc, fromVl.td, fromVl.resolve)), ['aWidths']);

	const fromMaster = part('3d.gdl', 'x = aWidths[1]', { '1d.gdl': 'dim aWidths[]' });
	assert.deepEqual(provideArrayDiagnostics(fromMaster.doc, fromMaster.td, fromMaster.resolve), []);
});

test('a parameter-script variable read only by a sibling is still unused', () => {
	// The 2D script's `nRows` is a different variable, and reads 0.
	const vl = part('vl.gdl', 'nRows = A / 2', { '2d.gdl': 'pen nRows' });
	assert.deepEqual(messages(provideUnusedDiagnostics(vl.doc, vl.td, vl.resolve)), ['nRows']);

	const master = part('1d.gdl', 'nRows = A / 2', { '2d.gdl': 'pen nRows' });
	assert.deepEqual(provideUnusedDiagnostics(master.doc, master.td, master.resolve), []);
});

test("the master's subroutines still read a parameter-script variable", () => {
	// The master is prepended to `vl.gdl` like any other script.
	const vl = part('vl.gdl', 'nRows = A / 2\ngosub "rows"', { '1d.gdl': 'end\n"rows":\npen nRows\nreturn' });
	assert.deepEqual(provideUnusedDiagnostics(vl.doc, vl.td, vl.resolve), []);
});

test('renaming a parameter-script variable stays in the parameter script', () => {
	const siblings = { '2d.gdl': 'nRows = 1\npen nRows' };
	const vl = part('vl.gdl', 'nRows = 3\nx = nRows', siblings);
	const edit = provideRename(vl.doc, vl.td, vl.td.positionAt(1), 'nLines', vl.resolve);
	assert.deepEqual(Object.keys(edit?.changes ?? {}), [scriptUri('vl.gdl')]);

	// …and from the other side, the 2D variable does not reach into it either.
	const twoD = part('2d.gdl', siblings['2d.gdl'], { 'vl.gdl': 'nRows = 3\nx = nRows' });
	const back = provideRename(twoD.doc, twoD.td, twoD.td.positionAt(1), 'nLines', twoD.resolve);
	assert.deepEqual(Object.keys(back?.changes ?? {}), [scriptUri('2d.gdl')]);
});

test('a master-script variable still renames across the part, parameter script included', () => {
	const vl = 'x = nRows';
	const master = part('1d.gdl', 'nRows = 3', { 'vl.gdl': vl, '2d.gdl': 'pen nRows' });
	const edit = provideRename(master.doc, master.td, master.td.positionAt(1), 'nLines', master.resolve);
	assert.deepEqual(Object.keys(edit?.changes ?? {}).sort(), ['1d.gdl', '2d.gdl', 'vl.gdl'].map(scriptUri).sort());
});

test('a style defined in the parameter script is not a definition elsewhere', () => {
	const source = 'set style "Label"';
	const define = 'define style "Label" "Arial", 2, 5, 0';

	const fromVl = part('2d.gdl', source, { 'vl.gdl': define });
	assert.equal(provideDefinition(fromVl.doc, fromVl.td, fromVl.td.positionAt(12), fromVl.resolve), null);

	const fromMaster = part('2d.gdl', source, { '1d.gdl': define });
	assert.ok(provideDefinition(fromMaster.doc, fromMaster.td, fromMaster.td.positionAt(12), fromMaster.resolve));
});

test("a VALUES constant only the parameter script defines is offered as its number", () => {
	// The list itself holds everywhere — it restricts the parameter — but the
	// constant reads 0 outside `vl.gdl`.
	const vl = 'COOK_ONE = 1\nvalues{2} "iDetailLevel" COOK_ONE, "one", COOK_NONE, "none"';
	const offered = (script: string, siblings: Record<string, string>) => {
		const { doc, resolve } = part(script, siblings[script] ?? '', siblings);
		return declaredValues('iDetailLevel', doc, resolve).map((v) => [v.insert, v.meaning]);
	};

	// `COOK_NONE` has no number at all, so outside `vl.gdl` there is nothing to offer for it.
	assert.deepEqual(offered('2d.gdl', { 'vl.gdl': vl }), [['1', 'one']]);
	assert.deepEqual(offered('vl.gdl', { 'vl.gdl': vl }), [
		['COOK_ONE', 'one'],
		['COOK_NONE', 'none'],
	]);
	// Defined in the master, the name reaches the 2D script and is what to write.
	assert.deepEqual(offered('2d.gdl', { 'vl.gdl': vl.replace('COOK_ONE = 1\n', ''), '1d.gdl': 'COOK_ONE = 1' }), [
		['COOK_ONE', 'one'],
	]);
});
