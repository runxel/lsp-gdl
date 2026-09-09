/**
 * What a statement writes to.
 *
 * `=` is both of GDL's operators — assignment and equality — so deciding
 * whether a name is being *claimed* or merely *compared* is a question two
 * features already ask, from opposite ends. `providers/reservedNames.ts` asks
 * it to report a keyword used as a variable name; `gdl/usage.ts` asks it to
 * tell a write from a read. The answer was worked out on the corpus for the
 * first of those (see that file's header for the measurements), so it lives
 * here rather than being written twice and drifting apart.
 *
 * The target may carry subscripts and dict members in any order, and it is an
 * assignment only when the `=` comes straight after that whole path:
 *
 *     gr_out[i] = "gr_media"        <- a claim
 *     _drods.f[1].gr = "gr_leg"     <- a claim
 *     IF pen = 3 THEN               <- a question
 *
 * Reading the second shape as the third fired 21042 times on the corpus by
 * itself, which is the measurement that shaped `assignedName`.
 */

import type { Statement } from './analyzer';
import type { Token } from './lexer';

/**
 * The identifier assigned to at `i`, or undefined when nothing is.
 *
 * Only the path is walked here; whether the head names a variable of this
 * script — as opposed to a parameter, a global or a dict member — is the
 * caller's question.
 */
export interface Assignment {
	/** The name being written. */
	readonly head: Token;
	/** Index of the `=`, so a caller can read what is assigned. */
	readonly eq: number;
}

/** The assignment at `i`, or undefined when nothing is being assigned. */
export function assignmentAt(toks: readonly Token[], i: number): Assignment | undefined {
	const head = toks[i];
	if (head?.type !== 'identifier') return undefined;

	let j = i + 1;
	for (;;) {
		const tok = toks[j];
		if (tok?.type !== 'operator') break;
		if (tok.text === '[') {
			// Skip the whole subscript; it may itself be an indexed expression.
			let depth = 0;
			for (; j < toks.length; j++) {
				const inner = toks[j];
				if (inner.type !== 'operator') continue;
				if (inner.text === '[' || inner.text === '(') depth++;
				else if (inner.text === ']' || inner.text === ')') {
					depth--;
					if (depth === 0) {
						j++;
						break;
					}
				}
			}
			if (depth !== 0) return undefined; // unbalanced — `parens.ts` reports it
			continue;
		}
		// A `.` only ever follows a subscript here; `pt.start` is one token.
		if (tok.text === '.' && toks[j + 1]?.type === 'identifier') {
			j += 2;
			continue;
		}
		break;
	}

	const eq = toks[j];
	return eq?.type === 'operator' && eq.text === '=' ? { head, eq: j } : undefined;
}

/** Just the name assigned to at `i`, for callers with no use for the `=`. */
export function assignedName(toks: readonly Token[], i: number): Token | undefined {
	return assignmentAt(toks, i)?.head;
}

/** Where each clause of the statement begins: the head, and after every THEN/ELSE. */
export function clauseStarts(toks: readonly Token[]): number[] {
	const starts = [0];
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i];
		if (tok.type !== 'identifier') continue;
		if (tok.lower === 'then' || tok.lower === 'else') starts.push(i + 1);
	}
	return starts;
}

/** A name a statement claims, and how it came to claim it. */
export interface ClaimedName {
	readonly token: Token;
	/** Index of the `=`, so a caller can read what is being assigned. */
	readonly eq: number;
	/** True for `FOR i = 1 TO n`, whose variable is the loop counter. */
	readonly isLoopVariable: boolean;
}

/**
 * Every name this statement claims for a variable of the current script.
 *
 * Three forms, each measured against the corpus in `reservedNames.ts`'s
 * header: a plain assignment (151483 of them), `FOR name = 1 TO n` (4529) and
 * the legacy `LET name = …` (one). Every clause is judged, not just the head,
 * so `IF a THEN addx = 1` is seen — the walk restarts at `THEN`/`ELSE` the way
 * `groups.ts` and `paramNames.ts` do.
 *
 * `PARAMETERS x = …` is skipped whole: those names address a parameter list —
 * this part's own, or after `CALL` the macro's — and never define a variable.
 */
export function claimedNames(stmt: Statement): ClaimedName[] {
	if (stmt.head === 'parameters') return [];

	const toks = stmt.tokens;
	const claimed: ClaimedName[] = [];

	for (const start of clauseStarts(toks)) {
		const assigned = assignmentAt(toks, start);
		if (assigned) {
			claimed.push({ token: assigned.head, eq: assigned.eq, isLoopVariable: false });
			continue;
		}
		const word = toks[start];
		if (word?.type !== 'identifier') continue;
		if (word.lower === 'for' && toks[start + 1]?.type === 'identifier') {
			claimed.push({ token: toks[start + 1], eq: start + 2, isLoopVariable: true });
		} else if (word.lower === 'let') {
			const target = assignmentAt(toks, start + 1);
			if (target) claimed.push({ token: target.head, eq: target.eq, isLoopVariable: false });
		}
	}

	return claimed;
}
