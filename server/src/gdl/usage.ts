/**
 * Which names a script *writes* and which it *reads*.
 *
 * `analyzer.ts` already records where every variable occurs, but it records
 * occurrences and not their direction: the sweep that fills `references`
 * counts the target of `x = 1` alongside the `x` of `y = x`. That is enough
 * for completion and hover, and no use at all to a check that has to tell a
 * variable which is only ever written from one that is actually used.
 *
 * So this is a second pass over the same statements, classifying each
 * identifier as a write, a read, or neither. `gdl/assignments.ts` decides what
 * a write looks like — `=` being both of GDL's operators, that is the hard
 * half — and everything below is about the shapes where an identifier is not a
 * variable of this script at all.
 *
 * **Every uncertainty is resolved towards "read".** A name wrongly counted as
 * read is a report this never makes; a name wrongly counted as write-only is a
 * grey line through working code. The second is much worse, so where the
 * direction cannot be told — the arguments of a call that writes back into
 * them, most of all — the lenient answer is taken.
 */

import type { GdlDocument, Statement } from './analyzer';
import { assignedName, claimedNames } from './assignments';
import { lookupWithVariants } from './keywords';
import type { Token } from './lexer';

/**
 * What a write to a name actually is.
 *
 *   - `value` — a computed result. `A_h = A / 2` does work, and if nothing
 *     reads `A_h` the work is thrown away. This is the only kind that means
 *     anything is wrong.
 *   - `declaration` — a name bound to a literal, or a `DIM`. `SILL_TIMBER = 1`
 *     is an entry in a constant table, and such a table is written out
 *     *complete* on purpose: the members this particular object happens not
 *     to use are the point, not an oversight.
 *   - `discard` — the binding a call needs in order to be made at all. GDL
 *     has no statement form for `REQUEST` and friends, so their result must
 *     go somewhere, and `rrr` is where the corpus puts it.
 */
export type WriteKind = 'value' | 'declaration' | 'discard';

export interface Write {
	readonly token: Token;
	readonly kind: WriteKind;
}

export interface NameUsage {
	/** As first written, for the message. */
	readonly name: string;
	/** Every site that writes the name, in source order. */
	readonly writes: Write[];
	/** Whether anything ever reads it. */
	reads: number;
	/** Defined by `FOR i = …`, whose counter need not be read to be doing work. */
	isLoopVariable: boolean;
}

/**
 * The variable a token names.
 *
 * A dotted path lexes as one token, and only its leading segment is a variable
 * of this script — the same half rename rewrites, and the same `split('.')[0]`
 * `typecheck.ts` uses to forget a type.
 */
export function variableKey(tok: Token): string {
	return tok.lower.split('.')[0];
}

/**
 * Calls that fill in the variables handed to them, rather than reading them.
 *
 * The same set `typecheck.ts` keeps, and for the same reason — after
 * `n = LIBRARYGLOBAL("MARKERS", "pen", p)` whatever `p` held is gone. There the
 * consequence is that a type must be forgotten; here it is that the direction
 * of every argument is unknowable, since a `REQUEST` reads some of its
 * arguments and writes others. Both are counted as reads, which is the lenient
 * answer: a variable that only ever comes back out of a `REQUEST` is never
 * reported, and no variable is ever reported for being passed *into* one.
 */
const OUTPUT_WRITING_CALLS = /^(request|req|application_query|libraryglobal|split)(\{\d+\})?$/;

/**
 * Calls whose whole purpose is the effect, so the name the result lands in is
 * not being used for anything.
 *
 * GDL has no statement form for any of these — a call is an expression, and an
 * expression has to be assigned somewhere — so the corpus keeps a scratch name
 * to throw the result at, `rrr` and `dummy` and `_unused` being the usual
 * spellings. Greying those is greying the only way to write the call.
 *
 * Beyond the write-back calls above:
 *
 *   - **`GET (n)`** consumes `n` values from the parameter buffer, and
 *     `dummy = GET (1)` is how the corpus skips one — 60 sites, and the whole
 *     point is the pointer moving. (`GET` is a function rather than a command,
 *     which is the correction recorded under "A value spelt with a keyword".)
 *   - **`CALLFUNCTION`** and **`INPUT`** fill in the arguments handed to them,
 *     exactly as `REQUEST` does.
 *   - **`REMOVEKEY`** deletes a dictionary key and reports whether it managed.
 *   - **`STORED_PAR_VALUE` / `DELETED_PAR_VALUE`** hand back a parameter of the
 *     *old* list in a migration script, through their last argument.
 */
const CALLED_FOR_EFFECT =
	/^(request|req|application_query|libraryglobal|split|get|callfunction|input|removekey|stored_par_value|deleted_par_value)(\{\d+\})?$/;

function isOp(tok: Token | undefined, text: string): boolean {
	return tok?.type === 'operator' && tok.text === text;
}

/**
 * The parameter names a statement addresses, by token index.
 *
 * `PARAMETERS x = 1` names an entry of a parameter list — this part's own, or
 * after `CALL` the macro's — and defines no variable either way. The `x` is
 * therefore neither a write nor a read, while everything to the right of the
 * `=` is an ordinary expression and is read normally.
 *
 * A macro parameter may be named after a command (`material = 3`) or be a whole
 * path (`style[1] = 3`); the `=` straight after the path is the tell, which is
 * the same thing `commas.ts` leans on to know an argument row from a command.
 */
function parameterNamePositions(toks: readonly Token[]): Set<number> {
	const positions = new Set<number>();

	for (let i = 0; i < toks.length; i++) {
		if (toks[i].type !== 'identifier' || toks[i].lower !== 'parameters') continue;

		// Everything after the keyword is a `name = value` list, one name per
		// comma. `ALL` may open it, and is a keyword rather than a name.
		for (let j = i + 1; j < toks.length; j++) {
			const prev = toks[j - 1];
			const atBoundary =
				j === i + 1 ||
				isOp(prev, ',') ||
				(prev.type === 'identifier' && prev.lower === 'all');
			if (!atBoundary) continue;
			if (assignedName(toks, j)) positions.add(j);
		}
		break;
	}

	return positions;
}

/** True for an identifier that cannot be a variable of this script. */
function isNotAVariable(toks: readonly Token[], i: number): boolean {
	const tok = toks[i];

	// A dict member arrives on its own when the lexer breaks a dotted path at a
	// subscript — the `edge` of `pbuf.line[i].edge[j]`. `arrays.ts` meets the
	// same shape, and misses every dict-of-arrays in the corpus without it.
	if (isOp(toks[i - 1], '.')) return true;

	// A keyword is Archicad's name, not the author's: the ~800 globals, the
	// fixed parameters, the commands. `reservedNames.ts` is what reports an
	// author claiming one; here it only means the name is not ours to judge.
	return lookupWithVariants(tok.text) !== undefined;
}

/**
 * What the right-hand side of an assignment amounts to.
 *
 * The span runs from just after the `=` to the end of the clause, `THEN` and
 * `ELSE` being where the next one starts — `IF a THEN x = 1 ELSE y = 2` holds
 * two assignments and neither reaches the other.
 */
function writeKind(toks: readonly Token[], eq: number): WriteKind {
	let end = toks.length;
	for (let i = eq + 1; i < toks.length; i++) {
		const tok = toks[i];
		if (tok.type === 'identifier' && (tok.lower === 'then' || tok.lower === 'else')) {
			end = i;
			break;
		}
	}

	let start = eq + 1;
	// The guide is explicit that `-` is GDL's unary sign and `+` is not one, so
	// only the minus is stepped over here — the same asymmetry `operators.ts`
	// turns on.
	if (isOp(toks[start], '-')) start++;

	const body = toks.slice(start, end);
	if (body.length === 0) return 'declaration';

	// A lone literal binds a name to a constant, which is a declaration however
	// the author spells it.
	if (body.length === 1 && (body[0].type === 'number' || body[0].type === 'string')) {
		return 'declaration';
	}

	// A call made for its effect, filling in the arguments handed to it. The
	// binding is the language's price for making the call, not a use of the name.
	// The call must be the *whole* right-hand side: `x = GET (1) + GET (1)` ends
	// on a bracket too, and is arithmetic whose result someone meant to keep.
	const head = body[0];
	if (head.type === 'identifier' && CALLED_FOR_EFFECT.test(head.lower) && isOp(body[1], '(')) {
		let depth = 0;
		for (let i = 1; i < body.length; i++) {
			if (isOp(body[i], '(')) depth++;
			else if (isOp(body[i], ')')) {
				depth--;
				if (depth === 0) return i === body.length - 1 ? 'discard' : 'value';
			}
		}
	}

	return 'value';
}

/** Adds one statement's names to `usage`. */
function classify(stmt: Statement, usage: Map<string, NameUsage>): void {
	const toks = stmt.tokens;
	if (toks.length === 0) return;

	const writes = new Map<number, { kind: WriteKind; isLoopVariable: boolean }>();
	for (const claim of claimedNames(stmt)) {
		const at = toks.indexOf(claim.token);
		if (at < 0) continue;
		writes.set(at, {
			kind: writeKind(toks, claim.eq),
			isLoopVariable: claim.isLoopVariable,
		});
	}

	// `DIM a[4], b[]` declares without assigning, and a declared-but-unread
	// array is exactly the shape this check exists to grey out. The guide has
	// `DIM` at the head of its own statement and 0 corpus sites write it
	// anywhere else, so `stmt.head` is enough — the same reading `arrays.ts`
	// takes when it collects declarations.
	if (stmt.head === 'dim') {
		for (let i = 1; i < toks.length; i++) {
			const prev = toks[i - 1];
			if (i !== 1 && !isOp(prev, ',')) continue;
			if (toks[i].type === 'identifier') {
				writes.set(i, { kind: 'declaration', isLoopVariable: false });
			}
		}
	}

	const parameterNames = parameterNamePositions(toks);

	// Argument lists that are read wholesale rather than judged: see
	// OUTPUT_WRITING_CALLS above, and `RETURNED_PARAMETERS a, b`, which runs to
	// the end of the statement.
	const readWholesale = new Set<number>();
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i];
		if (tok.type !== 'identifier') continue;
		if (tok.lower === 'returned_parameters') {
			for (let j = i + 1; j < toks.length; j++) readWholesale.add(j);
			break;
		}
		if (!OUTPUT_WRITING_CALLS.test(tok.lower) || !isOp(toks[i + 1], '(')) continue;
		let depth = 0;
		for (let j = i + 1; j < toks.length; j++) {
			if (isOp(toks[j], '(')) depth++;
			else if (isOp(toks[j], ')')) {
				depth--;
				if (depth === 0) break;
			} else readWholesale.add(j);
		}
	}

	const record = (tok: Token, write: { kind: WriteKind; isLoopVariable: boolean } | undefined) => {
		const key = variableKey(tok);
		let entry = usage.get(key);
		if (!entry) {
			// A dotted token carries members the key does not; the name shown is
			// the leading segment as the author spelt it.
			entry = { name: tok.text.slice(0, key.length), writes: [], reads: 0, isLoopVariable: false };
			usage.set(key, entry);
		}
		if (!write) {
			entry.reads++;
			return;
		}
		entry.writes.push({ token: tok, kind: write.kind });
		if (write.isLoopVariable) entry.isLoopVariable = true;
	};

	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i];
		if (tok.type !== 'identifier') continue;
		if (parameterNames.has(i)) continue;
		if (isNotAVariable(toks, i)) continue;

		const write = readWholesale.has(i) ? undefined : writes.get(i);
		record(tok, write);
	}
}

/**
 * How every name of one script is used.
 *
 * Keyed on the lower-cased leading segment, GDL being case-insensitive
 * everywhere but in a jump label.
 */
export function nameUsage(doc: GdlDocument): Map<string, NameUsage> {
	const usage = new Map<string, NameUsage>();
	for (const stmt of doc.statements) classify(stmt, usage);
	return usage;
}

/**
 * Memoised per analysed document. A variable of the master or parameter script
 * is judged against every other script of the part, so an edit there asks the
 * same question of up to seven siblings — and `masterScript.ts` hands back the
 * *same* `GdlDocument` for each until its text changes, which is exactly the
 * lifetime this should hold for.
 */
const readCache = new WeakMap<GdlDocument, Set<string>>();

/** The names a script reads, for asking whether a sibling's variable is live. */
export function namesRead(doc: GdlDocument): Set<string> {
	const cached = readCache.get(doc);
	if (cached) return cached;

	const read = new Set<string>();
	for (const [key, entry] of nameUsage(doc)) if (entry.reads > 0) read.add(key);
	readCache.set(doc, read);
	return read;
}
