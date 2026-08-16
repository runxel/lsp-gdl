/**
 * Operators left without an operand.
 *
 *     a = 1 + + 2
 *     a = b * / c
 *     a = (b + )
 *     a = b +          <- and nothing after it
 *
 * A doubled operator is the classic slip of an interrupted edit — a `+` typed
 * twice, or an operand deleted from between two of them. GDL does not report it
 * where it happens; Archicad refuses the whole script with one error at the end,
 * so the cost of finding it is out of all proportion to the typo.
 *
 * The check hinges on the one operator that may legitimately stand with nothing
 * on its left. From the guide's own style section (§ Miscellaneous, Expressions):
 *
 *   *"Do not use space after a unary operator -. Do not use + as a unary
 *   operator; use a space instead for aligning coordinates in a row."*
 *
 * So `-` is a sign as well as an operator and must never be questioned:
 * `b * -1`, `IF x < -tlr`, `PUT -x/2, y` are all ordinary GDL, 200k occurrences
 * of `, -` in the corpus alone. `+` is the interesting one. The compiler does
 * accept it as a sign — GRAPHISOFT's own Base Macros open a continued sum with
 * `_determinant = +a.x * b.y \` for column alignment, and ACLib writes
 * `epsilon = + EPS` — so a leading `+` is reported only where no operand could
 * precede it either: directly after another arithmetic or logical operator.
 * That is the `1 + + 2` shape, and the corpus contains not one instance of it.
 *
 * Nothing here fires on the 2423-file corpus, in any of the four shapes. As
 * with `commas.ts`, the tests carry the entire proof that the checks still bite.
 *
 * The last shape is only safe because the lexer carries a `\` continuation
 * through a commented-out line; before it did, seven statements in working
 * library parts — GRAPHISOFT's own Base Macros among them — looked truncated.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';

export const SOURCE = 'gdl';

/**
 * Operators that demand a value on both sides.
 *
 * `=` is included, and covers both of its jobs: neither `a = = 1` nor
 * `IF a = = 1` has anything to assign or compare.
 */
const BINARY_ONLY = new Set([
	'*', '/', '^', '**', '%',
	'<', '>', '<=', '>=', '<>', '#',
	'&', '|', '@',
	'=',
]);

/** ...plus the two that double as signs. */
const BINARY = new Set([...BINARY_ONLY, '+', '-']);

/**
 * Tokens that close an argument or an expression, so an operator immediately
 * before one has lost its right-hand side.
 *
 * `,` counts, but only *after* an operator. A comma may legitimately follow a
 * bracket — `VALUES "h" RANGE[, upperLimit)` and `RANGE( , max)` are open-ended
 * intervals, and `RANGE[,]` is unbounded at both ends.
 */
const CLOSERS = new Set([')', ']', ',']);

/** Tokens that can be the tail of a value, and so satisfy an operator's left side. */
function endsValue(tok: Token | undefined): boolean {
	if (!tok) return false;
	if (tok.type === 'identifier' || tok.type === 'number' || tok.type === 'string') return true;
	return tok.type === 'operator' && (tok.text === ')' || tok.text === ']');
}

function isBinaryOperator(tok: Token | undefined): boolean {
	return tok?.type === 'operator' && BINARY.has(tok.text);
}


export function provideOperatorDiagnostics(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const stmt of doc.statements) {
		const toks = stmt.tokens;
		// A run of three (`1 + + + 2`) is one mistake, not two: once a token has
		// been reported, the operator after it has nothing left to complain about.
		let reportedAt = -1;

		for (let i = 0; i < toks.length; i++) {
			const tok = toks[i];
			if (tok.type !== 'operator') continue;

			const prev = toks[i - 1];
			const next = toks[i + 1];
			const afterReport = reportedAt === i - 1;

			// Nothing on the left. `-` and `+` are excluded: both are signs, and
			// a statement may open with one (`-1 * x`), as may any bracket or
			// comma (`PUT -x/2, -y`).
			if (BINARY_ONLY.has(tok.text) && !endsValue(prev) && !afterReport) {
				const doubled = isBinaryOperator(prev);
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: { start: td.positionAt(tok.start), end: td.positionAt(tok.end) },
					message: doubled
						? `Two operators in a row — \`${prev.text} ${tok.text}\`. ` +
							`\`${tok.text}\` has no value on its left.`
						: `\`${tok.text}\` has no value on its left.`,
					source: SOURCE,
				});
				reportedAt = i;
				continue;
			}

			// A `+` that cannot be addition, because the operator before it is
			// still waiting for its own right-hand side. Only `-` may stand there.
			if (
				tok.text === '+' &&
				isBinaryOperator(prev) &&
				// `x = +a` and `(+a * b)` are the attested alignment idiom.
				prev.text !== '=' &&
				!afterReport
			) {
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					range: { start: td.positionAt(prev.start), end: td.positionAt(tok.end) },
					message:
						`Two operators in a row — \`${prev.text} +\`. ` +
						`Only \`-\` may follow an operator, as a sign.`,
					source: SOURCE,
				});
				reportedAt = i;
				continue;
			}

			// Nothing on the right.
			if (BINARY.has(tok.text) && next?.type === 'operator' && CLOSERS.has(next.text)) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: { start: td.positionAt(tok.start), end: td.positionAt(tok.end) },
					message: `\`${tok.text}\` has no value on its right.`,
					source: SOURCE,
				});
				reportedAt = i;
			}
		}

		// An expression that runs out at the end of the statement. Only a `\` or
		// a trailing `,` continues onto the next line, and both have already been
		// joined in by this point, so there is nothing more coming.
		const last = toks[toks.length - 1];
		if (
			last?.type === 'operator' &&
			BINARY.has(last.text) &&
			reportedAt !== toks.length - 1 &&
			// `\` continuations are joined, so a lone `-` is a whole statement
			// only in code far past saving; one token is not evidence of a cut.
			toks.length > 1
		) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: { start: td.positionAt(last.start), end: td.positionAt(last.end) },
				message: `\`${last.text}\` has no value on its right — the statement ends here.`,
				source: SOURCE,
			});
		}
	}

	return diagnostics;
}
