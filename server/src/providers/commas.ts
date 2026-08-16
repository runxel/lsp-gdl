/**
 * Comma mistakes in GDL argument lists.
 *
 * GDL statements take long, positional, comma-separated argument lists that
 * routinely run across a dozen lines. Two comma slips are easy to make and
 * unpleasant to debug, because neither is a syntax error:
 *
 *   **A missing comma** merges two arguments. `PUT 0.815  0.1650, 1` quietly
 *   passes fewer values than intended, and the shape comes out wrong far from
 *   where the typo is.
 *
 *   **A stray trailing comma** swallows the next line. Because a trailing comma
 *   continues a statement, this:
 *
 *       PUT 1, 2, 3,
 *       MATERIAL wood
 *
 *   is one statement, and the `MATERIAL` command never runs as a command.
 *
 * Both checks are deliberately narrow. A GDL command list can hold almost
 * anything, so we only speak up where the reading is unambiguous.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument, Statement } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';
import { lookup } from '../gdl/keywords';

export const SOURCE = 'gdl';

/**
 * Words that may sit next to a value without a comma, because they are part of
 * the statement's own syntax rather than an argument.
 *
 * Anything the keyword table calls a statement or an operator qualifies — `TO`,
 * `STEP`, `THEN`, `RANGE`, `PARAMETERS`, `MATERIAL`, `AND`… Globals and fixed
 * parameters do not: those are ordinary values.
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
 * `USE` and `NSP` are parameter-buffer operations used as values; the rest are
 * sub-clauses of the statement they follow (`DEFINE MATERIAL … ADDITIONAL_DATA`,
 * `VALUES … CUSTOM`, `CALL … PARAMETERS`). Every one of these was a false
 * positive on the corpus.
 */
const CLAUSE_CONTINUATIONS = new Set([
	'use',
	'nsp',
	'get',
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
 * A statement that continued across a line break onto what looks like a new
 * command — the signature of a comma that should not be there.
 */
function checkTrailingCommas(stmt: Statement, text: string, td: TextDocument): Diagnostic[] {
	const toks = stmt.tokens;
	// Macro calls legitimately list `name = value` pairs one per line.
	if (stmt.head === 'call') return [];

	const diagnostics: Diagnostic[] = [];
	for (let i = 1; i < toks.length; i++) {
		const tok = toks[i];
		const prev = toks[i - 1];
		if (!(prev.type === 'operator' && prev.text === ',')) continue;
		if (!isSyntaxWord(tok) || !atLineStart(text, tok)) continue;
		if (CLAUSE_CONTINUATIONS.has(tok.lower)) continue;
		// `name = value` is a named argument that merely shares a keyword's name.
		if (toks[i + 1]?.type === 'operator' && toks[i + 1].text === '=') continue;

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

export function provideCommaDiagnostics(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	for (const stmt of doc.statements) {
		diagnostics.push(...checkMissingCommas(stmt, td));
		diagnostics.push(...checkTrailingCommas(stmt, doc.text, td));
	}
	return diagnostics;
}
