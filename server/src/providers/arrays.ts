/**
 * Array bounds checking.
 *
 * `DIM` gives an array either a fixed size or a dynamic one, and the two behave
 * very differently — from the reference guide (§ DIM):
 *
 *   - *"Indices start with 1"*, so `arr[0]` is never valid.
 *   - *"Arrays having a fixed dimension are checked for the validity of the
 *     actual index on the fixed dimension."* Overrunning a fixed dimension is a
 *     real error, not a silent extension.
 *   - *"For dynamic arrays there is no limitation for the actual index value.
 *     During the interpretation, when a non-existing dynamic array element is
 *     given a value, the necessary quantity of memory is allocated"* — and the
 *     guide warns this can blow up as an out-of-memory error, because *"each
 *     index - even of a possibly wrong, huge value - is considered valid, since
 *     the interpreter is unable to detect the error condition."*
 *
 * So a dynamic dimension can never be checked and a fixed one always can. The
 * declarations carry both, one per dimension:
 *
 *     DIM a[4]        fixed 4
 *     DIM a[]         dynamic
 *     DIM a[][2]      dynamic rows, fixed 2 columns
 *     DIM a[3][2]     fixed both
 *
 * Library part parameters that are arrays are deliberately *not* checked: the
 * guide states they "are dynamic by default", whatever size the parameter list
 * happens to show today.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';

export const SOURCE = 'gdl';

/** A declared dimension: a fixed length, or null when dynamic. */
type Dimension = number | null;

interface ArrayDecl {
	readonly name: string;
	readonly dims: readonly Dimension[];
}

function isOp(tok: Token | undefined, text: string): boolean {
	return tok?.type === 'operator' && tok.text === text;
}

/** Index just past the `[...]` group that opens at `open`. */
function closeBracket(tokens: readonly Token[], open: number): number {
	let depth = 0;
	for (let i = open; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type !== 'operator') continue;
		if (t.text === '[') depth++;
		else if (t.text === ']') {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return tokens.length;
}

/**
 * Reads the constant index inside `[from, to)`, or null when it is anything
 * else — a variable, an expression, a function call. Only literals can be
 * checked; everything else is the interpreter's problem.
 */
function constantIndex(tokens: readonly Token[], from: number, to: number): number | null {
	let i = from;
	let sign = 1;
	if (isOp(tokens[i], '-')) {
		sign = -1;
		i++;
	} else if (isOp(tokens[i], '+')) {
		i++;
	}
	if (i !== to - 1 || tokens[i]?.type !== 'number') return null;
	const text = tokens[i].text;
	// Imperial and fractional literals are never sensible indices.
	if (!/^\d+$/.test(text)) return null;
	return sign * Number(text);
}

/** Parses `DIM a[4], b[][2]` into declarations. */
function parseDim(tokens: readonly Token[]): ArrayDecl[] {
	const decls: ArrayDecl[] = [];
	let i = 1;

	while (i < tokens.length) {
		const nameTok = tokens[i];
		if (nameTok.type !== 'identifier') {
			i++;
			continue;
		}
		i++;

		const dims: Dimension[] = [];
		while (isOp(tokens[i], '[')) {
			const end = closeBracket(tokens, i);
			// `[]` is dynamic; `[n]` is fixed; anything else is unknowable.
			dims.push(end === i + 2 ? null : constantIndex(tokens, i + 1, end - 1));
			i = end;
		}

		if (dims.length > 0) decls.push({ name: nameTok.text, dims });

		// Skip to the next comma-separated declaration.
		while (i < tokens.length && !isOp(tokens[i], ',')) i++;
		i++;
	}
	return decls;
}

export function provideArrayDiagnostics(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const arrays = new Map<string, ArrayDecl>();

	const report = (tok: Token, length: number, message: string) => {
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: { start: td.positionAt(tok.start), end: td.positionAt(tok.start + length) },
			message,
			source: SOURCE,
		});
	};

	for (const stmt of doc.statements) {
		const toks = stmt.tokens;

		// A `DIM` re-declares, so a later one replaces the earlier bounds.
		if (stmt.head === 'dim') {
			for (const decl of parseDim(toks)) arrays.set(decl.name.toLowerCase(), decl);
			continue;
		}

		for (let i = 0; i < toks.length; i++) {
			const tok = toks[i];
			if (tok.type !== 'identifier' || !isOp(toks[i + 1], '[')) continue;

			const decl = arrays.get(tok.lower);
			let at = i + 1;

			for (let axis = 0; isOp(toks[at], '['); axis++) {
				const end = closeBracket(toks, at);
				const index = constantIndex(toks, at + 1, end - 1);
				const indexTok = toks[at + 1];

				if (index !== null && indexTok) {
					const span = toks[end - 2].end - indexTok.start;
					const axisName = decl && decl.dims.length > 1 ? ` on dimension ${axis + 1}` : '';

					if (index < 1) {
						report(
							indexTok,
							span,
							`Array indices start at 1 in GDL, so \`${tok.text}[${index}]\` does not exist.`,
						);
					} else {
						// Only a fixed dimension has a bound worth checking;
						// a dynamic one grows to fit whatever it is given.
						const bound = decl?.dims[axis];
						if (typeof bound === 'number' && index > bound) {
							report(
								indexTok,
								span,
								`\`${decl!.name}\` is declared with ${bound} element${bound === 1 ? '' : 's'}${axisName}, ` +
									`so index ${index} is out of bounds.`,
							);
						}
					}
				}

				at = end;
			}
			i = at - 1;
		}
	}

	return diagnostics;
}
