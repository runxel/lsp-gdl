/**
 * Checks that `PARAMETERS`, `LOCK`, `HIDEPARAMETER` and `VALUES` name
 * parameters that actually exist.
 *
 * These commands reach into the library part's parameter list by name, so a
 * typo does not fail loudly — the statement simply has no effect, and the
 * parameter you meant to lock stays editable or unrestricted. From the guide:
 *
 *     PARAMETERS name1 = expression1 [, name2 = expression2, …]
 *     LOCK "name1" [, "name2", …]              LOCK ALL ["name1", …]
 *     HIDEPARAMETER "name1" [, "name2", …]     HIDEPARAMETER ALL ["name1", …]
 *     VALUES "parameter_name" [,]value1 [, value2, …]
 *     VALUES{2} "parameter_name" [,]value1, description1 [, …]
 *
 * The guide is explicit for `VALUES`: *"parameter_name: name of an existing
 * parameter"*.
 *
 * `PARAMETERS` takes bare identifiers; the rest take **string expressions**, so
 * `LOCK "prefix_" + n` is legal and unknowable. Only literal strings are judged.
 *
 * `paramlist.xml` is the ground truth. Parameters inherited from an ancestor
 * appear in it as fixed entries, so a name missing from it genuinely does not
 * exist on the object — no ancestry resolution required.
 *
 * Two things are still accepted when absent from the list:
 *
 *   - **Fix named parameters.** Since Archicad 22 the guide notes that
 *     lock/hide extends to "fix named optional parameters" for text and label
 *     controls, which need not appear in the parameter list.
 *   - **Everything, in a part with no parameters at all.** The guide warns that
 *     "commands in macros refer to the caller's parameters", so a macro without
 *     its own list is addressing somebody else's.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument, Statement } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';
import { lookup } from '../gdl/keywords';
import { libPartFor, type LibPart } from '../gdl/libpart';
import { parameterNameArgs } from '../gdl/paramNames';

export const SOURCE = 'gdl';

/**
 * Which arguments of this command name a parameter, if any.
 *
 * `gdl/paramNames.ts` holds the table, rename reading the same one — there is
 * one account of where a parameter may be named by a string, not two. It covers
 * the interface script's controls as well, which this check never meets: only
 * the master and parameter scripts are examined (see `CHECKED_SCRIPTS`), and no
 * script of either kind in the corpus scripts a `UI_` command.
 */
const namedArguments = (head: string) => parameterNameArgs(head);

/** `LOCK "a", "b"` — every argument is a name. */
const namesEveryArgument = (spec: ReturnType<typeof namedArguments>) => spec === 'all';

/**
 * `VALUES "name" v1, v2` — the *first* argument is a name and everything after
 * it is the value list, which must not be checked.
 */
const namesFirstArgumentOnly = (spec: ReturnType<typeof namedArguments>) =>
	Array.isArray(spec) && spec.length === 1 && spec[0] === 0;

function isOp(tok: Token | undefined, text: string): boolean {
	return tok?.type === 'operator' && tok.text === text;
}

/** Splits `[from, to)` into top-level comma-separated token ranges. */
function argumentRanges(tokens: readonly Token[], from: number, to: number): [number, number][] {
	const ranges: [number, number][] = [];
	let depth = 0;
	let start = from;
	for (let i = from; i < to; i++) {
		const t = tokens[i];
		if (t.type === 'operator') {
			if (t.text === '[' || t.text === '(') depth++;
			else if (t.text === ']' || t.text === ')') depth--;
			else if (t.text === ',' && depth === 0) {
				ranges.push([start, i]);
				start = i + 1;
			}
		}
	}
	if (start < to) ranges.push([start, to]);
	return ranges;
}

/**
 * A name Archicad supplies rather than the parameter list.
 *
 * The keyword table's `fixparam` entries are exactly the fixed named
 * parameters Archicad reads and writes (`ac_*`, text and label controls).
 */
function isFixNamedParameter(name: string): boolean {
	if (lookup(name)?.kind === 'fixparam') return true;
	// `ac_` is Archicad's reserved prefix for fix named parameters. The vendored
	// keyword list is an AC27 snapshot and will always trail the current
	// release, so trust the prefix rather than the list — a missing entry must
	// not turn a valid `HIDEPARAMETER "ac_something_new"` into a warning.
	return name.toLowerCase().startsWith('ac_');
}

/**
 * True when this library part looks like a macro — it has no parameter list of
 * its own worth speaking of, so its `PARAMETERS` statements address the caller.
 */
function isProbablyMacro(libpart: LibPart): boolean {
	return libpart.parameters.size === 0;
}

/**
 * Only the master and parameter scripts are checked.
 *
 * The migration scripts are the reason: `fwm.gdl` and `bwm.gdl` exist precisely
 * to move values between *different versions* of a library part, so they name
 * parameters that the current `paramlist.xml` does not have and should not.
 */
const CHECKED_SCRIPTS = new Set(['1d', 'vl']);

export function provideParameterRefDiagnostics(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	if (!doc.script || !CHECKED_SCRIPTS.has(doc.script)) return [];

	const libpart = libPartFor(doc.uri);
	// Without a parameter list there is nothing to check against.
	if (!libpart || isProbablyMacro(libpart)) return [];

	const diagnostics: Diagnostic[] = [];

	const report = (tok: Token, name: string, command: string) => {
		diagnostics.push({
			severity: DiagnosticSeverity.Warning,
			range: { start: td.positionAt(tok.start), end: td.positionAt(tok.end) },
			message:
				`\`${name}\` is not a parameter of \`${libpart.name}\`, so this ${command} has no effect.`,
			source: SOURCE,
		});
	};

	const known = (name: string) =>
		libpart.parameters.has(name.toLowerCase()) || isFixNamedParameter(name);

	for (const stmt of doc.statements) {
		const toks = stmt.tokens;
		const head = stmt.head;
		if (!head) continue;

		// `VALUES "name" v1, v2` — only the first argument is a parameter name;
		// the rest is the value list. The comma after the name is optional, and
		// the name may be built up (`VALUES "order_" + n`), which we cannot
		// resolve — so require a lone string literal.
		const spec = namedArguments(head);

		if (namesFirstArgumentOnly(spec)) {
			const tok = toks[1];
			if (tok?.type !== 'string' || tok.unterminated) continue;
			const after = toks[2];
			if (after?.type === 'operator' && after.text !== ',') continue;

			const name = tok.text.slice(1, -1);
			if (name === '' || known(name)) continue;
			report(tok, name, head.toUpperCase());
			continue;
		}

		if (namesEveryArgument(spec)) {
			// `LOCK ALL "keepThis"` — the names after ALL are the exceptions,
			// and they are parameter names just the same.
			let from = 1;
			if (toks[1]?.type === 'identifier' && toks[1].lower === 'all') from = 2;

			for (const [start, end] of argumentRanges(toks, from, toks.length)) {
				// Only a lone string literal is a name we can resolve; anything
				// built up from expressions is beyond us.
				if (end - start !== 1) continue;
				const tok = toks[start];
				if (tok.type !== 'string' || tok.unterminated) continue;

				const name = tok.text.slice(1, -1);
				if (name === '' || known(name)) continue;
				report(tok, name, head.toUpperCase());
			}
			continue;
		}

		if (head === 'parameters') {
			for (const [start, end] of argumentRanges(toks, 1, toks.length)) {
				const tok = toks[start];
				if (tok?.type !== 'identifier') continue;
				// Must be an actual assignment, not a stray word.
				let eq = start + 1;
				while (isOp(toks[eq], '[')) {
					let depth = 0;
					while (eq < end) {
						const t = toks[eq];
						if (isOp(t, '[')) depth++;
						else if (isOp(t, ']') && --depth === 0) {
							eq++;
							break;
						}
						eq++;
					}
				}
				if (!isOp(toks[eq], '=')) continue;

				// A dotted name addresses a dictionary parameter's key.
				const name = tok.text.split('.')[0];
				if (known(name)) continue;
				report(tok, name, 'PARAMETERS');
			}
		}
	}

	return diagnostics;
}

export type { Statement };
