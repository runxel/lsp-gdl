/**
 * Parameters addressed **by name**, as a string.
 *
 * A parameter is written two ways. Bare, it is an ordinary identifier and every
 * feature here already understands it. Spelt as a string, it is a name handed
 * to a command that reaches into the parameter list:
 *
 *     VALUES "iDetailLevel" 1, 2, 3
 *     LOCK "bShowFrame"
 *     UI_INFIELD "gs_fill_pen", 10, 20, 100, 20
 *     UI_LISTITEM itemID, fieldID, "gs_cont_pen"
 *
 * Those strings are references as surely as the bare spelling is, which is what
 * this module exists to find: rename must be reachable *from* one of them, and
 * must know that a lone string in an argument position is a parameter name
 * rather than prose. `UI_OUTFIELD "gs_fill_pen"` is a caption that happens to
 * match, and naming it a reference would be a guess.
 *
 * So argument positions are tracked per command, the way `groups.ts` tracks
 * which arguments of `SWEEPGROUP` are group expressions. Only the arguments the
 * guide calls a parameter name count: `UI_INFIELD`'s later arguments include a
 * picture name and the cell texts, all strings and none of them a parameter,
 * and `VALUES "matBody" "brick", "timber"` restricts one parameter to two
 * values rather than mentioning three parameters.
 *
 * Two things are deliberately left unresolved, as everywhere else here:
 *
 *   - **Computed names.** The guide calls these arguments string *expressions*,
 *     so `LOCK "prefix_" + n` is legal and unknowable. Only a lone literal is
 *     read as a name.
 *   - **An empty literal names nothing.** `UI_LISTITEM id, field, ""` is how a
 *     group row of a listfield is written — 142 of them in the corpus.
 *
 * The `{2}`…`{4}` versions of the UI commands take the parameter *bare* instead
 * ("parameter name with optional actual index values if array"), which is an
 * ordinary identifier and needs nothing from this module.
 */

import type { GdlDocument, Statement } from './analyzer';
import type { Token } from './lexer';
import { CLAUSE_STARTERS, isOperator } from './indirect';

/** One place a parameter is named by a string literal. */
export interface ParameterNameSite {
	/** The string token spelling it — quotes included. */
	readonly token: Token;
	/** Its contents, as written. */
	readonly name: string;
}

/** Variant suffix, as in `VALUES{2}` or `UI_INFIELD{4}`. */
const VARIANT_RE = /\{\d+\}$/;

/**
 * Which arguments of a command are parameter names, counted from the first
 * argument after the command word. `'all'` is every one of them.
 *
 * Positions come from the reference guide's syntax lines, and are keyed on the
 * base name, every variant of a command naming its parameter in the same place.
 */
const PARAMETER_NAME_ARGS: ReadonlyMap<string, readonly number[] | 'all'> = new Map<
	string,
	readonly number[] | 'all'
>([
	// LOCK ["name", …] / HIDEPARAMETER ["name", …] — and `ALL`, whose exceptions
	// after it are parameter names just the same.
	['lock', 'all'],
	['hideparameter', 'all'],

	// VALUES "parameter_name" [,] value1, … — only the first argument.
	['values', [0]],

	// The interface script's controls, all of which take the parameter they
	// edit as their first argument…
	['ui_infield', [0]],
	['ui_slider', [0]],
	['ui_radiobutton', [0]],
	['ui_pict_radiobutton', [0]],
	['ui_pict_pushcheckbutton', [0]],
	['ui_textstyle_infield', [0]],
	['ui_custom_popup_infield', [0]],
	// …except the colour picker, which drives three at once…
	['ui_colorpicker', [0, 1, 2]],
	// …and the list item, whose first two arguments identify the row and the
	// listfield it belongs to, the parameter coming third.
	['ui_listitem', [2]],
	['ui_custom_popup_listitem', [2]],
]);

/**
 * The argument positions of `command` that name a parameter, if any. The head
 * may carry a variant suffix; `VALUES{2}` names its parameter where `VALUES`
 * does.
 */
export function parameterNameArgs(command: string): readonly number[] | 'all' | undefined {
	return PARAMETER_NAME_ARGS.get(command.toLowerCase().replace(VARIANT_RE, ''));
}

/**
 * True when the string at `i` stands alone as the argument's value.
 *
 * `+` is the tell, and the only one: it is GDL's string concatenation, so
 * `LOCK "prefix_" + n` builds a name at run time that we cannot resolve. No
 * other operator can be doing that to a string — `-`, `*` and `/` on one are
 * type errors, so a `-` here is the sign of the *next* value, not part of this
 * name. That matters because `VALUES` takes an optional comma before its value
 * list and so runs the name straight into whatever follows:
 *
 *     VALUES "iDetailLevel" 1, 2, 3
 *     VALUES "xTapPos" (xTapPosMin + xTapPosMax) / 2
 *
 * Judging on "any operator" instead cost the second of those, 18 times over on
 * the corpus.
 */
function isLoneLiteral(toks: readonly Token[], i: number): boolean {
	const next = toks[i + 1];
	return !(next?.type === 'operator' && next.text === '+');
}

/**
 * Walks the arguments of one command, reporting the parameter names among them.
 * Returns the index at which the argument list ended.
 */
function scanArguments(
	toks: readonly Token[],
	commandAt: number,
	spec: readonly number[] | 'all',
	visit: (site: ParameterNameSite) => void,
): number {
	let i = commandAt + 1;

	// `LOCK ALL "keep"` lists exceptions, which are parameter names too, so the
	// keyword is stepped over rather than counted as an argument.
	if (spec === 'all' && toks[i]?.type === 'identifier' && toks[i].lower === 'all') i++;

	let argIndex = 0;
	let atArgStart = true;
	let depth = 0;

	for (; i < toks.length; i++) {
		const tok = toks[i];

		if (tok.type === 'operator') {
			if (tok.text === '(' || tok.text === '[') depth++;
			else if (tok.text === ')' || tok.text === ']') depth--;
			else if (tok.text === ',' && depth === 0) {
				argIndex++;
				atArgStart = true;
				continue;
			}
			atArgStart = false;
			continue;
		}

		// `IF a THEN LOCK "x" ELSE LOCK "y"` is one statement holding two
		// commands, so this argument list ends here.
		if (tok.type === 'identifier' && depth === 0 && CLAUSE_STARTERS.has(tok.lower)) return i;

		if (
			atArgStart &&
			depth === 0 &&
			tok.type === 'string' &&
			!tok.unterminated &&
			(spec === 'all' || spec.includes(argIndex)) &&
			isLoneLiteral(toks, i)
		) {
			const name = tok.text.slice(1, -1);
			if (name !== '') visit({ token: tok, name });
		}
		atArgStart = false;
	}
	return i;
}

/** Reports every parameter named by a string literal in one statement. */
function forEachParameterName(stmt: Statement, visit: (site: ParameterNameSite) => void): void {
	const toks = stmt.tokens;
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i];
		if (tok.type !== 'identifier') continue;

		const spec = parameterNameArgs(tok.lower);
		if (!spec) continue;

		// A command word is syntax; a name of the same spelling reached through
		// a member access (`ui.lock`) is not one.
		if (isOperator(toks[i - 1], '.')) continue;

		i = scanArguments(toks, i, spec, visit) - 1;
	}
}

/** Every parameter named by a string literal in this script, in source order. */
export function parameterNameSites(doc: GdlDocument): ParameterNameSite[] {
	const sites: ParameterNameSite[] = [];
	for (const stmt of doc.statements) forEachParameterName(stmt, (site) => sites.push(site));
	return sites;
}

/**
 * The parameter name under `offset`, if the cursor is on one. Reported only
 * where GDL reads the string as a parameter name — a `UI_OUTFIELD "bShowFrame"`
 * is a caption, however exactly it matches.
 */
export function parameterNameAt(doc: GdlDocument, offset: number): ParameterNameSite | undefined {
	for (const stmt of doc.statements) {
		if (offset < stmt.start || offset > stmt.end) continue;
		let found: ParameterNameSite | undefined;
		forEachParameterName(stmt, (site) => {
			if (offset >= site.token.start && offset <= site.token.end) found = site;
		});
		if (found) return found;
	}
	return undefined;
}
