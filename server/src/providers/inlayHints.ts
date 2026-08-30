/**
 * Inline decoding of bitmask arguments.
 *
 * `poly2_b 5, 1 + 2 + 64, gs_fill_pen, gs_back_pen,` is unreadable on its face.
 * The mask is written as a sum because the bits have names, and the guide gives
 * them: this puts those names back beside the number.
 *
 * ## Where a hint is allowed
 *
 * **Only in the fixed part of the signature — never in the repeating tail.**
 * `POLY2_`'s `si` is a bitmask too, one per vertex, and a `POLY2_B` with forty
 * vertices would take forty hints; the statement would disappear under its own
 * annotation. `commandDocs.ts` already knows where the repeat begins, so the
 * rule is exact rather than a guess. It is the same judgement `format.ts` makes
 * when it aligns the table but leaves the preamble alone — the fixed head of an
 * argument list is a different kind of thing from the stream that follows it.
 *
 * **Only a value built from literals.** 2610 of the corpus's 2972 `POLY2*`
 * masks are a sum of constants and decode exactly; the other 341 read a
 * variable (`1 + 2 * has_fill + 4`) and are unknowable without running the
 * script, which is where every other feature here stops too.
 *
 * A wrong hint is worse than none: it sits in the buffer permanently and reads
 * as fact, where a wrong popup is dismissed and forgotten. Hence both limits.
 */

import { InlayHintKind, MarkupKind, type InlayHint, type Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { GdlDocument } from '../gdl/analyzer';
import { foldConstant, splitArguments } from '../gdl/arguments';
import { commandDoc } from '../gdl/commandDocs';
import { maskLabel, maskTable } from './masks';

export function provideInlayHints(
	gdl: GdlDocument,
	textDocument: TextDocument,
	range: Range,
): InlayHint[] {
	const hints: InlayHint[] = [];
	const from = textDocument.offsetAt(range.start);
	const to = textDocument.offsetAt(range.end);

	for (const stmt of gdl.statements) {
		// A statement is joined across its continuation lines, so a wrapped
		// argument list counts as overlapping if any part of it is on screen.
		if (stmt.end < from || stmt.start > to) continue;
		if (!stmt.head) continue;

		const doc = commandDoc(stmt.head);
		if (!doc || doc.masks.size === 0) continue;

		const signature = doc.signatures[0];
		if (!signature) continue;

		const fixed = signature.repeat ? signature.repeat.start : signature.params.length;
		const args = splitArguments(stmt);

		for (let i = 0; i < fixed && i < signature.params.length; i++) {
			const bits = doc.masks.get(signature.params[i].name.toLowerCase());
			if (!bits) continue;

			const arg = args[i];
			if (!arg?.tokens.length) continue;

			const value = foldConstant(arg.tokens);
			if (value === undefined) continue;

			const label = maskLabel(bits, value);
			if (!label) continue;

			const last = arg.tokens[arg.tokens.length - 1];
			// Past the end of the visible range the client would not show it.
			if (last.end < from || last.end > to) continue;

			hints.push({
				position: textDocument.positionAt(last.end),
				label,
				kind: InlayHintKind.Parameter,
				paddingLeft: true,
				tooltip: {
					kind: MarkupKind.Markdown,
					value: `\`${signature.params[i].name}\` = ${value}\n\n${maskTable(bits)}`,
				},
			});
		}
	}

	return hints;
}
