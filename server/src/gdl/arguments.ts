/**
 * Splitting a statement into its arguments, and folding an argument that is
 * nothing but constants.
 *
 * GDL commands are positional and unbracketed — `POLY2_B n, frame_fill, …` —
 * so an argument is a run of tokens between commas at bracket depth zero.
 * `str (x, 1, 0)` is one argument, not three; `gr_out[i]` likewise.
 *
 * Shared by signature help, which needs to know which argument the cursor is
 * in, and by the mask hints, which need the value of one particular argument.
 */

import type { Token } from './lexer';
import type { Statement } from './analyzer';

export interface Argument {
	readonly tokens: readonly Token[];
	readonly index: number;
}

/**
 * The statement's arguments, the command word itself excluded.
 *
 * A trailing empty argument is kept — after `poly2_b 5,` the cursor is in
 * argument 1, and signature help exists precisely to say what goes there.
 */
export function splitArguments(stmt: Statement): Argument[] {
	const args: Argument[] = [];
	let current: Token[] = [];
	let depth = 0;

	for (const token of stmt.tokens.slice(1)) {
		if (token.type === 'operator' && (token.text === '(' || token.text === '[')) depth++;
		else if (token.type === 'operator' && (token.text === ')' || token.text === ']')) depth--;
		else if (token.type === 'operator' && token.text === ',' && depth <= 0) {
			args.push({ tokens: current, index: args.length });
			current = [];
			continue;
		}
		current.push(token);
	}
	args.push({ tokens: current, index: args.length });
	return args;
}

/** Which argument an offset falls in, or the last one when it is past the end. */
export function argumentAt(args: readonly Argument[], offset: number): number {
	for (const arg of args) {
		const last = arg.tokens[arg.tokens.length - 1];
		if (!last || offset <= last.end) return arg.index;
	}
	return args.length - 1;
}

/**
 * Evaluates an argument built entirely from numeric literals.
 *
 * Bitmasks are written as sums — `1 + 2 + 64`, and 2610 of the corpus's 2972
 * `POLY2*` masks are exactly that — but 341 read a variable
 * (`1 + 2 * has_fill + 4`) and cannot be known without running the script. So
 * this returns undefined the moment anything but a number or an arithmetic
 * operator appears, which is the same line every other feature here draws
 * between a literal and a computed value.
 *
 * A plain shunting-yard over `+ - * / ( )`; no `eval`, and nothing that could
 * reach a name.
 */
export function foldConstant(tokens: readonly Token[]): number | undefined {
	const values: number[] = [];
	const ops: string[] = [];
	/** `NEGATE` binds tighter than any binary operator: `2 * -1` is -2, not 0. */
	const NEGATE = 'u-';
	const precedence: Readonly<Record<string, number>> = { '+': 1, '-': 1, '*': 2, '/': 2, [NEGATE]: 3 };

	const apply = (): boolean => {
		const op = ops.pop();
		if (op === undefined || op === '(') return false;

		const right = values.pop();
		if (right === undefined) return false;
		if (op === NEGATE) {
			values.push(-right);
			return true;
		}

		const left = values.pop();
		if (left === undefined) return false;
		if (op === '/' && right === 0) return false;
		values.push(op === '+' ? left + right : op === '-' ? left - right : op === '*' ? left * right : left / right);
		return true;
	};

	/** A `-` is a sign rather than an operator when nothing can be to its left. */
	let expectValue = true;

	for (const token of tokens) {
		if (token.type === 'number') {
			if (!expectValue) return undefined;
			const value = Number(token.text);
			if (!Number.isFinite(value)) return undefined;
			values.push(value);
			expectValue = false;
			continue;
		}
		if (token.type !== 'operator') return undefined;

		if (token.text === '(') {
			if (!expectValue) return undefined;
			ops.push('(');
			continue;
		}
		if (token.text === ')') {
			if (expectValue) return undefined;
			while (ops.length && ops[ops.length - 1] !== '(') if (!apply()) return undefined;
			if (ops.pop() !== '(') return undefined;
			continue;
		}
		if (!(token.text in precedence)) return undefined;

		if (expectValue) {
			// Unary: `-1` is ordinary GDL, and `+1` is legal — the guide asks for
			// a space instead, but real code aligns columns with it either way.
			// Right-associative, so it is stacked rather than resolved here.
			if (token.text === '-') ops.push(NEGATE);
			else if (token.text !== '+') return undefined;
			continue;
		}
		while (
			ops.length &&
			ops[ops.length - 1] !== '(' &&
			precedence[ops[ops.length - 1]] >= precedence[token.text]
		) {
			if (!apply()) return undefined;
		}
		ops.push(token.text);
		expectValue = true;
	}

	if (expectValue) return undefined;
	while (ops.length) if (!apply()) return undefined;
	return values.length === 1 ? values[0] : undefined;
}
