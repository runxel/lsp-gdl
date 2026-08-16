/**
 * Type checking for GDL.
 *
 * GDL is deliberately lenient — the reference guide notes that a simple
 * variable "can be given numerical and string values, even in the same script".
 * It compiles, it runs, and then it surprises somebody six months later. The
 * point of this checker is to surface those moments, not to reject them.
 *
 * The rules, in order of how badly they bite:
 *
 *   1. **Nested arrays inside dictionaries are strictly typed.** The guide is
 *      explicit — "the values of a nested array has to be of the same type (all
 *      string, all integer, all floating-point or all dictionary types), this
 *      is contrary to how arrays work, so extra caution is needed!" Mixing them
 *      is a hard GDL error, including `int` with `float`.
 *   2. **A dictionary key that holds an integer will not widen to a real.**
 *      Unlike a plain variable, no silent conversion happens, so the fraction
 *      is lost.
 *   3. **A parameter's declared type is a contract.** Assigning a real to an
 *      Integer parameter (or a string to a numeric one) breaks it.
 *   4. **Swapping a variable between string and numeric** is legal but almost
 *      always a mistake.
 *
 * Everything here stays silent when either side of an assignment is `unknown`.
 * Globals, macro results and unresolved calls are all unknown, and a checker
 * that guesses about them would be worse than no checker at all.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument, Statement } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';
import { libPartFor } from '../gdl/libpart';
import {
	functionReturnType,
	isKindMismatch,
	numberLiteralType,
	parameterType,
	typeLabel,
	type GdlType,
} from '../gdl/types';

export const SOURCE = 'gdl';

/** How a name is stored, which decides how strict the type rules are. */
type Container = 'scalar' | 'array' | 'dict' | 'dictarray';

interface Slot {
	/** For arrays this is the *element* type. */
	type: GdlType;
	container: Container;
	/** Declared type, when the name is a library part parameter. */
	declared?: GdlType;
	parameterName?: string;
}

interface Target {
	readonly key: string;
	readonly container: Container;
	readonly token: Token;
	/** Length of the written name, so the squiggle covers `d.x` not `d.x[1]`. */
	readonly nameLength: number;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function isOp(tok: Token | undefined, text: string): boolean {
	return tok?.type === 'operator' && tok.text === text;
}

/** Index just past the bracket group opening at `open`, or `open` if unmatched. */
function skipBrackets(tokens: readonly Token[], open: number): number {
	const closer = tokens[open]?.text === '[' ? ']' : ')';
	let depth = 0;
	for (let i = open; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type !== 'operator') continue;
		if (t.text === '[' || t.text === '(') depth++;
		else if (t.text === ']' || t.text === ')') {
			depth--;
			if (depth === 0) return t.text === closer ? i + 1 : i + 1;
		}
	}
	return tokens.length;
}

/** Positions of top-level commas in `[from, to)`. */
function topLevelCommas(tokens: readonly Token[], from: number, to: number): number[] {
	const out: number[] = [];
	let depth = 0;
	for (let i = from; i < to; i++) {
		const t = tokens[i];
		if (t.type !== 'operator') continue;
		if (t.text === '[' || t.text === '(') depth++;
		else if (t.text === ']' || t.text === ')') depth--;
		else if (t.text === ',' && depth === 0) out.push(i);
	}
	return out;
}

// ---------------------------------------------------------------------------
// Expression typing
// ---------------------------------------------------------------------------

/**
 * Infers the type of the expression in `[from, to)`.
 *
 * Combination rules follow the guide: a string anywhere makes the result a
 * string (`+` concatenates); otherwise any real operand, division or
 * exponentiation makes it real; otherwise it stays integer.
 */
const RELATIONAL = new Set(['=', '<', '>', '<=', '>=', '<>', '#']);
const BOOLEAN_OPS = new Set(['&', '|', '@']);
const BOOLEAN_WORDS = new Set(['and', 'or', 'exor']);

/**
 * True when a comparison or boolean operator sits at the top level of the
 * range, which makes the whole expression a 0/1 integer.
 *
 * This matters more than it sounds. GDL code leans on booleans-as-numbers
 * constantly, and the operands are often strings:
 *
 *   UIpicIdxArray[j] = 4 + (dk_orientation = "BGS")
 *
 * Reading that as a string assignment — because a string literal appears in it
 * — is exactly the sort of confident nonsense a type checker must not produce.
 */
function yieldsBoolean(tokens: readonly Token[], from: number, to: number): boolean {
	let depth = 0;
	for (let i = from; i < to; i++) {
		const t = tokens[i];
		if (t.type === 'operator') {
			if (t.text === '[' || t.text === '(') depth++;
			else if (t.text === ']' || t.text === ')') depth--;
			else if (depth === 0 && (RELATIONAL.has(t.text) || BOOLEAN_OPS.has(t.text))) return true;
		} else if (t.type === 'identifier' && depth === 0 && BOOLEAN_WORDS.has(t.lower)) {
			return true;
		}
	}
	return false;
}

function inferType(
	tokens: readonly Token[],
	from: number,
	to: number,
	env: ReadonlyMap<string, Slot>,
	dicts: ReadonlySet<string>,
): GdlType {
	// Relational and boolean operators bind loosest, so if one appears at this
	// level the result is a boolean regardless of what it compared.
	if (yieldsBoolean(tokens, from, to)) return 'int';

	let sawString = false;
	let sawFloat = false;
	let sawUnknown = false;
	let sawOperand = false;
	let forcesFloat = false;

	const note = (t: GdlType) => {
		sawOperand = true;
		if (t === 'string') sawString = true;
		else if (t === 'float') sawFloat = true;
		else if (t === 'unknown' || t === 'dict') sawUnknown = true;
	};

	let i = from;
	while (i < to) {
		const tok = tokens[i];

		if (tok.type === 'number') {
			note(numberLiteralType(tok.text));
			i++;
			continue;
		}

		if (tok.type === 'string') {
			note('string');
			i++;
			continue;
		}

		if (tok.type === 'identifier') {
			const next = tokens[i + 1];

			// Function call — the argument types must not leak into the result.
			if (isOp(next, '(')) {
				const ret = functionReturnType(tok.text);
				const end = skipBrackets(tokens, i + 1);
				if (ret === 'propagate') {
					note(inferType(tokens, i + 2, end - 1, env, dicts));
				} else if (ret) {
					note(ret);
				} else {
					note('unknown');
				}
				i = end;
				continue;
			}

			// Indexed access — the element type, not the index expression's.
			if (isOp(next, '[')) {
				let end = skipBrackets(tokens, i + 1);
				if (isOp(tokens[end], '[')) end = skipBrackets(tokens, end);
				note(env.get(tok.lower)?.type ?? 'unknown');
				i = end;
				continue;
			}

			if (dicts.has(tok.lower)) note('dict');
			else note(env.get(tok.lower)?.type ?? 'unknown');
			i++;
			continue;
		}

		if (tok.type === 'operator') {
			if (tok.text === '(') {
				const end = skipBrackets(tokens, i);
				note(inferType(tokens, i + 1, end - 1, env, dicts));
				i = end;
				continue;
			}
			// Division and exponentiation always yield a real.
			if (tok.text === '/' || tok.text === '^' || tok.text === '**') forcesFloat = true;
		}

		i++;
	}

	if (!sawOperand) return 'unknown';
	if (sawString) return 'string';
	if (sawUnknown) return 'unknown';
	if (sawFloat || forcesFloat) return 'float';
	return 'int';
}

// ---------------------------------------------------------------------------
// Assignment targets
// ---------------------------------------------------------------------------

/** Reads the assignment target starting at `from`, or null if there is none. */
function readTarget(tokens: readonly Token[], from: number): { target: Target; eq: number } | null {
	const tok = tokens[from];
	if (tok?.type !== 'identifier') return null;

	let i = from + 1;
	let indexed = false;
	while (isOp(tokens[i], '[')) {
		indexed = true;
		i = skipBrackets(tokens, i);
	}
	if (!isOp(tokens[i], '=')) return null;

	// Dot notation exists only for dictionary keys, so a dotted name is always
	// a dictionary member — whether or not we saw its `DICT` declaration
	// (it may come from a macro or a parameter).
	const isDictMember = tok.text.includes('.');

	const container: Container = isDictMember
		? indexed
			? 'dictarray'
			: 'dict'
		: indexed
			? 'array'
			: 'scalar';

	return {
		target: { key: tok.lower, container, token: tok, nameLength: tok.text.length },
		eq: i,
	};
}

/**
 * Calls that write back into the variables passed to them.
 *
 * These are why a purely left-to-right reading of a script is not enough:
 *
 *   ap_globalPen = ""                                   ! looks like a string
 *   n = LIBRARYGLOBAL("MARKERS", "pen", ap_globalPen)   ! ...but is now a pen
 *   ap_markerPen = ap_globalPen                         ! perfectly fine
 *
 * We cannot know what type comes back, so we forget what we thought we knew
 * about every identifier in the argument list. Losing information is safe;
 * asserting the wrong type is not.
 */
const OUTPUT_WRITING_CALLS = /^(request|req|application_query|libraryglobal|split)(\{\d+\})?$/;

/** Clears inferred types for variables a statement may write to indirectly. */
function invalidateOutputs(tokens: readonly Token[], env: Map<string, Slot>): void {
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.type !== 'identifier') continue;

		// `CALL "macro" ... RETURNED_PARAMETERS a, b, c`
		if (tok.lower === 'returned_parameters') {
			for (let j = i + 1; j < tokens.length; j++) {
				const t = tokens[j];
				if (t.type === 'identifier') env.delete(t.lower.split('.')[0]);
			}
			return;
		}

		if (!OUTPUT_WRITING_CALLS.test(tok.lower) || !isOp(tokens[i + 1], '(')) continue;
		const end = skipBrackets(tokens, i + 1);
		for (let j = i + 2; j < end - 1; j++) {
			const t = tokens[j];
			// Only bare identifiers can be written back to; a parameter named by
			// a string literal is addressed through `PARAMETERS`, not here.
			if (t.type === 'identifier' && !isOp(tokens[j + 1], '(')) {
				env.delete(t.lower.split('.')[0]);
				env.delete(t.lower);
			}
		}
		i = end - 1;
	}
}

/**
 * Equality operators. The guide warns that Archicad's own compiler flags
 * "comparison of reals or reals and integers using relational operators '='
 * or '<>'" as a precision problem — `0.1 + 0.2 = 0.3` is false in binary
 * floating point, and GDL is full of computed lengths and angles.
 *
 * Ordering comparisons (`<`, `>`, `<=`, `>=`) are safe and not included.
 */
const EQUALITY = new Set(['=', '<>', '#']);

/** Tokens that end an operand when scanning outward from a comparison. */
const OPERAND_BOUNDARY = new Set(['then', 'and', 'or', 'exor', 'not', 'if', 'while', 'until', 'do']);

function isBoundary(tok: Token, depth: number, atDepth: number): boolean {
	if (depth !== atDepth) return false;
	if (tok.type === 'operator') {
		return tok.text === ',' || EQUALITY.has(tok.text) || BOOLEAN_OPS.has(tok.text);
	}
	return tok.type === 'identifier' && OPERAND_BOUNDARY.has(tok.lower);
}

/**
 * Tokens after which an `ident =` is an assignment rather than a comparison.
 *
 * GDL spells assignment and equality the same way, so a single-line
 * conditional contains both:
 *
 *     IF frameType = "RR" THEN overhang = 0
 *        └── comparison ──┘      └ assignment ┘
 *
 * Missing this reads every single-line IF's assignment as a float comparison,
 * which is most of them.
 */
const ASSIGN_PRECEDERS = new Set([
	'then',
	'else',
	'for',
	// Macro call argument lists: `CALL "m" PARAMETERS x = 0.035, y = 0.02`
	'parameters',
	'all',
	'returned_parameters',
	'default',
]);

/** Indices of `=` tokens that assign rather than compare. */
function assignmentEquals(tokens: readonly Token[]): Set<number> {
	const found = new Set<number>();

	for (let k = 0; k < tokens.length; k++) {
		const tok = tokens[k];
		if (tok.type !== 'operator' || tok.text !== '=') continue;

		// Step back over any `[index]` groups to reach the target name.
		let j = k - 1;
		let depth = 0;
		while (j >= 0) {
			const t = tokens[j];
			if (t.type === 'operator' && t.text === ']') depth++;
			else if (t.type === 'operator' && t.text === '[') depth--;
			else if (depth === 0) break;
			j--;
		}
		if (j < 0 || tokens[j].type !== 'identifier') continue;

		const before = tokens[j - 1];
		if (
			j === 0 ||
			(before.type === 'identifier' && ASSIGN_PRECEDERS.has(before.lower)) ||
			(before.type === 'operator' && (before.text === ':' || before.text === ','))
		) {
			found.add(k);
		}
	}
	return found;
}

/** Flags equality tests between real values. */
function checkRealComparisons(
	tokens: readonly Token[],
	env: ReadonlyMap<string, Slot>,
	dicts: ReadonlySet<string>,
	report: (token: Token, length: number, message: string, severity: DiagnosticSeverity) => void,
): void {
	const assignments = assignmentEquals(tokens);
	const depths: number[] = [];
	let depth = 0;
	for (const t of tokens) {
		if (t.type === 'operator' && (t.text === '(' || t.text === '[')) {
			depths.push(++depth - 1);
			continue;
		}
		if (t.type === 'operator' && (t.text === ')' || t.text === ']')) {
			depths.push(--depth);
			continue;
		}
		depths.push(depth);
	}

	for (let k = 0; k < tokens.length; k++) {
		const tok = tokens[k];
		if (assignments.has(k) || tok.type !== 'operator' || !EQUALITY.has(tok.text)) continue;

		const at = depths[k];

		let left = k;
		while (left > 0 && !isBoundary(tokens[left - 1], depths[left - 1], at) && depths[left - 1] >= at) {
			left--;
		}
		let right = k + 1;
		while (
			right < tokens.length &&
			!isBoundary(tokens[right], depths[right], at) &&
			depths[right] >= at
		) {
			right++;
		}
		if (left === k || right === k + 1) continue;

		const lhs = inferType(tokens, left, k, env, dicts);
		const rhs = inferType(tokens, k + 1, right, env, dicts);
		if (lhs === 'float' || rhs === 'float') {
			if (lhs === 'unknown' || rhs === 'unknown') continue;
			report(
				tok,
				tok.text.length,
				`Comparing floating-point values with \`${tok.text}\` is unreliable — rounding makes exact equality unlikely. Compare against a tolerance instead.`,
				DiagnosticSeverity.Warning,
			);
		}
	}
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export function provideTypeDiagnostics(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const env = new Map<string, Slot>();
	const dicts = new Set<string>();

	// Seed the library part's parameters with their declared types — those are
	// the only names whose type we know before reading a line of script.
	const libpart = libPartFor(doc.uri);
	if (libpart) {
		for (const param of libpart.parameters.values()) {
			const declared = parameterType(param);
			if (declared === 'unknown') continue;
			env.set(param.name.toLowerCase(), {
				type: declared,
				container: param.dimensions ? 'array' : declared === 'dict' ? 'dict' : 'scalar',
				declared,
				parameterName: param.name,
			});
			if (declared === 'dict') dicts.add(param.name.toLowerCase());
		}
	}

	const report = (token: Token, length: number, message: string, severity: DiagnosticSeverity) => {
		diagnostics.push({
			severity,
			range: { start: td.positionAt(token.start), end: td.positionAt(token.start + length) },
			message,
			source: SOURCE,
		});
	};

	const checkAssignment = (target: Target, valueType: GdlType) => {
		if (valueType === 'unknown') return;

		const existing = env.get(target.key);
		const known = existing?.type ?? 'unknown';
		const declared = existing?.declared;
		const shown = target.token.text;

		// A parameter's declared type is a contract with Archicad.
		if (declared && declared !== 'unknown') {
			if (isKindMismatch(declared, valueType)) {
				report(
					target.token,
					target.nameLength,
					`\`${existing!.parameterName ?? shown}\` is a ${typeLabel(declared)} parameter — cannot assign a ${typeLabel(valueType)} value.`,
					DiagnosticSeverity.Error,
				);
				return;
			}
			if (declared === 'int' && valueType === 'float') {
				report(
					target.token,
					target.nameLength,
					`\`${existing!.parameterName ?? shown}\` is an Integer parameter — assigning a floating-point value truncates it.`,
					DiagnosticSeverity.Warning,
				);
				return;
			}
			return;
		}

		if (known === 'unknown') {
			// First sighting: this assignment defines the type.
			env.set(target.key, {
				type: valueType,
				container: target.container,
				...(existing ? { declared: existing.declared, parameterName: existing.parameterName } : {}),
			});
			return;
		}

		if (known === valueType) return;

		switch (target.container) {
			// Strictly typed: mixing anything, including int with float, is a
			// GDL error rather than a silent conversion.
			case 'dictarray':
				report(
					target.token,
					target.nameLength,
					`Array inside a dictionary must hold one type — \`${shown}\` holds ${typeLabel(known)}, cannot assign ${typeLabel(valueType)}.`,
					DiagnosticSeverity.Error,
				);
				return;

			case 'dict':
				if (known === 'int' && valueType === 'float') {
					report(
						target.token,
						target.nameLength,
						`Dictionary key \`${shown}\` already holds an Integer and will not widen — the fractional part is lost.`,
						DiagnosticSeverity.Warning,
					);
					return;
				}
				if (isKindMismatch(known, valueType)) {
					report(
						target.token,
						target.nameLength,
						`Dictionary key \`${shown}\` changes from ${typeLabel(known)} to ${typeLabel(valueType)}.`,
						DiagnosticSeverity.Warning,
					);
					env.set(target.key, { type: valueType, container: target.container });
				}
				return;

			case 'array':
				if (isKindMismatch(known, valueType)) {
					report(
						target.token,
						target.nameLength,
						`Array \`${shown}\` holds ${typeLabel(known)} values — assigning a ${typeLabel(valueType)} mixes types.`,
						DiagnosticSeverity.Warning,
					);
				}
				return;

			default:
				// Plain variables convert between int and float silently; only
				// crossing the numeric/string divide is worth a word.
				if (isKindMismatch(known, valueType)) {
					report(
						target.token,
						target.nameLength,
						`\`${shown}\` holds a ${typeLabel(known)} value here but is assigned a ${typeLabel(valueType)}.`,
						DiagnosticSeverity.Warning,
					);
					env.set(target.key, { type: valueType, container: target.container });
				} else {
					env.set(target.key, { type: valueType, container: target.container });
				}
				return;
		}
	};

	for (const stmt of doc.statements) {
		const toks = stmt.tokens;
		if (toks.length === 0) continue;

		// `DICT a, b` declares dictionaries.
		if (stmt.head === 'dict') {
			for (const t of toks.slice(1)) {
				if (t.type === 'identifier') dicts.add(t.lower);
			}
			continue;
		}

		// `DIM arr[]` declares an array — and, crucially, *resets* it. Library
		// code re-DIMs the same array in successive subroutines to refill it
		// with a different type, which is legal and extremely common:
		//
		//   "VALUES_edge": j = 0 : DIM UIvaluesArray[]
		//                  UIvaluesArray[j] = "E"     ! strings here
		//   "VALUES_fold": j = 0 : DIM UIvaluesArray[]
		//                  UIvaluesArray[j] = 0       ! integers here
		//
		// Forgetting this turns idiomatic code into a wall of false positives.
		if (stmt.head === 'dim') {
			let depth = 0;
			for (const t of toks.slice(1)) {
				if (t.type === 'operator') {
					if (t.text === '[' || t.text === '(') depth++;
					else if (t.text === ']' || t.text === ')') depth--;
					continue;
				}
				if (t.type === 'identifier' && depth === 0) env.delete(t.lower);
			}
			continue;
		}

		// `FOR i = 1 TO n` — the loop variable is an integer counter.
		if (stmt.head === 'for' && toks[1]?.type === 'identifier') {
			env.set(toks[1].lower, { type: 'int', container: 'scalar' });
			continue;
		}

		// `PARAMETERS name = expr, name2 = expr2`
		if (stmt.head === 'parameters') {
			const bounds = [1, ...topLevelCommas(toks, 1, toks.length).map((c) => c + 1), toks.length];
			for (let b = 0; b < bounds.length - 1; b++) {
				const from = bounds[b];
				const to = b + 2 < bounds.length ? bounds[b + 1] - 1 : toks.length;
				const parsed = readTarget(toks, from);
				if (!parsed) continue;
				checkAssignment(parsed.target, inferType(toks, parsed.eq + 1, to, env, dicts));
			}
			continue;
		}

		// A plain assignment is the only remaining statement we care about.
		const parsed = readTarget(toks, 0);
		if (parsed) {
			checkAssignment(parsed.target, inferType(toks, parsed.eq + 1, toks.length, env, dicts));
		}

		checkRealComparisons(toks, env, dicts, report);

		// Whether or not it was an assignment, the statement may have handed
		// variables to a call that writes back into them.
		invalidateOutputs(toks, env);
	}

	return diagnostics;
}

/** Exposed for tests. */
export const _internals = { inferType, topLevelCommas };
export type { Statement };
