/**
 * Diagnostics for GDL.
 *
 * Six checks ship in v0, chosen because each catches a mistake that is both
 * common and invisible until Archicad refuses to open the object:
 *
 *   1. Unbalanced block structure (IF/ENDIF, FOR/NEXT, GROUP/ENDGROUP, ...).
 *      GDL reports these as a single unhelpful error at the end of the script.
 *   2. A command used in a script where it is not valid, e.g. `CUTPLANE` in
 *      the parameter script.
 *   3. Unterminated string literals.
 *   4. An operator left without an operand — `1 + + 2`.
 *   5. Brackets left unbalanced — `atn(a / b[1]))`.
 *   6. A `GOSUB`/`GOTO` naming a label that does not exist, which stops the
 *      object whether or not the jump is ever reached.
 *
 * Deliberately NOT checked yet: undefined variables. GDL lets Archicad inject
 * names from several directions (fixed parameters, macro `PARAMETERS ALL`,
 * inherited ancestry), so a naive check produces mostly false positives. See
 * CLAUDE.md for what would have to be in place first.
 */

import { Diagnostic, DiagnosticSeverity, DiagnosticTag } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument, Statement } from '../gdl/analyzer';
import { quoteName } from '../gdl/lexer';
import { lookupWithVariants } from '../gdl/keywords';
import { isPermissive, SCRIPT_LABELS } from '../gdl/scriptKind';
import { provideTypeDiagnostics } from './typecheck';
import { provideCommaDiagnostics } from './commas';
import { provideArrayDiagnostics } from './arrays';
import { provideParameterRefDiagnostics } from './paramRefs';
import { provideOperatorDiagnostics } from './operators';
import { provideParenDiagnostics } from './parens';
import { provideLabelDiagnostics } from './labels';
import type { TextResolver } from '../gdl/masterScript';

export const SOURCE = 'gdl';

/**
 * Block labels, with the statement that terminates each.
 *
 * GDL has two distinct loop forms that both spell `WHILE`:
 *
 *     WHILE condition DO ... ENDWHILE     pre-tested
 *     DO ... WHILE condition              post-tested
 *
 * so `WHILE` opens a block when it ends in `DO` and closes one otherwise.
 */
const BLOCK_CLOSERS: Readonly<Record<string, string>> = {
	IF: 'ENDIF',
	FOR: 'NEXT',
	WHILE: 'ENDWHILE',
	DO: 'WHILE',
	REPEAT: 'UNTIL',
	GROUP: 'ENDGROUP',
	PARAGRAPH: 'ENDPARAGRAPH',
};

/** Which block, if any, a statement closes. */
const CLOSES: Readonly<Record<string, string>> = {
	endif: 'IF',
	next: 'FOR',
	endwhile: 'WHILE',
	until: 'REPEAT',
	endgroup: 'GROUP',
	endparagraph: 'PARAGRAPH',
};

function lastToken(stmt: Statement) {
	return stmt.tokens[stmt.tokens.length - 1];
}

/** The block this statement opens, or undefined. */
function opensBlock(stmt: Statement): string | undefined {
	switch (stmt.head) {
		// `IF cond THEN stmt` is complete and needs no ENDIF. A block opens
		// when the line ends on `THEN` — or on `ELSE`, which is how the
		// chained form is written:
		//     IF a THEN x = 1 ELSE
		//         IF b THEN y = 2 ELSE
		//             z = 3
		//         ENDIF
		//     ENDIF
		case 'if': {
			const last = lastToken(stmt)?.lower;
			return last === 'then' || last === 'else' ? 'IF' : undefined;
		}
		// `WHILE cond DO` opens; a bare `WHILE cond` closes a DO.
		case 'while':
			return lastToken(stmt)?.lower === 'do' ? 'WHILE' : undefined;
		// `DO` stands alone on its line.
		case 'do':
			return stmt.tokens.length === 1 ? 'DO' : undefined;
		case 'for':
			return 'FOR';
		case 'repeat':
			return 'REPEAT';
		case 'group':
			return 'GROUP';
		case 'paragraph':
			return 'PARAGRAPH';
		default:
			return undefined;
	}
}

/** The block this statement closes, or undefined. */
function closesBlock(stmt: Statement): string | undefined {
	if (stmt.head === 'while') {
		return lastToken(stmt)?.lower === 'do' ? undefined : 'DO';
	}
	return CLOSES[stmt.head ?? ''];
}

function checkBlocks(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const stack: { label: string; stmt: Statement }[] = [];

	for (const stmt of doc.statements) {
		if (!stmt.head) continue;

		const closes = closesBlock(stmt);
		if (closes) {
			const top = stack[stack.length - 1];
			if (!top) {
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: { start: td.positionAt(stmt.start), end: td.positionAt(stmt.end) },
					message: `\`${stmt.head.toUpperCase()}\` without a matching \`${closes}\`.`,
					source: SOURCE,
				});
				continue;
			}
			if (top.label === closes) {
				stack.pop();
				continue;
			}
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: { start: td.positionAt(stmt.start), end: td.positionAt(stmt.end) },
				message:
					`\`${stmt.head.toUpperCase()}\` does not close \`${top.label}\` ` +
					`opened at line ${td.positionAt(top.stmt.start).line + 1}.`,
				source: SOURCE,
			});
			continue;
		}

		const opens = opensBlock(stmt);
		if (opens) stack.push({ label: opens, stmt });
	}

	for (const unclosed of stack) {
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: {
				start: td.positionAt(unclosed.stmt.start),
				end: td.positionAt(unclosed.stmt.end),
			},
			message: `\`${unclosed.label}\` is never closed — expected \`${BLOCK_CLOSERS[unclosed.label]}\`.`,
			source: SOURCE,
		});
	}

	return diagnostics;
}

function checkScriptContext(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const script = doc.script;
	// The master script runs ahead of every other script, so anything goes.
	if (isPermissive(script)) return [];

	const diagnostics: Diagnostic[] = [];
	for (const stmt of doc.statements) {
		if (!stmt.head) continue;
		const first = stmt.tokens[0];
		if (first?.type !== 'identifier') continue;

		const kw = lookupWithVariants(first.text);
		if (!kw) continue;
		// Only statements are script-bound. Globals and functions are universal.
		if (kw.kind !== 'statement') continue;
		if (kw.scripts.includes(script!)) continue;
		// A user variable may legitimately shadow a rarely used reserved word.
		if (doc.variables.has(first.lower)) continue;

		diagnostics.push({
			severity: DiagnosticSeverity.Warning,
			range: { start: td.positionAt(first.start), end: td.positionAt(first.end) },
			message:
				`\`${kw.name}\` is not valid in the ${SCRIPT_LABELS[script!]}. ` +
				`It belongs to: ${kw.scripts.map((s) => SCRIPT_LABELS[s]).join(', ')}.`,
			source: SOURCE,
		});
	}
	return diagnostics;
}

function checkDeprecated(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const reported = new Set<number>();

	for (const tok of doc.tokens) {
		if (tok.type !== 'identifier' || reported.has(tok.start)) continue;
		const kw = lookupWithVariants(tok.text);
		if (!kw?.deprecated) continue;
		reported.add(tok.start);
		diagnostics.push({
			severity: DiagnosticSeverity.Hint,
			tags: [DiagnosticTag.Deprecated],
			range: { start: td.positionAt(tok.start), end: td.positionAt(tok.end) },
			message: `\`${kw.name}\` is deprecated.`,
			source: SOURCE,
		});
	}
	return diagnostics;
}

function checkStrings(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	return doc.badStrings.map((tok) => ({
		severity: DiagnosticSeverity.Error,
		range: { start: td.positionAt(tok.start), end: td.positionAt(tok.end) },
		message: `Unterminated string — missing closing ${quoteName(tok.quote)}.`,
		source: SOURCE,
	}));
}

export function provideDiagnostics(
	doc: GdlDocument,
	td: TextDocument,
	maxProblems: number,
	// Supplies unsaved editor text for sibling scripts; the label check reads
	// the master script through it. Defaulted so callers with nothing open —
	// the tests, the corpus sweep — fall back to what is on disk.
	resolve: TextResolver = () => undefined,
): Diagnostic[] {
	return [
		...checkStrings(doc, td),
		...checkBlocks(doc, td),
		...checkScriptContext(doc, td),
		...provideOperatorDiagnostics(doc, td),
		...provideParenDiagnostics(doc, td),
		...provideLabelDiagnostics(doc, td, resolve),
		...provideCommaDiagnostics(doc, td),
		...provideArrayDiagnostics(doc, td),
		...provideParameterRefDiagnostics(doc, td),
		...provideTypeDiagnostics(doc, td),
		...checkDeprecated(doc, td),
	].slice(0, maxProblems);
}
