/**
 * Decoding a bitmask argument into the bits the guide names.
 *
 * `poly2_b 5, 1 + 2 + 64, …` says nothing on its face; `contour + fill + cover
 * fill` says what the command draws. The masks are written as sums precisely
 * because nobody remembers them, and the guide documents every bit — see
 * `gdl/commandDocs.ts` for how the tables are read.
 *
 * Shared by signature help, which shows the whole table while the argument is
 * being typed, and by the inlay hints, which decode the value actually written.
 */

import type { MaskBit } from '../gdl/commandDocs';

/** How long a decoded label may get before it stops being an annotation. */
const MAX_LABEL = 72;
/** And how long any one bit's name may get inside it. */
const MAX_BIT = 24;

/**
 * The whole table, for documentation.
 *
 * A bit the guide never describes is still listed: the weights have to add up,
 * or a reader checking the sum against the table finds it short.
 */
export function maskTable(bits: readonly MaskBit[]): string {
	return bits.map((bit) => `- \`${bit.weight}\` — ${bit.text ?? '_(undocumented)_'}`).join('\n');
}

/**
 * The guide's prose, cut down to something that can sit in a line of code.
 *
 * "fill is cut fill (default is drafting fill)" is a sentence, and three of
 * them side by side is longer than the statement being annotated. The clause
 * before the first bracket or comma is the name of the bit; the rest is the
 * caveat, and it stays in the tooltip.
 *
 * A first clause can still be a mouthful — `POLY2_B{5}`'s `distortion_flags`
 * opens "the fill origin's X coordinate is the global origin's X coordinate",
 * which is 66 characters and was pushing 566 corpus hints past the whole label
 * budget, so that they gave up and read "2 flags". Hence a second cut, at a
 * word boundary, which is worth more than the give-up was.
 */
function shortText(text: string): string {
	const clause = text.split(/[(,;]/)[0].trim().replace(/\s+/g, ' ');
	if (clause.length <= MAX_BIT) return clause;

	const cut = clause.slice(0, MAX_BIT);
	const boundary = cut.lastIndexOf(' ');
	return `${(boundary > MAX_BIT / 2 ? cut.slice(0, boundary) : cut).trimEnd()}\u2026`;
}

/**
 * Every bit set in `value`, most significant last.
 *
 * A weight the guide leaves undescribed, and any leftover the table does not
 * account for, are rendered as bare numbers rather than dropped — a decode that
 * silently omits part of the value is worse than one that admits it.
 */
export function decodeMask(bits: readonly MaskBit[], value: number): string[] | undefined {
	if (!Number.isInteger(value) || value < 0) return undefined;
	// `&` is only meaningful if every weight is a distinct single bit, which is
	// how the guide writes them — but it is checked rather than assumed.
	const weights = bits.map((bit) => bit.weight);
	if (weights.some((w) => w <= 0 || (w & (w - 1)) !== 0)) return undefined;
	if (new Set(weights).size !== weights.length) return undefined;

	const parts: string[] = [];
	let remainder = value;
	for (const bit of [...bits].sort((a, b) => a.weight - b.weight)) {
		if ((value & bit.weight) === 0) continue;
		remainder -= bit.weight;
		parts.push(bit.text ? shortText(bit.text) : String(bit.weight));
	}
	if (remainder > 0) parts.push(String(remainder));
	return parts;
}

/** The decoded value as it is shown inline, or undefined if it says nothing. */
export function maskLabel(bits: readonly MaskBit[], value: number): string | undefined {
	const parts = decodeMask(bits, value);
	if (!parts) return undefined;
	if (parts.length === 0) return 'none';

	const full = parts.join(' + ');
	if (full.length <= MAX_LABEL) return full;

	// Too long to sit in the line: keep as many whole bits as fit, and say how
	// many were dropped rather than trailing off mid-word.
	const kept: string[] = [];
	let width = 0;
	for (const part of parts) {
		if (width + part.length + 3 > MAX_LABEL) break;
		kept.push(part);
		width += part.length + 3;
	}
	if (kept.length === 0) return `${parts.length} flags`;
	return `${kept.join(' + ')} +${parts.length - kept.length} more`;
}
