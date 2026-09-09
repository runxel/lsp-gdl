/**
 * Constants and string tables, read back out of the scripts that fill them.
 *
 * GDL has no `const` and no enum. What library code writes instead is a pair of
 * ordinary assignments in the master script — a number given a name, and a
 * caption parked in an array under the matching index:
 *
 *     DIRVALUES_PERPEND      = 1
 *     stMarkerDirValues[1]   = `Senkrecht zur Markerachse`
 *
 * …which `vl.gdl` then hands to the parameter list as a value/label pair:
 *
 *     values{2} "iMarkerDir"  DIRVALUES_PERPEND, stMarkerDirValues[1],
 *                             DIRVALUES_ALIGNED, stMarkerDirValues[2]
 *
 * Neither half means anything on its own, which is why this module exists: to
 * turn `stMarkerDirValues[1]` back into the sentence the author wrote, so a
 * completion can say what `DIRVALUES_PERPEND` actually *means*. 160 of the
 * corpus's 796 `VALUES{2}` statements are written exactly this way.
 *
 * ## Confidence, and why it is the whole design
 *
 * A wrong meaning is worse than no meaning. A completion item reading
 * `DIRVALUES_PERPEND — Vertikal` would be taken as fact and acted on, where a
 * bare `DIRVALUES_PERPEND` merely leaves the author where they already were. So
 * every rule here refuses rather than guesses:
 *
 *   - **A name written twice resolves to nothing.** `i = 1` followed by
 *     `i = i + 1` is a counter, not a constant, and the corpus is full of them.
 *     A second assignment poisons the name whether or not it folds — an
 *     unfoldable one is *more* reason to doubt the first, not less.
 *   - **Only a lone literal counts**, as everywhere else here —
 *     `s[1] = "a" + n` is computed and unknowable.
 *   - **The subscript must fold.** `stValues[i]` inside a loop names a
 *     different slot on every pass, so it names none of them for us — and it
 *     poisons the whole table, since the slot it lands on could be any.
 *   - **The assignment must open its clause**, `=` being GDL's equality
 *     operator as well — `IF s[1] = "x" THEN` asks a question. That rule lives
 *     in `indirect.ts` and is shared with the group and label passes.
 *
 * The one shape those rules deliberately give up on is the running counter:
 *
 *     aMidGeometry[i] = GEOM_REVOLVED : sMidGeometry[i] = `Gedreht` : i = i + 1
 *
 * Every index there is unfoldable, so no slot is nameable. `fillsOf` exists for
 * that case: it reports the assignments in source order and lets the caller pair
 * two tables positionally, which needs no arithmetic at all — see
 * `valueLists.ts`.
 *
 * Scope is whatever the caller passes; nothing here reads the filesystem.
 */

import type { GdlDocument, Statement } from './analyzer';
import type { Token } from './lexer';
import { CLAUSE_STARTERS, assignmentOperatorAt, isOperator } from './indirect';
import { foldConstant } from './arguments';

/** One assignment into an array slot, kept in source order. */
export interface ArrayFill {
	/** The subscript exactly as written, normalised for whitespace and case. */
	readonly subscript: string;
	/** The array being written. */
	readonly array: string;
	/** Tokens inside a single pair of brackets, when the target is that simple. */
	readonly index: readonly Token[] | undefined;
	/** The value tokens, for the caller to fold or read as a literal. */
	readonly value: readonly Token[];
}

export interface LiteralScope {
	/** The number a name is a constant for, or undefined if it is not one. */
	numberOf(name: string): number | undefined;
	/** The string a scalar was set to, when exactly one literal was put there. */
	stringOf(name: string): string | undefined;
	/** The string a slot such as `stValues[1]` holds, when exactly one was put there. */
	stringAt(array: string, index: number): string | undefined;
	/** Every subscripted assignment to `array`, in source order. */
	fillsOf(array: string): readonly ArrayFill[];
}

/** A name written more than once tells us nothing; the key is poisoned. */
const AMBIGUOUS = Symbol('ambiguous');

type Slot<T> = T | typeof AMBIGUOUS;

/**
 * Records `value` under `key`. A second, different value — or an unfoldable one,
 * which arrives as undefined — leaves the key unusable for good.
 */
function record<T>(into: Map<string, Slot<T>>, key: string, value: T | undefined): void {
	const existing = into.get(key);
	if (value === undefined || (existing !== undefined && existing !== value)) into.set(key, AMBIGUOUS);
	else if (existing === undefined) into.set(key, value);
}

function settled<T>(from: Map<string, Slot<T>>, key: string): T | undefined {
	const slot = from.get(key);
	return slot === undefined || slot === AMBIGUOUS ? undefined : slot;
}

/**
 * The tokens of a target's subscript, rendered as a key.
 *
 * Case and whitespace are dropped so `stValues[ I ]` and `stvalues[i]` agree —
 * GDL is case-insensitive everywhere but a jump label.
 */
function subscriptKey(toks: readonly Token[], from: number, to: number): string {
	let key = '';
	for (let i = from; i < to; i++) key += toks[i].lower;
	return key;
}

/** The contents of a string token, quotes stripped. */
export function stringValue(tok: Token | undefined): string | undefined {
	if (tok?.type !== 'string' || tok.unterminated) return undefined;
	return tok.text.slice(1, -1);
}

interface Index {
	readonly constants: Map<string, Slot<number>>;
	readonly strings: Map<string, Slot<string>>;
	readonly fills: Map<string, ArrayFill[]>;
	/** Tables written through a subscript that could not be folded. */
	readonly unindexed: Set<string>;
}

function scan(stmt: Statement, index: Index): void {
	const toks = stmt.tokens;

	for (let i = 0; i < toks.length; i++) {
		const head = toks[i];
		if (head.type !== 'identifier') continue;

		const eq = assignmentOperatorAt(toks, i);
		if (eq === undefined) continue;

		// The value runs to the end of the statement or to its next clause:
		// `IF a THEN x = 1 ELSE` holds an assignment and then something else.
		let end = eq + 1;
		while (end < toks.length && !(toks[end].type === 'identifier' && CLAUSE_STARTERS.has(toks[end].lower))) end++;
		const value = toks.slice(eq + 1, end);

		if (value.length === 0) {
			i = eq;
			continue;
		}

		if (eq === i + 1) {
			// A bare name, which may be either half of the idiom: the number
			// (`DIRVALUES_PERPEND = 1`) or the caption (`sAligned = \`Aligned\``).
			// Both are recorded, and the ambiguity rule is what keeps an
			// ordinary working variable from posing as either.
			record(index.constants, head.lower, foldConstant(value));
			record(index.strings, head.lower, value.length === 1 ? stringValue(value[0]) : undefined);
		} else if (isOperator(toks[i + 1], '[')) {
			// `a[…]` and nothing deeper: `a[1][2]` keeps its brackets in the
			// slice, which folds to nothing, so it is not offered as an index.
			const simple = isOperator(toks[eq - 1], ']') && !toks.slice(i + 2, eq - 1).some((t) => t.text === '[');
			const fill: ArrayFill = {
				subscript: subscriptKey(toks, i + 1, eq),
				array: head.lower,
				index: simple ? toks.slice(i + 2, eq - 1) : undefined,
				value,
			};
			const fills = index.fills.get(head.lower);
			if (fills) fills.push(fill);
			else index.fills.set(head.lower, [fill]);
		}

		i = eq;
	}
}

/**
 * Folds an expression that may name constants — `str_myenum[ENUM_1]`'s
 * subscript, and any other index written the way the guide says an author
 * should write it.
 *
 * `foldConstant` refuses an identifier outright, which is right for a bitmask
 * argument and too strict here: a poor man's enum is *made* of named numbers.
 * So known constants are substituted first and anything still unknown makes the
 * whole fold fail, exactly as before.
 */
export function foldInScope(tokens: readonly Token[], scope: LiteralScope): number | undefined {
	const substituted: Token[] = [];
	for (const tok of tokens) {
		if (tok.type !== 'identifier') {
			substituted.push(tok);
			continue;
		}
		const known = scope.numberOf(tok.lower);
		if (known === undefined) return undefined;
		// `foldConstant` reads `text`, and a negative constant must keep its
		// sign rather than arrive as a bare `-` the shunting-yard would take
		// for an operator.
		substituted.push({ ...tok, type: 'number', text: String(known), lower: String(known) });
	}
	return foldConstant(substituted);
}

/**
 * Indexes the constants and string tables of `docs`.
 *
 * **Two passes**, and the second is not optional: the subscript that files a
 * caption is itself routinely one of the constants —
 *
 *     SCALE_PAPER = 1 : str_scale[SCALE_PAPER] = `Maßstabsunabhängig`
 *
 * — so nothing can be filed until every constant has been read. Folding as we
 * went left `str_scale` looking like a table written through an unknown index,
 * which poisoned it whole; 13 corpus parts are written exactly this way. It is
 * the same reason `groups.ts` and `colors.ts` each take two passes over a
 * script rather than deciding a statement at a time.
 */
export function literalScope(docs: readonly GdlDocument[]): LiteralScope {
	const index: Index = {
		constants: new Map(),
		strings: new Map(),
		fills: new Map(),
		unindexed: new Set(),
	};

	for (const doc of docs) for (const stmt of doc.statements) scan(stmt, index);

	const scope: LiteralScope = {
		numberOf: (name) => settled(index.constants, name.toLowerCase()),
		stringOf: (name) => settled(index.strings, name.toLowerCase()),
		stringAt: (array, at) => {
			const key = array.toLowerCase();
			// One write through an unfoldable subscript could have landed on any
			// slot of the table, so none of them can be trusted.
			return index.unindexed.has(key) ? undefined : settled(index.strings, `${key}[${at}]`);
		},
		fillsOf: (array) => index.fills.get(array.toLowerCase()) ?? [],
	};

	for (const fills of index.fills.values()) {
		for (const fill of fills) {
			const at = fill.index ? foldInScope(fill.index, scope) : undefined;
			if (at === undefined) index.unindexed.add(fill.array);
			else {
				record(index.strings, `${fill.array}[${at}]`, fill.value.length === 1 ? stringValue(fill.value[0]) : undefined);
			}
		}
	}

	return scope;
}
