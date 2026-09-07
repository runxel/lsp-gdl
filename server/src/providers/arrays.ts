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
 *
 * Two further checks read the same declarations from the other end.
 *
 * **An array referenced but never declared.** The guide is explicit about the
 * asymmetry between a parameter and a variable (§ DIM): *"Parameter arrays do
 * not have to be declared in the script and they are dynamic by default"*,
 * while *"the elements of the arrays can be referenced anywhere in the script
 * but if they are variables, only after the declaration."* So a subscripted
 * name that is neither a parameter, nor a global, nor `DIM`med anywhere in
 * reach is a leftover — nearly always a rename that missed a site, or a
 * parameter deleted from `paramlist.xml` while the script kept using it.
 *
 * **Every site is reported**, not just the first of each name. One missing
 * `DIM` is arguably one mistake, and reporting it once was the first thing
 * tried — but a squiggle that appears only on a name's *earliest* use reads as
 * the check not working at all, which is exactly how the project owner met it:
 * a line pasted into a script that already used the same undeclared array was
 * left clean. Each reference is its own failure at run time anyway.
 *
 * **Too many indices.** `DIM` fixes how many dimensions an array has, and GDL
 * has only one and two dimensional arrays. `DIM a[]` followed by `a[1][3]`
 * subscripts a row that was never declared. Fewer indices than declared is
 * fine and idiomatic — the guide allows `var2[i]` and bare `var2` for a
 * two-dimensional `var2`, meaning a row and the whole array — so only the
 * excess is reported.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';
import { lookupWithVariants } from '../gdl/keywords';
import { libPartFor } from '../gdl/libpart';
import { sharedScriptsFor, type TextResolver } from '../gdl/masterScript';

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

/** Every array `DIM`med by a script, keyed on the lower-cased name. */
function declaredArrays(doc: GdlDocument): Map<string, ArrayDecl> {
	const arrays = new Map<string, ArrayDecl>();
	for (const stmt of doc.statements) {
		if (stmt.head !== 'dim') continue;
		for (const decl of parseDim(stmt.tokens)) arrays.set(decl.name.toLowerCase(), decl);
	}
	return arrays;
}

/** "one", "two" — the guide has no other array shape to name. */
function dimensionWord(n: number): string {
	return n === 1 ? 'one' : n === 2 ? 'two' : String(n);
}

export function provideArrayDiagnostics(
	doc: GdlDocument,
	td: TextDocument,
	// Supplies unsaved editor text for the scripts that run ahead of this one;
	// defaulted so callers with nothing open fall back to what is on disk.
	resolve: TextResolver = () => undefined,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const arrays = new Map<string, ArrayDecl>();

	// Declarations arriving from elsewhere in the library part, plus the
	// parameter list. Outside an HSF folder neither can be read, and the
	// undeclared check stands down rather than guess — the same call
	// `labels.ts` makes about a master script it cannot find.
	const libpart = libPartFor(doc.uri);
	const inherited = new Map<string, ArrayDecl>();
	if (libpart) {
		for (const other of sharedScriptsFor(doc.uri, resolve)) {
			for (const [key, decl] of declaredArrays(other)) {
				if (!inherited.has(key)) inherited.set(key, decl);
			}
		}
	}

	const report = (
		tok: Token,
		length: number,
		message: string,
		severity: DiagnosticSeverity = DiagnosticSeverity.Error,
	) => {
		diagnostics.push({
			severity,
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

			// A dictionary member is not an array variable and is never `DIM`med
			// — the guide keeps the two apart outright ("Dictionary type variables
			// cannot be redeclared as arrays or vice versa"). It reaches us two
			// ways, because the lexer breaks a dotted path at a subscript:
			// `_trapezoid.start.vert[1]` arrives as one identifier holding dots,
			// while the `edge` of `pbuf.line[i].edge[j]` arrives on its own with
			// the `.` in front of it. 3392 corpus sites of the first shape and
			// 1416 of the second, none of them an array declaration's business.
			const dotted = tok.lower.includes('.') || isOp(toks[i - 1], '.');

			// A member is nobody's declaration, so it gets no bounds either — an
			// `edge` of a dictionary must not be measured against a `DIM edge[4]`
			// that happens to be in the same script.
			const decl = dotted ? undefined : (arrays.get(tok.lower) ?? inherited.get(tok.lower));
			let at = i + 1;

			for (let axis = 0; isOp(toks[at], '['); axis++) {
				const end = closeBracket(toks, at);
				const index = constantIndex(toks, at + 1, end - 1);
				const indexTok = toks[at + 1];

				// One index too many. Only a `DIM` in reach says how many an array
				// takes: a parameter array's are set in the dialog, and the guide
				// warns that a `CALL` may hand it "an array with arbitrary
				// dimensions" anyway, so `paramlist.xml` cannot settle this.
				if (decl && axis >= decl.dims.length) {
					report(
						toks[at],
						toks[end - 1].end - toks[at].start,
						`\`${decl.name}\` is declared with ${dimensionWord(decl.dims.length)} ` +
							`dimension${decl.dims.length === 1 ? '' : 's'}, so it takes ` +
							`${dimensionWord(decl.dims.length)} ${decl.dims.length === 1 ? 'index' : 'indices'}, not ${axis + 1}.`,
					);
					at = end;
					continue;
				}

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

			// A parameter needs no `DIM` — but only an *array* parameter does.
			// `paramlist.xml` says which: an array carries `<ArrayValues>` and
			// a scalar does not, and that is a categorical fact about the
			// declaration rather than a size, so it is safe to read where the
			// dimension counts are not. A scalar subscripted anyway is the same
			// leftover as a name that does not exist at all.
			const param = libpart?.parameters.get(tok.lower);

			if (
				!decl &&
				libpart &&
				!dotted &&
				!param?.dimensions &&
				// A good few globals are arrays — `RAIL_COMPONENTS`,
				// `STAIR2D_BREAKMARK_GEOM`, 1388 corpus sites in 89 files — and
				// none of them is ever declared. The table also catches `RANGE[0,
				// 1]`, a `VALUES` sub-clause that is no subscript at all, and the
				// `ac_`/`ifc_` fixed parameters the vendored list knows about but
				// this part's own list may not — Archicad owns those names, so
				// they are never ours to judge.
				!lookupWithVariants(tok.text)
			) {
				report(
					tok,
					tok.end - tok.start,
					param
						? `\`${tok.text}\` is subscripted, but \`${libpart.name}\` declares it as a ` +
								`plain ${param.typeLabel} parameter, not an array.`
						: `\`${tok.text}\` is subscripted but never declared: no \`DIM\` reaches ` +
								`this script, and \`${libpart.name}\` has no parameter of that name.`,
					// A warning rather than an error: the declaration could still be
					// arriving by a route this server cannot see, and a wrong hard
					// error on working code is worse than a soft one on a leftover.
					DiagnosticSeverity.Warning,
				);
			}

			i = at - 1;
		}
	}

	return diagnostics;
}
