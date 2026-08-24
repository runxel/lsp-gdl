/**
 * Builds a lightweight model of one GDL script: its statements, the variables
 * it defines, its jump labels and the macros it calls.
 *
 * This is deliberately not a full parser. GDL has no formal grammar published
 * and ~400 statement forms; a hand-written recursive-descent parser for all of
 * them is a large project. What downstream features actually need is far less:
 * where each statement begins, what the leading keyword is, and which names are
 * defined versus merely referenced. That is what this produces, and it degrades
 * gracefully on code it does not understand.
 */

import { tokenize, type Token } from './lexer';
import { scriptKindFromUri, type ScriptKind } from './scriptKind';

export interface Statement {
	/** Tokens of this statement, comments excluded, continuations joined. */
	readonly tokens: readonly Token[];
	/** Leading identifier, lower-cased — usually the command name. */
	readonly head: string | undefined;
	readonly start: number;
	readonly end: number;
}

export interface VariableInfo {
	readonly name: string;
	/** Offset of the first assignment. */
	readonly definedAt: number;
	/** Offsets of every occurrence, definitions included. */
	readonly references: number[];
	/** Assigned via `PARAMETERS name = ...`, so it writes back to the libpart. */
	readonly isParameterWrite: boolean;
	/** Subscripted somewhere, i.e. used as an array. */
	readonly isArray: boolean;
}

export interface LabelInfo {
	readonly name: string;
	readonly definedAt: number;
}

export interface MacroCall {
	readonly name: string;
	readonly at: number;
}

export interface GdlDocument {
	readonly uri: string;
	readonly script: ScriptKind | undefined;
	readonly text: string;
	readonly tokens: readonly Token[];
	readonly statements: readonly Statement[];
	readonly variables: ReadonlyMap<string, VariableInfo>;
	readonly labels: ReadonlyMap<string, LabelInfo>;
	readonly macroCalls: readonly MacroCall[];
	/** Unterminated string literals, for diagnostics. */
	readonly badStrings: readonly Token[];
}

/**
 * Splits the token stream into statements.
 *
 * Two things join lines: a trailing `\` (already consumed by the lexer) and a
 * trailing `,`, which is how long coordinate and parameter lists are written.
 * A `:` also separates statements written on one line.
 */
function splitStatements(tokens: readonly Token[]): Statement[] {
	const statements: Statement[] = [];
	let current: Token[] = [];

	const flush = () => {
		if (current.length === 0) return;
		const head = current[0].type === 'identifier' ? current[0].lower : undefined;
		statements.push({
			tokens: current,
			head,
			start: current[0].start,
			end: current[current.length - 1].end,
		});
		current = [];
	};

	for (const tok of tokens) {
		if (tok.type === 'comment') continue;
		if (tok.type === 'eof') break;

		if (tok.type === 'newline') {
			// A trailing comma means the statement continues on the next line.
			const last = current[current.length - 1];
			if (last && last.type === 'operator' && last.text === ',') continue;
			flush();
			continue;
		}

		// A colon separates statements written on one line:
		//     FOR i = 1 TO n : CUTEND : NEXT i
		//
		// It does NOT separate when it terminates a jump label. Labels are
		// always a lone number or string — `100:` or `"tapPage":` — never an
		// identifier, so a single-token identifier statement such as `CUTEND`
		// must still be flushed.
		if (tok.type === 'operator' && tok.text === ':') {
			const isLabel =
				current.length === 1 && (current[0].type === 'number' || current[0].type === 'string');
			if (!isLabel) {
				flush();
				continue;
			}
			// A label ends its own statement, so that code written after it on
			// the same line — `500: LINE2 0, -w, 0` — is a statement in its own
			// right and the label still reads as a lone `name :` pair.
			current.push(tok);
			flush();
			continue;
		}

		current.push(tok);
	}
	flush();
	return statements;
}

/** Statements after which the first identifier is a definition, not a use. */
const DEFINING_HEADS = new Set(['parameters', 'values', 'values{2}', 'dim', 'lock', 'hideparameter']);

function analyzeStatements(statements: readonly Statement[]) {
	const variables = new Map<string, VariableInfo>();
	const labels = new Map<string, LabelInfo>();
	const macroCalls: MacroCall[] = [];

	const noteReference = (tok: Token) => {
		const info = variables.get(tok.lower);
		if (info) info.references.push(tok.start);
	};

	// Note: `define` records the declaration only. The occurrence itself is
	// counted by the general reference sweep below, so adding one here too
	// would double-count every assignment target.
	const define = (tok: Token, isParameterWrite: boolean) => {
		const existing = variables.get(tok.lower);
		if (existing) return existing;
		const info: VariableInfo = {
			name: tok.text,
			definedAt: tok.start,
			references: [],
			isParameterWrite,
			isArray: false,
		};
		variables.set(tok.lower, info);
		return info;
	};

	for (const stmt of statements) {
		const toks = stmt.tokens;
		if (toks.length === 0) continue;

		const first = toks[0];

		// Jump label. Two spellings, both targets of GOSUB/GOTO:
		//     100:
		//     "tapPage":
		const isLabel =
			(first.type === 'number' || first.type === 'string') &&
			toks.length === 2 &&
			toks[1].type === 'operator' &&
			toks[1].text === ':';
		if (isLabel) {
			const name = first.type === 'string' ? first.text.slice(1, -1) : first.text;
			const key = name.toLowerCase();
			if (!labels.has(key)) labels.set(key, { name, definedAt: first.start });
			continue;
		}

		// Assignment: `name = expr`, or `name[i] = expr`.
		if (first.type === 'identifier') {
			const eq = toks.findIndex((t) => t.type === 'operator' && t.text === '=');
			const openBracket = toks[1]?.type === 'operator' && toks[1].text === '[';
			if (eq > 0) {
				const lhsIsSimple = eq === 1;
				const lhsIsIndexed = openBracket;
				if (lhsIsSimple || lhsIsIndexed) {
					const info = define(first, false);
					if (lhsIsIndexed && !info.isArray) {
						variables.set(first.lower, { ...info, isArray: true });
					}
				}
			}

			// `PARAMETERS name = value, name2 = value2`
			if (stmt.head === 'parameters') {
				for (let i = 1; i < toks.length; i++) {
					const t = toks[i];
					const next = toks[i + 1];
					const prev = toks[i - 1];
					const atBoundary = i === 1 || (prev.type === 'operator' && prev.text === ',');
					if (t.type === 'identifier' && atBoundary && next?.type === 'operator' && next.text === '=') {
						const existing = variables.get(t.lower);
						variables.set(t.lower, {
							name: t.text,
							definedAt: existing?.definedAt ?? t.start,
							references: existing ? [...existing.references, t.start] : [t.start],
							isParameterWrite: true,
							isArray: existing?.isArray ?? false,
						});
					}
				}
			}

			// `CALL "macro name"` — the macro dependency of this libpart.
			if (stmt.head === 'call') {
				const target = toks[1];
				if (target?.type === 'string') {
					macroCalls.push({ name: target.text.slice(1, -1), at: target.start });
				}
			}

			// `FOR i = 1 TO n` defines the loop variable.
			if (stmt.head === 'for' && toks[1]?.type === 'identifier') {
				define(toks[1], false);
			}

			if (!DEFINING_HEADS.has(stmt.head ?? '')) {
				for (const t of toks) if (t.type === 'identifier') noteReference(t);
			}
		}
	}

	return { variables, labels, macroCalls };
}

export function analyze(uri: string, text: string): GdlDocument {
	const tokens = tokenize(text);
	const statements = splitStatements(tokens);
	const { variables, labels, macroCalls } = analyzeStatements(statements);
	const badStrings = tokens.filter((t) => t.type === 'string' && t.unterminated);

	return {
		uri,
		script: scriptKindFromUri(uri),
		text,
		tokens,
		statements,
		variables,
		labels,
		macroCalls,
		badStrings,
	};
}

/** The token containing `offset`, if any. Used to resolve hover positions. */
export function tokenAt(doc: GdlDocument, offset: number): Token | undefined {
	for (const tok of doc.tokens) {
		if (tok.start <= offset && offset <= tok.end && tok.type !== 'newline') return tok;
		if (tok.start > offset) break;
	}
	return undefined;
}
