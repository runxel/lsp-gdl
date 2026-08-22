/**
 * Brackets left unbalanced.
 *
 *     atn(_stich / ccenters.c[1].x))     <- one `)` too many
 *     x = atn(a / b                      <- and one too few
 *     n = INT(a[1)                       <- closed by the wrong kind
 *
 * The same class of mistake as `operators.ts`: Archicad does not report it
 * where it happens. The script is refused with a single error at the end, so a
 * stray bracket typed halfway up a long parameter list costs a bisect to find.
 *
 * A bracket never spans a statement — `\` and a trailing `,` are already joined
 * in by the analyzer, so anything still open when the statement ends is open for
 * good. That makes the check a plain stack over each statement's tokens.
 *
 * Two things keep it quiet on real code:
 *
 *   - **`RANGE` intervals mix the kinds on purpose.** `RANGE(0, 170]` is
 *     half-open, and `RANGE[4,)` is unbounded above; both are legal and both
 *     close a round bracket with a square one. Every one of the 523 mixed pairs
 *     in the corpus is a `RANGE`, so the exemption is the whole of it: the pair
 *     still has to balance, it just need not match in kind.
 *   - **An unterminated string is not a bracket bug.** It swallows the rest of
 *     the line, brackets included, so a statement holding one is left to
 *     `checkStrings` rather than reported twice for the same typo.
 *
 * Corpus: 2797 files, zero reports in either the missing or the surplus shape,
 * so — as with `commas.ts` and `operators.ts` — `parens.test.ts` carries the
 * entire proof that the check still bites.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';

export const SOURCE = 'gdl';

/** The closer each opening bracket expects. */
const CLOSER: Readonly<Record<string, string>> = { '(': ')', '[': ']' };

/** The opener each closing bracket answers. */
const OPENER: Readonly<Record<string, string>> = { ')': '(', ']': '[' };

function bracket(tok: Token, table: Readonly<Record<string, string>>): string | undefined {
	return tok.type === 'operator' ? table[tok.text] : undefined;
}

export function provideParenDiagnostics(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const stmt of doc.statements) {
		const toks = stmt.tokens;
		// An unterminated string has already eaten an unknown amount of the
		// line; whatever the brackets look like afterwards means nothing.
		if (toks.some((t) => t.unterminated)) continue;

		/** Open brackets, each with whether it opened a `RANGE` interval. */
		const stack: { tok: Token; interval: boolean }[] = [];

		for (let i = 0; i < toks.length; i++) {
			const tok = toks[i];

			if (bracket(tok, CLOSER)) {
				// `VALUES "gs_resol" RANGE [4, )` — the interval brackets are
				// chosen for openness, not for kind, so they are paired but
				// never matched.
				const prev = toks[i - 1];
				stack.push({ tok, interval: prev?.type === 'identifier' && prev.lower === 'range' });
				continue;
			}

			const opener = bracket(tok, OPENER);
			if (!opener) continue;

			const open = stack.pop();
			if (!open) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: { start: td.positionAt(tok.start), end: td.positionAt(tok.end) },
					message: `Unmatched \`${tok.text}\` — there is no \`${opener}\` left open here.`,
					source: SOURCE,
				});
				continue;
			}

			if (!open.interval && CLOSER[open.tok.text] !== tok.text) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: { start: td.positionAt(tok.start), end: td.positionAt(tok.end) },
					message:
						`\`${tok.text}\` closes a \`${open.tok.text}\` opened at line ` +
						`${td.positionAt(open.tok.start).line + 1} — expected \`${CLOSER[open.tok.text]}\`.`,
					source: SOURCE,
				});
			}
		}

		// Innermost first: that is the one the reader is standing in.
		for (const open of stack.reverse()) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: { start: td.positionAt(open.tok.start), end: td.positionAt(open.tok.end) },
				message: `\`${open.tok.text}\` is never closed — expected \`${CLOSER[open.tok.text]}\` before the statement ends.`,
				source: SOURCE,
			});
		}
	}

	return diagnostics;
}
