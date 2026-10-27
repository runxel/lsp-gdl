/**
 * Folding ranges.
 *
 * Registering the provider switches VS Code's indentation folding off for the
 * language, so a shape left out here is a fold the author used to have and
 * lost. Ranges are given as `[startLine, endLine]`, 0-based, with the kind
 * appended where there is one.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideFoldingRanges } from '../providers/folding';

const uri = 'file:///part/scripts/3d.gdl';

function folds(...lines: string[]): (number | string)[][] {
	const text = lines.join('\n') + '\n';
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideFoldingRanges(analyze(uri, text), td).map((r) =>
		r.kind ? [r.startLine, r.endLine, r.kind] : [r.startLine, r.endLine],
	);
}

test('every block folds to the line before its closer', () => {
	assert.deepEqual(folds('for i = 1 to n', '\tadd 1, 0, 0', '\tblock 1, 1, 1', 'next i'), [[0, 2]]);
	assert.deepEqual(folds('while a < 3 do', '\ta = a + 1', 'endwhile'), [[0, 1]]);
	assert.deepEqual(folds('do', '\ta = a + 1', 'while a < 3'), [[0, 1]]);
	assert.deepEqual(folds('repeat', '\ta = a + 1', 'until a > 3'), [[0, 1]]);
	assert.deepEqual(folds('group "gr_leg"', '\tblock 1, 1, 1', 'endgroup'), [[0, 1]]);
	assert.deepEqual(folds('paragraph "p" 1, 0, 0, 0, 1', '\t"text"', 'endparagraph'), [[0, 1]]);
});

test('an unindented block folds, which indentation folding could not do', () => {
	assert.deepEqual(folds('if a then', 'block 1, 1, 1', 'addz 1', 'endif'), [[0, 2]]);
});

test('an IF with an ELSE folds as two branches', () => {
	assert.deepEqual(folds('if a then', '\tx = 1', 'else', '\tx = 2', 'endif'), [[0, 1], [2, 3]]);
});

test('the chained form nests', () => {
	// The shape CLAUDE.md quotes under "Statements and blocks".
	assert.deepEqual(
		folds('IF a THEN x = 1 ELSE', '\tIF b THEN y = 2 ELSE', '\t\tz = 3', '\tENDIF', 'ENDIF'),
		[[0, 3], [1, 2]],
	);
});

test('a one-line block has nothing to fold', () => {
	assert.deepEqual(folds('FOR i = 1 TO n : CUTEND : NEXT i'), []);
	assert.deepEqual(folds('if a then b = 1'), []);
	assert.deepEqual(folds('if a then', 'endif'), []);
});

test('a wrapped condition folds with its block, not apart from it', () => {
	// The condition's own fold would start on the same line; the block's wins.
	assert.deepEqual(
		folds('if  a = 1 |\\', '    b = 2  \\', 'then', '\tx = 1', 'endif'),
		[[0, 3]],
	);
});

test('a missing ENDIF costs its own fold and no other', () => {
	// `checkBlocks` reports the unclosed IF; the FOR around it still folds.
	assert.deepEqual(folds('for i = 1 to n', '\tif a then', '\t\tx = 1', 'next i'), [[0, 2]]);
	assert.deepEqual(folds('if a then', '\tx = 1', 'for i = 1 to n', '\tx = 2', 'next i'), [[2, 3]]);
});

test('a wrapped statement folds from its first row to its last', () => {
	assert.deepEqual(
		folds('poly2_b 5, 1+2*bDrawFill+64, gs_fill_pen, gs_back_pen,', '\t0, 0, 1,', '\t1, 0, 1,', '\t1, 1, 1'),
		[[0, 3]],
	);
	// A blank line and a commented-out row do not end a continuation.
	assert.deepEqual(folds('end iUiID_Root,', '', '\tiParID_Shape'), [[0, 2]]);
});

test('a subroutine folds through its RETURN', () => {
	assert.deepEqual(
		folds('gosub "draw handle"', 'end', '', '"draw handle":', '\tblock 1, 1, 1', 'return', '', '100:', '\taddz 1', 'return'),
		[[3, 5], [7, 9]],
	);
});

test('an early RETURN inside a block does not end the subroutine', () => {
	assert.deepEqual(
		folds('"sub":', '\tif done then', '\t\treturn', '\tendif', '\tblock 1, 1, 1', 'return'),
		[[0, 5], [1, 2]],
	);
	// The one-line spelling sits deeper too, being a clause of the IF.
	assert.deepEqual(folds('"sub":', '\tif done then return', '\tblock 1, 1, 1', 'return'), [[0, 3]]);
});

test('a label heading no subroutine gets no fold', () => {
	// A GOTO target in the body, falling through into the next label.
	assert.deepEqual(folds('10:', '\ta = a + 1', '20:', '\tb = 1', 'return'), [[2, 4]]);
	// A label inside a block that closes before any RETURN.
	assert.deepEqual(folds('if a then', '100:', '\tx = 1', 'endif', 'return'), [[0, 2]]);
});

test('stacked labels fold as one routine under several names', () => {
	// `bim-all-doors/…/Generic_hinge_macro/3d.gdl`.
	assert.deepEqual(
		folds('"LoD100":', '"LoD200":', '"LoD350":', '\tblock 1, 1, 1', 'return'),
		[[0, 4], [1, 4], [2, 4]],
	);
	// A label with a body of its own still ends the search.
	assert.deepEqual(folds('"a":', '\tx = 1', '"b":', '"c":', '\ty = 1', 'return'), [[2, 5], [3, 5]]);
});

test('code after a label on its line does not hide the label', () => {
	// `500:	LINE2 0, -body_wid, 0` — a label ends its own statement.
	assert.deepEqual(folds('500:\tline2 0, -body_wid, 0', '\tline2 1, 1, 1', 'return'), [[0, 2]]);
});

test('a run of whole-line comments folds as a comment', () => {
	assert.deepEqual(
		folds('! ====================', '! Hotspots', '! ====================', 'hotspot2 0, 0'),
		[[0, 2, 'comment']],
	);
	// A trailing comment is not a comment line, and a blank line ends a run.
	assert.deepEqual(folds('! a', 'block 1, 1, 1 ! b', '! c'), []);
	assert.deepEqual(folds('! a', '! b', '', '! c', '! d'), [[0, 1, 'comment'], [3, 4, 'comment']]);
});

test('region markers fold everything between them, the end marker included', () => {
	assert.deepEqual(
		folds('! #region Hotspots', 'hotspot2 0, 0', 'hotspot2 1, 0', '! #endregion'),
		[[0, 3, 'region']],
	);
	// VS Code's other line-comment spellings: `#` optional, case ignored.
	assert.deepEqual(folds('!region', 'a = 1', '!EndRegion'), [[0, 2, 'region']]);
	assert.deepEqual(folds('\t!  #Region body', '\ta = 1', '\t! #endregion body'), [[0, 2, 'region']]);
});

test('regions nest, and an unmatched marker folds nothing', () => {
	assert.deepEqual(
		folds('! #region outer', '! #region inner', 'a = 1', '! #endregion', 'b = 1', '! #endregion'),
		[[0, 5, 'region'], [1, 3, 'region']],
	);
	assert.deepEqual(folds('! #endregion', 'a = 1', '! #region', 'b = 1'), []);
});

test('a marker is never part of a comment run', () => {
	// The description would otherwise start a fold on the region's line.
	assert.deepEqual(
		folds('! #region Hotspots', '! the corners of the body', '! and its centre', 'hotspot2 0, 0', '! #endregion'),
		[[0, 4, 'region'], [1, 2, 'comment']],
	);
});

test('a marker trailing a command is not a marker', () => {
	assert.deepEqual(folds('a = 1 ! #region', 'b = 1', '! #endregion'), []);
});

test('a region straddling a block loses to the fold that began first', () => {
	// VS Code cannot show crossing ranges; which one survives is decided here.
	assert.deepEqual(
		folds('if a then', '! #region', '\tx = 1', 'endif', '! #endregion'),
		[[0, 2]],
	);
});

test('a string or banner spelling region is not a marker', () => {
	assert.deepEqual(folds('text2 0, 0, "! #region"', 'a = 1', '! #endregion'), []);
	assert.deepEqual(folds('! regional settings', 'a = 1', '! endregional'), []);
});
