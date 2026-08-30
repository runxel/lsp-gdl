/**
 * Constant folding and bitmask decoding.
 *
 * Neither needs the reference guide: the bit tables here are written out, so
 * these run everywhere and carry the proof that the arithmetic is right.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tokenize } from '../gdl/lexer';
import { foldConstant } from '../gdl/arguments';
import { decodeMask, maskLabel } from '../providers/masks';
import type { MaskBit } from '../gdl/commandDocs';

/** Folds the first line of `text` as if it were one argument. */
function fold(text: string): number | undefined {
	return foldConstant(tokenize(text).filter((t) => t.type !== 'newline' && t.type !== 'eof'));
}

/** POLY2_'s frame_fill, as the guide gives it. */
const FRAME_FILL: MaskBit[] = [
	{ weight: 1, text: 'draw contour' },
	{ weight: 2, text: 'draw fill' },
	{ weight: 4, text: 'close an open polygon' },
	{ weight: 8, text: 'local fill orientation' },
	{ weight: 32, text: 'fill is cut fill (default is drafting fill)' },
	{ weight: 64, text: 'fill is cover fill (only if j6 = 0)' },
];

test('a sum of literals folds', () => {
	// The shape 2610 of the corpus's 2972 POLY2* masks are written in.
	assert.equal(fold('1 + 2 + 64'), 67);
	assert.equal(fold('2+4'), 6);
	assert.equal(fold('1'), 1);
});

test('precedence and brackets are respected', () => {
	assert.equal(fold('1 + 2 * 4'), 9);
	assert.equal(fold('(1 + 2) * 4'), 12);
	assert.equal(fold('8 / 2 + 1'), 5);
});

test('a unary sign is not an operator', () => {
	// `-` is a sign in GDL and `+` is used for aligning columns; both are real.
	assert.equal(fold('-1'), -1);
	assert.equal(fold('+ 4'), 4);
	assert.equal(fold('2 * -1'), -2);
});

test('anything holding a name does not fold', () => {
	// `1 + 2 * has_fill + 4` — 341 of the corpus's masks, unknowable statically.
	assert.equal(fold('1 + 2 * has_fill + 4'), undefined);
	assert.equal(fold('poly_flag'), undefined);
	assert.equal(fold('"1"'), undefined);
});

test('a malformed expression does not fold', () => {
	assert.equal(fold('1 +'), undefined);
	assert.equal(fold('* 2'), undefined);
	assert.equal(fold('(1 + 2'), undefined);
	assert.equal(fold('1 / 0'), undefined);
	assert.equal(fold(''), undefined);
});

test('a mask decodes to the bits it sets', () => {
	assert.deepEqual(decodeMask(FRAME_FILL, 1 + 2 + 4), [
		'draw contour',
		'draw fill',
		'close an open polygon',
	]);
	assert.deepEqual(decodeMask(FRAME_FILL, 0), []);
	assert.equal(maskLabel(FRAME_FILL, 0), 'none');
});

test('the caveat after the first clause is left for the tooltip', () => {
	// "fill is cut fill (default is drafting fill)" is a sentence; three of them
	// side by side are longer than the statement being annotated.
	assert.deepEqual(decodeMask(FRAME_FILL, 32), ['fill is cut fill']);
});

test('a bit the table does not account for is shown, not dropped', () => {
	// 16 is not in POLY2_'s frame_fill; a decode that silently loses part of the
	// value is worse than one that admits it.
	assert.deepEqual(decodeMask(FRAME_FILL, 1 + 16), ['draw contour', '16']);
	assert.deepEqual(decodeMask([{ weight: 1 }], 1), ['1']);
});

test('a long decode keeps whole bits and counts the rest', () => {
	const label = maskLabel(FRAME_FILL, 1 + 2 + 4 + 8 + 32 + 64) ?? '';
	assert.match(label, /^draw contour \+ draw fill/);
	assert.match(label, /\+\d+ more$/);
});

test('a table whose weights are not distinct single bits is refused', () => {
	// `&` would be meaningless, so nothing is claimed.
	assert.equal(decodeMask([{ weight: 3, text: 'a' }], 3), undefined);
	assert.equal(decodeMask([{ weight: 1, text: 'a' }, { weight: 1, text: 'b' }], 1), undefined);
});

test('a negative or fractional value is refused', () => {
	assert.equal(decodeMask(FRAME_FILL, -1), undefined);
	assert.equal(decodeMask(FRAME_FILL, 1.5), undefined);
});
