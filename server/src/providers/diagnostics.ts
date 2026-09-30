/**
 * Diagnostics for GDL.
 *
 * Nine checks ship in v0, chosen because each catches a mistake that is both
 * common and invisible until Archicad refuses to open the object:
 *
 *   1. Unbalanced block structure (IF/ENDIF, FOR/NEXT, GROUP/ENDGROUP, ...).
 *      GDL reports these as a single unhelpful error at the end of the script.
 *      Includes an `ELSE` or `ENDIF` swallowed by a stray `\` continuation,
 *      and the mirror of it — a `THEN` stranded by a missing one.
 *   2. A command used in a script where it is not valid, e.g. `CUTPLANE` in
 *      the parameter script.
 *   3. Unterminated string literals.
 *   4. An operator left without an operand — `1 + + 2`.
 *   5. Brackets left unbalanced — `atn(a / b[1]))`.
 *   6. A `GOSUB`/`GOTO` naming a label that does not exist, which stops the
 *      object whether or not the jump is ever reached.
 *   7. A GDL keyword claimed as a variable name — `addx = foo + bar`, which
 *      Archicad refuses just as silently.
 *   8. An array subscripted but never declared, and one given more indices
 *      than its `DIM` gave it dimensions.
 *   9. A variable written and never read, which is not an error at all — it
 *      is greyed out rather than listed, being the leftover of an edit.
 *
 * Deliberately NOT checked yet: undefined *scalar* variables. GDL lets Archicad
 * inject names from several directions (fixed parameters, macro `PARAMETERS
 * ALL`, inherited ancestry) and reads an unset variable as 0, so a naive check
 * produces mostly false positives. An array is the tractable half of that
 * problem, because the guide requires a variable one to be declared outright —
 * see `arrays.ts`. See CLAUDE.md for what the rest would need.
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
import { provideReservedNameDiagnostics } from './reservedNames';
import { provideUnusedDiagnostics } from './unused';
import { MAX_LINE_LENGTH } from './format';
import type { QuickFix } from './codeActions';
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
		//
		// A `THEN` heading its own statement is the second half of an `IF` whose
		// `\` went missing — `checkMissingContinuations` reports that — and
		// counts as the opener here, so its `ENDIF` is not blamed as well.
		case 'if':
		case 'then': {
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

/**
 * Block keywords that only mean anything at the head of their own statement.
 * `ELSE` is the exception, being the middle clause of a one-line `IF` as well;
 * see `checkSwallowedKeywords`.
 */
const HEAD_ONLY = new Set(['else', 'endif', 'next', 'endwhile', 'until', 'endgroup', 'endparagraph']);

/**
 * A `\` continuation that runs into a block keyword on a later line:
 *
 *     if i_style = STYLE_FRAMED then
 *         put \               <- the arguments were never written
 *                             <- blank, still continuing
 *     else
 *
 * The continuation carries through blank and commented-out lines — it has to,
 * see the lexer — so the `ELSE` is joined onto the `PUT` and no longer belongs
 * to the `IF`. `checkBlocks` sees nothing wrong, since an `ELSE` never opens or
 * closes anything; a swallowed `ENDIF` or `NEXT` at least leaves its block
 * unclosed, but that error points at the opener, not at the `\` that did it.
 * Reported by the project owner.
 *
 * The comma spelling of the same slip is `commas.ts`'s trailing-comma check,
 * every one of these words being a statement in the keyword table.
 */
function checkSwallowedKeywords(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const text = doc.text;
	const diagnostics: Diagnostic[] = [];

	for (const stmt of doc.statements) {
		const toks = stmt.tokens;
		let thens = 0;
		let elses = 0;
		// The token that opens the current clause, which names the command the
		// keyword has been swallowed into.
		let clause = toks[0];

		for (let i = 1; i < toks.length; i++) {
			const tok = toks[i];
			const prev = toks[i - 1];
			if (prev.type === 'identifier' && (prev.lower === 'then' || prev.lower === 'else')) clause = tok;
			if (tok.type !== 'identifier') continue;

			const word = tok.lower;
			if (word === 'then') thens++;
			if (!HEAD_ONLY.has(word)) continue;
			// `IF a THEN PUT 1 \` over `ELSE PUT 2` is a one-line IF wrapped, and
			// its ELSE is still the IF's own.
			const ownElse = word === 'else' && thens > elses;
			if (word === 'else') elses++;
			if (ownElse) continue;

			// Joined by a `\`? It is the first thing after the previous token —
			// a comment can only follow it, never stand in front.
			let k = prev.end;
			while (k < tok.start && (text[k] === ' ' || text[k] === '\t')) k++;
			if (text[k] !== '\\') continue;

			const keyword = tok.text.toUpperCase();
			const into = clause.type === 'identifier' ? clause.text.toUpperCase() : undefined;
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: { start: td.positionAt(k), end: td.positionAt(k + 1) },
				message:
					`This \`\\\` continues the statement into \`${keyword}\` on line ` +
					`${td.positionAt(tok.start).line + 1}, which then reads as part of ` +
					(into ? `\`${into}\`` : 'this statement') +
					` rather than as a statement of its own.`,
				source: SOURCE,
			});
		}
	}
	return diagnostics;
}

/**
 * The words that carry a statement on to its next clause, each with the
 * command it belongs to and the words that may already have spelt that clause.
 * `IF a GOTO 100` is complete without a `THEN`, which is why those are here.
 */
const CLAUSE_OWNERS: Readonly<Record<string, { owner: string; spelt: readonly string[] }>> = {
	then: { owner: 'if', spelt: ['then', 'goto', 'gosub'] },
	to: { owner: 'for', spelt: ['to'] },
	step: { owner: 'for', spelt: ['step'] },
};

/**
 * A wrapped condition whose last row lost its `\`:
 *
 *     if foo & \
 *         bar                 <- `\` missing here
 *     then
 *
 * The line break ends the `IF` at `bar`, and `THEN` becomes a statement of its
 * own — which means nothing, and which Archicad reports once at the end of the
 * script. Left alone the block form gets only `checkBlocks`' "ENDIF without a
 * matching IF", pointing at the wrong end of the mistake, and the one-line
 * form `then addx 1` gets nothing at all. Reported by the project owner.
 *
 * Judged only where the statement above is the command still waiting for that
 * clause, so the report can name the fix, and the fix — a `\` after its last
 * token — travels with the diagnostic for `codeActions.ts` to offer. The
 * opposite slip, a trailing operator left before the `THEN`, is `operators.ts`'s.
 */
function checkMissingContinuations(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const text = doc.text;
	const diagnostics: Diagnostic[] = [];

	for (let s = 1; s < doc.statements.length; s++) {
		const stmt = doc.statements[s];
		const clause = CLAUSE_OWNERS[stmt.head ?? ''];
		if (!clause) continue;

		// The statement above must still be waiting for this clause: its last
		// `IF` (or `FOR`) with nothing after it that already spelt one.
		const prev = doc.statements[s - 1];
		const toks = prev.tokens;
		let owner = -1;
		for (let i = toks.length - 1; i >= 0; i--) {
			if (toks[i].type === 'identifier' && toks[i].lower === clause.owner) {
				owner = i;
				break;
			}
		}
		if (owner < 0) continue;
		if (toks.slice(owner + 1).some((t) => t.type === 'identifier' && clause.spelt.includes(t.lower))) continue;

		// It must have been ended by a line break — only whitespace or a
		// comment after its last token — and not by a `:`.
		const last = toks[toks.length - 1];
		let k = last.end;
		while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
		if (k < text.length && text[k] !== '!' && text[k] !== '\r' && text[k] !== '\n') continue;

		const keyword = stmt.tokens[0];
		const lastLine = td.positionAt(last.end).line;
		diagnostics.push({
			severity: DiagnosticSeverity.Error,
			range: { start: td.positionAt(keyword.start), end: td.positionAt(keyword.end) },
			message:
				`\`${keyword.text.toUpperCase()}\` stands on a line of its own — the ` +
				`\`${toks[owner].text.toUpperCase()}\` above it ends at line ${lastLine + 1}, ` +
				`which is missing a \`\\\`.`,
			source: SOURCE,
			data: continuationFix(td, last.end),
		});
	}
	return diagnostics;
}

/**
 * The quick fix for `checkMissingContinuations`: ` \` straight after the last
 * token, ahead of any trailing comment. Held to the 255-character line limit
 * like everything else that writes to a script — a bare `\` when the space
 * would not fit, and no fix at all when neither does.
 */
function continuationFix(td: TextDocument, at: number): QuickFix | undefined {
	const pos = td.positionAt(at);
	const line = td
		.getText({ start: { line: pos.line, character: 0 }, end: { line: pos.line + 1, character: 0 } })
		.replace(/[\r\n]+$/, '');
	const newText = [' \\', '\\'].find((t) => line.length + t.length <= MAX_LINE_LENGTH);
	if (!newText) return undefined;
	return {
		quickFix: {
			title: 'Continue the statement with `\\`',
			edits: [{ range: { start: pos, end: pos }, newText }],
		},
	};
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
		...checkSwallowedKeywords(doc, td),
		...checkMissingContinuations(doc, td),
		...checkScriptContext(doc, td),
		...provideOperatorDiagnostics(doc, td),
		...provideParenDiagnostics(doc, td),
		...provideLabelDiagnostics(doc, td, resolve),
		...provideReservedNameDiagnostics(doc, td),
		...provideCommaDiagnostics(doc, td),
		...provideArrayDiagnostics(doc, td, resolve),
		...provideParameterRefDiagnostics(doc, td),
		...provideTypeDiagnostics(doc, td),
		...provideUnusedDiagnostics(doc, td, resolve),
		...checkDeprecated(doc, td),
	].slice(0, maxProblems);
}
