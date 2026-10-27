/**
 * Document symbols — the named regions of a script.
 *
 * Each symbol is flattened to `name @ startLine-endLine [selection]`, with its
 * children nested under it, so a test reads like the Outline it produces.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { DocumentSymbol } from 'vscode-languageserver/node';
import { analyze } from '../gdl/analyzer';
import { provideDocumentSymbols } from '../providers/symbols';

const uri = 'file:///part/scripts/2d.gdl';

type Outline = (string | Outline)[];

function outline(...lines: string[]): Outline {
	const text = lines.join('\n') + '\n';
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	const show = (symbols: DocumentSymbol[]): Outline =>
		symbols.flatMap((s) => {
			const sel = s.selectionRange;
			const label =
				`${s.name} @ ${s.range.start.line}-${s.range.end.line} ` +
				`[${sel.start.line}:${sel.start.character}-${sel.end.character}]`;
			return s.children && s.children.length > 0 ? [label, show(s.children)] : [label];
		});
	return show(provideDocumentSymbols(analyze(uri, text), td));
}

test('a named region is listed, its name selected', () => {
	assert.deepEqual(
		outline('a = 1', '! #region Hotspots', 'hotspot2 0, 0', '! #endregion'),
		['Hotspots @ 1-3 [1:10-18]'],
	);
	// Spacing, case and the optional `#` as folding accepts them; the name is
	// trimmed, inner spaces kept.
	assert.deepEqual(
		outline('\t!   #Region   Door leaf  ', '\ta = 1', '\t! #endregion'),
		['Door leaf @ 0-2 [0:15-24]'],
	);
	assert.deepEqual(outline('!region Frame', 'a = 1', '!endregion'), ['Frame @ 0-2 [0:8-13]']);
});

test('square brackets around the name delimit it', () => {
	// `TestObject/…/ui.gdl`, the spelling the project owner writes.
	assert.deepEqual(
		outline('! #region [Listfield Items]', 'a = 1', '! #endregion'),
		['Listfield Items @ 0-2 [0:11-26]'],
	);
	assert.deepEqual(outline('! #region [ Leaf ]', 'a = 1', '! #endregion'), ['Leaf @ 0-2 [0:12-16]']);
	// One enclosing pair only, and empty brackets name nothing.
	assert.deepEqual(outline('! #region [a] and [b]', 'a = 1', '! #endregion'), ['[a] and [b] @ 0-2 [0:10-21]']);
	assert.deepEqual(outline('! #region []', 'a = 1', '! #endregion'), []);
});

test('regions nest in the outline as they do in the script', () => {
	assert.deepEqual(
		outline(
			'! #region Body',
			'! #region Frame',
			'a = 1',
			'! #endregion',
			'! #region Leaf',
			'b = 1',
			'! #endregion',
			'! #endregion',
			'! #region Hotspots',
			'! #endregion',
		),
		['Body @ 0-7 [0:10-14]', ['Frame @ 1-3 [1:10-15]', 'Leaf @ 4-6 [4:10-14]'], 'Hotspots @ 8-9 [8:10-18]'],
	);
});

test('an unnamed region is not listed, and its named children move up', () => {
	assert.deepEqual(
		outline('! #region Body', '! #region', '! #region Leaf', 'b = 1', '! #endregion', '! #endregion', '! #endregion'),
		['Body @ 0-6 [0:10-14]', ['Leaf @ 2-4 [2:10-14]']],
	);
	assert.deepEqual(outline('! #region', 'a = 1', '! #endregion'), []);
});

test('only a matched pair is listed, exactly as folding folds it', () => {
	// The optional `#` makes prose a marker; it has no `#endregion` to close it.
	assert.deepEqual(outline('! region of the sill', 'a = 1'), []);
	assert.deepEqual(outline('! #endregion', '! #region Lost', 'a = 1'), []);
	assert.deepEqual(outline('a = 1 ! #region Trailing', 'b = 1', '! #endregion'), []);
});

test('a byte-order mark does not hide a marker on the first line', () => {
	assert.deepEqual(outline('﻿! #region Head', 'a = 1', '! #endregion'), ['Head @ 0-2 [0:11-15]']);
});

test('nothing but regions is listed', () => {
	// Subroutines, calls and banners are GRAPHISOFT's extension's symbols.
	assert.deepEqual(
		outline('! ======', '! Hotspots', '! ======', 'call "m"', '"sub":', 'return'),
		[],
	);
});
