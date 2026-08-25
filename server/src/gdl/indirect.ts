/**
 * `<target> = "literal"` — the assignment that names something without
 * mentioning what it names.
 *
 * Two kinds of GDL name are reached through a variable rather than written
 * where they are used: a group (`placegroup gr_toplace`) and a jump label
 * (`gosub _substr`). In both cases the string that actually supplies the name
 * sits in an ordinary assignment carrying no keyword at all:
 *
 *     gr_toplace = "Object_stretched"      ! …later: placegroup gr_toplace
 *     _substr    = "EndBlock"              ! …later: gosub _substr
 *
 * Missing one of those in a rename is the worst outcome this server has: the
 * definition is rewritten while the reference is left pointing at a name that
 * no longer exists, and the object breaks silently. So both features run a
 * pass over the *whole* script — whether `x = "y"` names anything depends on a
 * `placegroup` or a `gosub` further down — and this is the part they share.
 *
 * What keeps it honest, each rule paid for on the corpus:
 *
 *   - **The target may be a whole path.** `gr_out[TYPE_MEDIA_O2]` and
 *     `_drods.f[1].gr` are both real; names are routinely tabulated into an
 *     array and picked out by an index. Only the head identifier is matched.
 *   - **The assignment must open its clause.** `IF gr_toplace = "x" THEN` asks
 *     a question — `=` is both operators, as everywhere in GDL.
 *   - **Only a lone literal counts.** `gr = "wall" + STR (i)` is computed and
 *     unknowable, like every other built-up name here.
 *   - **An empty literal names nothing.** `_gname[1] = ""` clears the slot.
 */

import type { Statement } from './analyzer';
import type { Token } from './lexer';

/** Words after which a new command begins inside the same statement. */
export const CLAUSE_STARTERS = new Set(['then', 'else']);

export function isOperator(tok: Token | undefined, text: string): boolean {
	return tok?.type === 'operator' && tok.text === text;
}

function isClauseStarter(tok: Token | undefined): boolean {
	return tok?.type === 'identifier' && CLAUSE_STARTERS.has(tok.lower);
}

/**
 * Reports every `<target> = "literal"` in one statement whose target's head is
 * a name the caller tracks — a variable the script elsewhere places as a group,
 * or jumps to as a label.
 *
 * `key` is the literal's contents, lower-cased, which is how both callers index
 * their names.
 */
export function forEachLiteralAssignment(
	stmt: Statement,
	isTracked: (headLower: string) => boolean,
	visit: (value: Token, key: string, head: Token) => void,
): void {
	const toks = stmt.tokens;
	for (let i = 0; i < toks.length; i++) {
		const head = toks[i];
		if (head.type !== 'identifier' || !isTracked(head.lower)) continue;

		const before = toks[i - 1];
		if (before && !isClauseStarter(before)) continue;

		// Step over the rest of the target: subscripts and dict members alike.
		let j = i + 1;
		let depth = 0;
		while (j < toks.length) {
			const tok = toks[j];
			if (isOperator(tok, '[')) depth++;
			else if (isOperator(tok, ']')) depth--;
			else if (depth === 0 && !isOperator(tok, '.') && !isOperator(toks[j - 1], '.')) break;
			if (depth < 0) break;
			j++;
		}
		if (depth !== 0) continue;

		if (!isOperator(toks[j], '=')) continue;
		const value = toks[j + 1];
		if (value?.type !== 'string' || value.unterminated) continue;

		// Nothing may follow but the end of the statement or the next clause.
		const after = toks[j + 2];
		if (after && !isClauseStarter(after)) continue;

		const key = value.text.slice(1, -1).toLowerCase();
		if (!key) continue;

		visit(value, key, head);
	}
}
