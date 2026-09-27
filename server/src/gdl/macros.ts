/**
 * Which macros a script calls, and by what name.
 *
 * The guide (§ CALL) allows the name four ways, and the corpus writes two of
 * them — 1294 calls in 2473 scripts:
 *
 *     CALL "Pila Knoten" PARAMETERS …          ! 1184, a string constant
 *     CALL handle_macro PARAMETERS ALL         !  110, a variable or parameter
 *     CALL leg 2, , 5                          !    0, or the name unquoted
 *     leg 2, , 5                               !    0, the name as a command
 *
 * The second and third spellings look the same. *"The macro name must be put
 * between quotation marks … unless it matches the definition of identifiers"*,
 * so `CALL leg` may be the part called `leg` or a variable holding a name. It
 * is read as a variable when the script (or the master script ahead of it)
 * assigns it a literal — `handle_macro = "OGRO_handle_macro"`, 97 of the 110 —
 * and as the unquoted name only when no such assignment exists and a part of
 * that name does. What is left is computed: a string parameter whose value is
 * set in the dialog (12 in the corpus, every default of them `""`), or a
 * variable built from other values.
 *
 * The fourth, *"Macro name itself also can be used as a command, without the
 * CALL keyword"*, is legal and unused. Nothing in the statement says it is a
 * call, so it is taken as one only where a library part of that name is
 * actually in the workspace — which means this module is handed the question
 * rather than answering it. Two places it never is, both met on the corpus:
 * a variable of the same name, and a `PARAGRAPH` body, which lists one bare
 * value per line. Three markers do both at once — a `note2` variable on a line
 * of its own inside a paragraph, beside ACLib's `NOTE2` macro in the same
 * checkout — and each read as a call until these were ruled out.
 */

import type { GdlDocument } from './analyzer';
import { CLAUSE_STARTERS, forEachLiteralAssignment, isOperator } from './indirect';
import { lookupWithVariants } from './keywords';
import { macroKey } from './libraryIndex';

export type MacroSpelling = 'string' | 'variable' | 'unquoted' | 'command' | 'computed';

export interface MacroCallSite {
	/** The macro's name, or undefined when only running the script could tell. */
	readonly name: string | undefined;
	readonly spelling: MacroSpelling;
	/** The variable the name travels through, for `variable` and `computed`. */
	readonly variable?: string;
	/** Span of the name as written at the call. */
	readonly start: number;
	readonly end: number;
}

/**
 * Every macro call in `doc`, in source order.
 *
 * `master` is the master script of the same part, whose assignments reach this
 * one; `exists` says whether a library part of a given name can be found, and
 * decides the two spellings the text alone cannot.
 */
export function macroCallSites(
	doc: GdlDocument,
	master: GdlDocument | undefined,
	exists: (name: string) => boolean,
): MacroCallSite[] {
	const sites: MacroCallSite[] = [];

	// The variables called through, and the literals they are given.
	const variables = new Set<string>();
	for (const call of doc.macroCalls) {
		if (call.spelling === 'identifier') variables.add(call.name.toLowerCase());
	}
	const aliases = new Map<string, Map<string, string>>();
	if (variables.size > 0) {
		for (const source of master && master !== doc ? [doc, master] : [doc]) {
			for (const stmt of source.statements) {
				forEachLiteralAssignment(stmt, (head) => variables.has(head), (value, _key, head) => {
					const name = value.text.slice(1, -1).trim();
					let values = aliases.get(head.lower);
					if (!values) aliases.set(head.lower, (values = new Map()));
					if (!values.has(macroKey(name))) values.set(macroKey(name), name);
				});
			}
		}
	}

	for (const call of doc.macroCalls) {
		const span = { start: call.at, end: call.end };
		if (call.spelling === 'string') {
			sites.push({ name: call.name, spelling: 'string', ...span });
			continue;
		}
		const values = aliases.get(call.name.toLowerCase());
		if (values) {
			for (const name of values.values()) {
				sites.push({ name, spelling: 'variable', variable: call.name, ...span });
			}
		} else if (exists(call.name)) {
			sites.push({ name: call.name, spelling: 'unquoted', ...span });
		} else {
			sites.push({ name: undefined, spelling: 'computed', variable: call.name, ...span });
		}
	}

	// The name as a command. Only a clause's first word can be one, and never
	// a keyword, a variable of either script, or the target of an assignment.
	let inParagraph = false;
	for (const stmt of doc.statements) {
		if (stmt.head === 'paragraph') inParagraph = true;
		else if (stmt.head === 'endparagraph') inParagraph = false;
		if (inParagraph) continue;

		const toks = stmt.tokens;
		for (let i = 0; i < toks.length; i++) {
			const tok = toks[i];
			if (tok.type !== 'identifier') continue;
			const before = toks[i - 1];
			const opensClause = !before || (before.type === 'identifier' && CLAUSE_STARTERS.has(before.lower));
			if (!opensClause) continue;

			const after = toks[i + 1];
			if (['=', '[', '.', ':', '('].some((op) => isOperator(after, op))) continue;
			if (lookupWithVariants(tok.text)) continue;
			if (doc.variables.has(tok.lower) || master?.variables.has(tok.lower)) continue;
			if (!exists(tok.text)) continue;

			sites.push({ name: tok.text, spelling: 'command', start: tok.start, end: tok.end });
		}
	}

	return sites.sort((a, b) => a.start - b.start);
}
