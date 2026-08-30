/**
 * Where a script stops.
 *
 * `END` and `EXIT` are one another's synonyms — the reference guide gives them
 * a single page — and either ends the current script, optionally handing return
 * values back to the macro that called it. The guide is explicit that a file may
 * hold several of them, and that is what makes them worth marking: in a long
 * `3d.gdl` the terminator is a three-letter word in the left margin, and what
 * follows it is subroutines rather than more of the body.
 *
 * Nothing here is a diagnostic. The client rules a line under the statement and
 * ticks the overview ruler beside it; all this decides is which line that is.
 */

import type { Range } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { GdlDocument } from '../gdl/analyzer';

/**
 * The line each `END` / `EXIT` statement finishes on, as a range over its last
 * token — the client draws whole-line, so only that line is read.
 *
 * Two rules, and the corpus decided both:
 *
 * - **`stmt.head` is not read.** `IF NOT (BITTEST (macro_runtype, 4)) THEN END`
 *   is the idiomatic early-out, so the terminator usually sits mid-statement.
 *   Every token is walked, as in `groups.ts` and `labels.ts`.
 * - **The anchor is the end of the *statement*, not of the keyword.** The return
 *   list wraps like any other argument list, and 98 of the corpus's 1781
 *   terminators do wrap — one over 52 lines. The rule belongs under the last
 *   returned variable, not under the `END` that opened the list.
 *
 * Taking the statement's end is safe because nothing can follow the return list
 * within the statement: no corpus terminator is followed by an `ELSE`, so there
 * is no later clause whose end would be the wrong anchor. One range per
 * statement for the same reason.
 *
 * A string or comment holding the word is not an identifier token, so neither
 * reaches here — which matters, since `! ===== end =====` banners are common.
 * Nothing in the corpus assigns to a name of either spelling; both are reserved
 * control statements, so nothing can.
 */
export function provideScriptEndMarkers(doc: GdlDocument, textDocument: TextDocument): Range[] {
	const ranges: Range[] = [];

	for (const stmt of doc.statements) {
		const terminates = stmt.tokens.some(
			(token) => token.type === 'identifier' && (token.lower === 'end' || token.lower === 'exit'),
		);
		if (!terminates) continue;

		const last = stmt.tokens[stmt.tokens.length - 1];
		ranges.push({
			start: textDocument.positionAt(last.start),
			end: textDocument.positionAt(last.end),
		});
	}

	return ranges;
}
