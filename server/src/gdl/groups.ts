/**
 * Groups — GDL's named collections of 3D bodies.
 *
 * A group is defined by wrapping bodies in `GROUP "name" … ENDGROUP`. Nothing
 * is generated at that point; the group is placed later with `PLACEGROUP`, or
 * fed to a solid operation (`ADDGROUP`, `SUBGROUP`, `ISECTGROUP`, …) whose
 * *result* is itself a group. That result is a value of its own kind: it can be
 * kept in a variable, passed to another operation and placed, and used for
 * nothing else.
 *
 *     GROUP "box"
 *         BRICK 1, 1, 1
 *     ENDGROUP
 *     result = SUBGROUP ("box", "sphere")
 *     PLACEGROUP result
 *
 * So a group is addressed two ways — by a name, which is a *string*, and
 * through a variable holding an operation's result — and this module finds both
 * spellings, so go-to-definition can follow either back to where it came from.
 *
 * What counts as a group position is tracked rather than guessed, because the
 * same statement mixes group expressions with ordinary numbers:
 * `PLACEGROUP SWEEPGROUP{2} ("the_sphere", 2, 0, 0)` names one group and three
 * distances. Only the arguments the guide calls `g_expr` are group expressions.
 *
 * Scope is one script. The guide is explicit that group names "must be unique
 * inside the current script", and a group is cleared when interpretation ends,
 * so nothing here reaches into sibling scripts the way variables do.
 *
 * Two things are deliberately left unresolved, neither being knowable without
 * running the script:
 *
 *   - **Computed names.** `GROUP "wall" + STR (i, 1, 0)` builds its name at run
 *     time, so only a lone string literal is read as a name.
 *   - **A variable standing in for a name.** `fixingGroup = "fixing" + …`
 *     followed by `GROUP fixingGroup` is real, idiomatic code. The group's name
 *     is unknowable, but the *variable* is not — so the variable is what gets
 *     matched up, `GROUP fixingGroup` counting as its definition site.
 *
 * There is a third spelling between those two, and it is the one rename cannot
 * afford to miss: a variable that is used as a group *and* is handed a plain
 * string literal somewhere.
 *
 *     if _is_overriden then
 *         gr_toplace = group_overriden
 *     else
 *         gr_toplace = "Object_stretched"      <- names the group
 *     endif
 *     placegroup gr_toplace
 *
 * That literal is a group name as surely as the one in `KILLGROUP`, and the
 * statement holding it mentions no group keyword at all. So a second pass picks
 * up `<var> = "literal"` for any variable the script elsewhere places, kills or
 * combines. Only a lone literal counts — `gr = "wall" + STR (i)` is computed,
 * like every other built-up name here.
 */

import type { GdlDocument, Statement } from './analyzer';
import type { Token } from './lexer';

/** How a group is addressed at one place in the source. */
export type GroupNameKind = 'literal' | 'variable';

export interface GroupName {
	readonly kind: GroupNameKind;
	/** Lower-cased key: the literal's contents, or the variable's name. */
	readonly key: string;
	/** The token spelling it — quotes included, for a literal. */
	readonly token: Token;
}

/** Commands whose whole argument is a group expression. */
const GROUP_COMMANDS = new Set(['placegroup', 'killgroup']);

/** The statement that defines one: `GROUP "name" … ENDGROUP`. */
const GROUP_DEFINITION = 'group';

/**
 * Group-returning functions, and which of their arguments are group
 * expressions. Anything past those is an edge colour, a material or a
 * direction vector, and must not be mistaken for a group name.
 */
const GROUP_FUNCTIONS = new Map<string, readonly number[]>([
	['addgroup', [0, 1]],
	['subgroup', [0, 1]],
	['isectgroup', [0, 1]],
	['isectlines', [0, 1]],
	['sweepgroup', [0]],
	['creategroupwithmaterial', [0]],
]);

/** Words after which a new command begins inside the same statement. */
const CLAUSE_STARTERS = new Set(['then', 'else']);

/** Variant suffix, as in `SWEEPGROUP{2}`. */
const VARIANT_RE = /\{\d+\}$/;

/** Operators that fold the neighbouring token into a larger expression. */
const ARITHMETIC = new Set(['+', '-', '*', '/', '^', '**']);

/** One argument list: which positions in it hold group expressions. */
interface Frame {
	readonly spec: readonly number[] | 'all' | 'none';
	argIndex: number;
}

function isOperator(tok: Token | undefined, text: string): boolean {
	return tok?.type === 'operator' && tok.text === text;
}

/**
 * True when the token stands alone as a value. A name built up with `+` is
 * computed, so neither half of it is a group we could look up.
 */
function isWholeOperand(toks: readonly Token[], i: number): boolean {
	const prev = toks[i - 1];
	const next = toks[i + 1];
	if (prev?.type === 'operator' && ARITHMETIC.has(prev.text)) return false;
	if (next?.type === 'operator' && (ARITHMETIC.has(next.text) || next.text === '(')) return false;
	return true;
}

/**
 * Walks one statement and reports every group name in it, saying for each
 * whether it is the name being *defined* by a `GROUP` statement.
 */
function forEachGroupName(
	stmt: Statement,
	visit: (name: GroupName, isDefinition: boolean, index: number) => void,
): void {
	const toks = stmt.tokens;
	let stack: Frame[] = [];
	/** Argument spec for the `(` that a group function is about to open. */
	let pending: readonly number[] | undefined;
	let defining = false;
	/** Index of the last command word, which is syntax rather than a value. */
	let keywordAt = -1;

	const inGroupPosition = (): boolean => {
		const top = stack[stack.length - 1];
		if (!top) return false;
		if (top.spec === 'all') return true;
		if (top.spec === 'none') return false;
		return top.spec.includes(top.argIndex);
	};

	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i];

		if (tok.type === 'operator') {
			if (tok.text === '(') {
				// A paren opened by a group function takes that function's
				// argument spec. One following any other name is a call to
				// something else — `STR (i, 1, 0)` — and holds no group. A bare
				// paren merely brackets, so `PLACEGROUP ("box")` still names one.
				const callee = toks[i - 1];
				const isOtherCall = callee?.type === 'identifier' && i - 1 !== keywordAt;
				const spec = pending
					? pending
					: isOtherCall
						? 'none'
						: inGroupPosition()
							? 'all'
							: 'none';
				stack.push({ spec, argIndex: 0 });
				pending = undefined;
				continue;
			}
			// A subscript holds an index, never a group: the array in
			// `PLACEGROUP gr_out[meq1_front[i]]` is the group expression, and
			// everything inside the brackets is arithmetic.
			if (tok.text === '[') {
				stack.push({ spec: 'none', argIndex: 0 });
				pending = undefined;
				continue;
			}
			if (tok.text === ')' || tok.text === ']') {
				stack.pop();
				continue;
			}
			if (tok.text === ',') {
				const top = stack[stack.length - 1];
				if (top) top.argIndex++;
			}
			continue;
		}

		if (tok.type === 'identifier') {
			const base = tok.lower.replace(VARIANT_RE, '');

			// `IF a THEN PLACEGROUP "x" ELSE PLACEGROUP "y"` is one statement
			// holding two commands, so the argument context restarts here.
			if (CLAUSE_STARTERS.has(base)) {
				stack = [];
				pending = undefined;
				defining = false;
				keywordAt = i;
				continue;
			}

			const fn = GROUP_FUNCTIONS.get(base);
			if (fn && isOperator(toks[i + 1], '(')) {
				pending = fn;
				keywordAt = i;
				continue;
			}

			if (GROUP_COMMANDS.has(base) || base === GROUP_DEFINITION) {
				stack = [{ spec: 'all', argIndex: 0 }];
				pending = undefined;
				defining = base === GROUP_DEFINITION;
				keywordAt = i;
				continue;
			}
		}

		if (!inGroupPosition() || !isWholeOperand(toks, i)) continue;

		if (tok.type === 'string' && !tok.unterminated) {
			visit({ kind: 'literal', key: tok.text.slice(1, -1).toLowerCase(), token: tok }, defining, i);
			defining = false;
		} else if (tok.type === 'identifier') {
			visit({ kind: 'variable', key: tok.lower, token: tok }, defining, i);
			defining = false;
		}
	}
}

/**
 * `<variable> = "literal"`, where the variable is one the script uses as a
 * group. The target may be a whole path — `gr_out[TYPE_MEDIA_O2]` and
 * `_drods.f[1].gr` are both real, groups being routinely tabulated into an
 * array and picked out by an index.
 *
 * The assignment must be the whole of its clause: `gr = "a" + b` builds a name
 * we cannot read, and `n = "gr_leg"` for a variable that is never placed is an
 * ordinary string.
 */
function forEachIndirectName(
	stmt: Statement,
	groupVariables: ReadonlySet<string>,
	visit: (name: GroupName) => void,
): void {
	const toks = stmt.tokens;
	for (let i = 0; i < toks.length; i++) {
		const head = toks[i];
		if (head.type !== 'identifier' || !groupVariables.has(head.lower)) continue;

		// The assignment has to open its clause, or the `=` is a comparison:
		// `IF gr_toplace = "x" THEN …` asks a question, it does not name a group.
		const before = toks[i - 1];
		if (before && !(before.type === 'identifier' && CLAUSE_STARTERS.has(before.lower))) continue;

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
		if (after && !(after.type === 'identifier' && CLAUSE_STARTERS.has(after.lower))) continue;

		// `_gname[1] = ""` clears the slot rather than naming anything.
		const key = value.text.slice(1, -1).toLowerCase();
		if (!key) continue;

		visit({ kind: 'literal', key, token: value });
	}
}

/**
 * Walks the whole script, reporting every group name in it — the indirect ones
 * included, which is why this cannot be done a statement at a time: whether
 * `gr_toplace = "x"` names a group depends on a `PLACEGROUP` further down.
 */
function forEachGroupNameInDocument(
	doc: GdlDocument,
	visit: (name: GroupName, isDefinition: boolean) => void,
): void {
	const groupVariables = new Set<string>();
	for (const stmt of doc.statements) {
		forEachGroupName(stmt, (name, _isDefinition, index) => {
			if (name.kind !== 'variable') return;
			// `PLACEGROUP _drods.f[1].gr` reaches through a path, and only its
			// head is the variable — the `gr` after the `]` is a member name,
			// which on its own would match far too much.
			if (isOperator(stmt.tokens[index - 1], '.')) return;
			groupVariables.add(name.key);
		});
	}

	for (const stmt of doc.statements) {
		const direct = new Set<number>();
		forEachGroupName(stmt, (name, isDefinition) => {
			direct.add(name.token.start);
			visit(name, isDefinition);
		});
		if (groupVariables.size) {
			forEachIndirectName(stmt, groupVariables, (name) => {
				if (!direct.has(name.token.start)) visit(name, false);
			});
		}
	}
}

/** Every group defined in this script, in source order. */
export function groupDefinitions(doc: GdlDocument): GroupName[] {
	const definitions: GroupName[] = [];
	for (const stmt of doc.statements) {
		forEachGroupName(stmt, (name, isDefinition) => {
			if (isDefinition) definitions.push(name);
		});
	}
	return definitions;
}

/**
 * Every group name in this script, in source order — the definitions and the
 * references alike. Rename wants the lot, and wants them only where GDL reads
 * them as a group, so a `TEXT2 0, 0, "gr_leg"` elsewhere in the script is left
 * alone however exactly it matches.
 */
export function groupNames(doc: GdlDocument): GroupName[] {
	const names: GroupName[] = [];
	forEachGroupNameInDocument(doc, (name) => names.push(name));
	return names;
}

/**
 * The group name under `offset`, if the cursor is on one. A name is only
 * reported where GDL reads it as a group — `TEXT2 0, 0, "box"` mentions no
 * group, however many groups happen to be called `box`.
 */
export function groupNameAt(doc: GdlDocument, offset: number): GroupName | undefined {
	let found: GroupName | undefined;
	forEachGroupNameInDocument(doc, (name) => {
		if (offset >= name.token.start && offset <= name.token.end) found = name;
	});
	return found;
}
