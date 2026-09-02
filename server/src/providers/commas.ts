/**
 * Comma mistakes in GDL argument lists.
 *
 * GDL statements take long, positional, comma-separated argument lists that
 * routinely run across a dozen lines. Three comma slips are easy to make and
 * unpleasant to debug, because none of them is a syntax error:
 *
 *   **A missing comma** merges two arguments. `PUT 0.815  0.1650, 1` quietly
 *   passes fewer values than intended, and the shape comes out wrong far from
 *   where the typo is.
 *
 *   **A missing comma at a line break** does something worse. The trailing comma
 *   is what holds a wrapped list together, so dropping one *ends* the statement
 *   and leaves the rest of the list standing on its own:
 *
 *       PUT _prf[ii],
 *           _prf[ii + 1]
 *           _srf
 *
 *   `PUT` gets two of its three values, and `_srf` becomes a statement that
 *   names something and does nothing with it.
 *
 *   **A stray trailing comma** swallows the next line. Because a trailing comma
 *   continues a statement, this:
 *
 *       PUT 1, 2, 3,
 *       MATERIAL wood
 *
 *   is one statement, and the `MATERIAL` command never runs as a command.
 *
 * All three checks are deliberately narrow. A GDL command list can hold almost
 * anything, so we only speak up where the reading is unambiguous.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument, Statement } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';
import { KEYWORDS, lookup, lookupWithVariants } from '../gdl/keywords';

export const SOURCE = 'gdl';

/**
 * Words that may sit next to a value without a comma, because they are part of
 * the statement's own syntax rather than an argument.
 *
 * Anything the keyword table calls a statement or an operator qualifies — `TO`,
 * `STEP`, `THEN`, `RANGE`, `PARAMETERS`, `MATERIAL`, `AND`… Globals and fixed
 * parameters do not: those are ordinary values — and neither do the keywords
 * that *yield* one. `NSP`, `GET (n)`, `USE (n)`, `REQUEST (…)`, `PI` are read
 * inside an expression, never run as a command, and the keyword table types
 * them `function` for exactly that reason (see `scripts/gen-keywords.mjs`).
 * While the list's sections typed them `statement`, every check in this file
 * took `get(nsp)` for a command and the stranded-row shape below went unseen.
 */
function isSyntaxWord(tok: Token): boolean {
	if (tok.type !== 'identifier') return false;
	const kw = lookup(tok.text);
	return kw !== undefined && (kw.kind === 'statement' || kw.kind === 'operator');
}

/** True when the token is a plain value rather than part of the syntax. */
function isValue(tok: Token): boolean {
	if (tok.type === 'number' || tok.type === 'string') return true;
	return tok.type === 'identifier' && !isSyntaxWord(tok);
}

/**
 * Statements whose first argument is followed by a value list with no comma
 * between them:
 *
 *     VALUES "gs_leaf_thk" 0.01, 0.03, 0.035, CUSTOM
 *                        ^ no comma here, by design
 */
const NO_COMMA_AFTER_FIRST = new Set([
	'values',
	'values{2}',
	'parvalue_description',
	// `PARAGRAPH "name" alignment, …` and `TEXTBLOCK "name" width, …` name the
	// thing being defined before the list, with no comma either.
	'paragraph',
	'textblock',
	'textblock_',
]);

/**
 * Keywords that legitimately open a continuation line inside an argument list,
 * so finding one after a line-breaking comma proves nothing.
 *
 * These are sub-clauses of the statement they follow (`DEFINE MATERIAL …
 * ADDITIONAL_DATA`, `VALUES … CUSTOM`, `CALL … PARAMETERS`). Every one of these
 * was a false positive on the corpus. `USE`, `NSP` and `GET` used to be listed
 * here as well, for the same reason — a row of a wrapped list may well be
 * `get(nsp)` — but they are values, and now that the keyword table says so
 * `isSyntaxWord` never brings them this far.
 */
const CLAUSE_CONTINUATIONS = new Set([
	'put',
	'parameters',
	'returned_parameters',
	'all',
	'default',
	'custom',
	'range',
	'additional_data',
	'based_on',
	'fillTypes_mask'.toLowerCase(),
	'profiletypes_mask',
	'mask',
]);

/** True when only whitespace precedes `tok` on its physical line. */
function atLineStart(text: string, tok: Token): boolean {
	let i = tok.start - 1;
	while (i >= 0) {
		const c = text[i];
		if (c === '\n' || c === '\r') return true;
		if (c !== ' ' && c !== '\t') return false;
		i--;
	}
	return true;
}

/**
 * Two values side by side with nothing between them.
 *
 * The first argument is skipped: `MATERIAL wood` and `RESOL 48` are a command
 * followed by its first value, which is exactly this shape and perfectly legal.
 */
/** Tokens after which a new command begins inside the same statement. */
const CLAUSE_STARTERS = new Set(['then', 'else']);

function checkMissingCommas(stmt: Statement, td: TextDocument): Diagnostic[] {
	const toks = stmt.tokens;
	const diagnostics: Diagnostic[] = [];

	// One statement can hold several commands: `IF n > 0 THEN VALUES "s" a ELSE
	// VALUES "s" b`. Each needs its own "skip the command and its first
	// argument" accounting, so walk clause by clause.
	let cursor = 0;
	while (cursor < toks.length) {
		const command = toks[cursor];
		const lower = command.type === 'identifier' ? command.lower : '';

		// Some commands name the thing they define and then run straight into
		// its argument list with no comma between:
		//     VALUES "gs_leaf_thk" 0.01, 0.03, CUSTOM
		//     DEFINE MATERIAL "Cover white" 4, 0.95, 0.95
		//     TEXTBLOCK "tb" + styleName  width, anchor, …
		//
		// The name may be a computed expression, so its end cannot be counted in
		// tokens. Instead we allow exactly one adjacent-value boundary in these
		// statements — the one between the name and the list — and report any
		// further ones normally.
		const isDefine = lower === 'define';
		let allowBoundary = isDefine || NO_COMMA_AFTER_FIRST.has(lower);

		let i = cursor + (isDefine ? 2 : 1);
		let next = toks.length;

		for (let j = cursor + 1; j < toks.length; j++) {
			const t = toks[j];
			if (t.type === 'identifier' && CLAUSE_STARTERS.has(t.lower)) {
				next = j + 1;
				break;
			}
		}

		for (; i < Math.min(next, toks.length) - 1; i++) {
			const left = toks[i];
			const right = toks[i + 1];
			if (!isValue(left) || !isValue(right)) continue;

			// `name = value` inside a macro call is a named argument, not a list.
			if (toks[i + 2]?.type === 'operator' && toks[i + 2].text === '=') continue;

			if (allowBoundary) {
				allowBoundary = false;
				continue;
			}

			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range: { start: td.positionAt(left.end), end: td.positionAt(right.end) },
				message: `Missing comma between \`${left.text}\` and \`${right.text}\`.`,
				source: SOURCE,
			});
		}

		cursor = next;
	}
	return diagnostics;
}

/**
 * True when the token at `i` heads a `name = value` named argument — the shape
 * a macro call lists one per line:
 *
 *     CALL "BasicGeometry" PARAMETERS iFunction = 1,
 *         polygon = poly
 *
 * The name may be a whole path (`_opt.pen = 3`, `arr[1] = 2`), so the subscripts
 * and members are stepped over before the `=` is looked for. Nothing may be
 * assigned to a keyword, so an `=` here proves the word is an argument name
 * rather than the command it looks like.
 */
function isNamedArgument(toks: readonly Token[], i: number): boolean {
	let j = i + 1;
	while (j < toks.length && toks[j].type === 'operator') {
		if (toks[j].text === '.') {
			if (toks[j + 1]?.type !== 'identifier') return false;
			j += 2;
			continue;
		}
		if (toks[j].text !== '[') break;
		let depth = 0;
		while (j < toks.length) {
			const t = toks[j];
			if (t.type === 'operator' && (t.text === '[' || t.text === '(')) depth++;
			else if (t.type === 'operator' && (t.text === ']' || t.text === ')')) {
				depth--;
				if (depth === 0) { j++; break; }
			}
			j++;
		}
		if (depth !== 0) return false;
	}
	return toks[j]?.type === 'operator' && toks[j].text === '=';
}

/**
 * A statement that continued across a line break onto what looks like a new
 * command — the signature of a comma that should not be there.
 */
function checkTrailingCommas(stmt: Statement, text: string, td: TextDocument): Diagnostic[] {
	const toks = stmt.tokens;
	const diagnostics: Diagnostic[] = [];
	for (let i = 1; i < toks.length; i++) {
		const tok = toks[i];
		const prev = toks[i - 1];
		if (!(prev.type === 'operator' && prev.text === ',')) continue;
		if (!isSyntaxWord(tok) || !atLineStart(text, tok)) continue;
		if (CLAUSE_CONTINUATIONS.has(tok.lower)) continue;
		// `name = value` is a named argument that merely shares a keyword's name.
		if (isNamedArgument(toks, i)) continue;

		diagnostics.push({
			severity: DiagnosticSeverity.Warning,
			range: { start: td.positionAt(prev.start), end: td.positionAt(prev.end) },
			message:
				`Trailing comma — \`${tok.text}\` on the next line reads as another argument ` +
				`rather than a new statement.`,
			source: SOURCE,
		});
	}
	return diagnostics;
}

/**
 * Operator characters that can stand inside an ordinary value expression.
 *
 * `=` and `:` are the two that matter by their absence: they mark an assignment
 * and a jump label, which is how a statement that merely *begins* with a value
 * is told apart from one that is nothing but a value.
 */
const EXPRESSION_OPERATORS = new Set([
	'+', '-', '*', '/', '^', '**',
	'(', ')', '[', ']', ',', '.',
	'<', '>', '<=', '>=', '<>', '#', '&', '|', '@',
]);

/**
 * First words of the statements the keyword table indexes whole, because they
 * are spelled with a space: `DEFINE STYLE{2}`, `DEL TOP`, `REF COMPONENT`. Left
 * to `lookup`, `DEFINE` is not a keyword at all — which is why `PUT` sees a
 * `DEFINE MATERIAL` line as a list of values.
 *
 * The list also carries a few entries sectioned as statements that are really
 * function calls (`IND(MATERIAL, "…")`), so only real identifiers are taken.
 */
const COMMAND_FIRST_WORDS = new Set(
	KEYWORDS.filter((kw) => kw.kind === 'statement' && kw.name.includes(' '))
		.map((kw) => kw.name.slice(0, kw.name.indexOf(' ')).toLowerCase())
		.filter((word) => /^[a-z_][a-z0-9_]*$/.test(word)),
);

/**
 * True when the token names a command.
 *
 * Stricter than `isSyntaxWord` about where it looks: variant spellings are
 * indexed under their full name, so `STYLE{2}` has to fall back to `STYLE`.
 */
function isCommandWord(tok: Token): boolean {
	if (tok.type !== 'identifier') return false;
	if (COMMAND_FIRST_WORDS.has(tok.lower)) return true;
	return lookupWithVariants(tok.text)?.kind === 'statement';
}

/**
 * A statement consisting of nothing but a value expression.
 *
 * A value may be spelt with a keyword — `get(nsp)`, `use(3)`, `request(…)`,
 * `pi` — which is why this asks `isCommandWord` rather than "is it a keyword":
 * the table types those `function`, and a function is as much a value as a
 * number is. Reported by the project owner on the row that made the
 * distinction matter:
 *
 *     poly2_b nsp/3, mask          <- comma missing
 *         gs_cont_pen, gs_cont_pen,
 *         get(nsp)
 */
function isBareExpression(stmt: Statement): boolean {
	if (stmt.tokens.length === 0) return false;
	for (const tok of stmt.tokens) {
		if (tok.type === 'operator') {
			if (!EXPRESSION_OPERATORS.has(tok.text)) return false;
			continue;
		}
		if (!isValue(tok) || isCommandWord(tok)) return false;
	}
	return true;
}

/**
 * True when a statement could have carried on onto the next line — a command
 * with a comma-separated argument list, or the stranded remains of one.
 *
 * The comma is what the message is about, so one has to be there: `MATERIAL
 * gs_mat` takes a single argument and could never continue, and telling someone
 * to put a comma after it would be wrong.
 */
function looksUnfinished(stmt: Statement): boolean {
	const toks = stmt.tokens;
	if (toks.length < 2) return false;

	const last = toks[toks.length - 1];
	const endsOnValue =
		isValue(last) || (last.type === 'operator' && (last.text === ']' || last.text === ')'));
	if (!endsOnValue) return false;

	if (!toks.some((t) => t.type === 'operator' && t.text === ',')) return false;

	// Either a command taking arguments, or a stranded line of them — so that a
	// list with two missing commas reports both.
	if (isCommandWord(toks[0])) return true;
	return isBareExpression(stmt);
}

/**
 * A line of arguments left stranded by a missing comma.
 *
 * A trailing comma is what joins an argument list across lines, so forgetting
 * one does not merge two values the way `checkMissingCommas` assumes — it *ends*
 * the statement, and the rest of the list is left standing on its own:
 *
 *     PUT _prf[ii],
 *         _prf[ii + 1]        <- comma missing here
 *         _srf                <- so this is a statement in its own right
 *
 * `_srf` is then a statement that consists of nothing but a value, which GDL has
 * no use for: it names something and does nothing with it. That is the tell, and
 * it can only be read by looking at the statement *before* it, which is why this
 * runs over pairs rather than inside one statement.
 *
 * Deliberately narrow: the two statements must be on consecutive lines (a blank
 * or commented-out line in between is a much weaker signal), and the first must
 * hold a comma already.
 */
function checkStrandedArguments(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	// A PARAGRAPH body is written as bare expressions — one per line, no commas
	// — so every line of one has exactly the shape this check reports.
	let inParagraph = false;
	for (let i = 1; i < doc.statements.length; i++) {
		const stmt = doc.statements[i];
		const prev = doc.statements[i - 1];
		if (prev.head === 'paragraph') inParagraph = true;
		else if (prev.head === 'endparagraph') inParagraph = false;
		if (inParagraph) continue;
		if (!isBareExpression(stmt) || !looksUnfinished(prev)) continue;
		if (td.positionAt(prev.end).line + 1 !== td.positionAt(stmt.start).line) continue;

		const first = stmt.tokens[0];
		diagnostics.push({
			severity: DiagnosticSeverity.Warning,
			range: { start: td.positionAt(prev.end), end: td.positionAt(first.end) },
			message:
				`Missing comma — \`${first.text}\` on the next line reads as a statement of its ` +
				`own rather than the next argument.`,
			source: SOURCE,
		});
	}
	return diagnostics;
}

export function provideCommaDiagnostics(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const stmt of doc.statements) {
		diagnostics.push(...checkMissingCommas(stmt, td));
		diagnostics.push(...checkTrailingCommas(stmt, doc.text, td));
	}
	diagnostics.push(...checkStrandedArguments(doc, td));
	return diagnostics;
}
