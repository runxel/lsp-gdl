/**
 * Checks that every `GOSUB` and `GOTO` names a jump label that exists.
 *
 * This one is fatal rather than cosmetic. A label that was renamed, or a
 * subroutine that was deleted while its call sites stayed behind, stops the
 * object outright — and it does so **whether or not the jump is reachable**,
 * because the interpreter resolves labels before it runs anything. So a
 * `GOSUB "oldName"` sitting inside a branch that never fires still breaks the
 * part, which is exactly why the mistake survives so long in real code.
 *
 * From the guide:
 *
 *     GOSUB label        GOTO label
 *     label: number or string expression
 *
 * Both spellings of a label are targets — `100:` and `"routineName":`.
 *
 * Scope, confirmed with the project owner: a jump reaches the labels of **its
 * own script plus the master script**, which runs ahead of every other script
 * and so contributes its subroutines to all of them. Sibling scripts are
 * independent, matching how variables scope (see `masterScript.ts`).
 *
 * Only a **lone literal** target is judged. The guide calls the label a string
 * or numeric *expression*, and the corpus takes it at its word —
 * `GOSUB 10 + idx`, `GOSUB i_type * 10`, `GOSUB _subid[type_head_1]` — none of
 * which can be resolved without running the script. As elsewhere in this
 * server, an unknowable name is left alone rather than guessed at.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';
import { libPartFor } from '../gdl/libpart';
import { masterScriptFor, type TextResolver } from '../gdl/masterScript';

export const SOURCE = 'gdl';

const JUMPS = new Set(['gosub', 'goto']);

/**
 * A label key both sides agree on.
 *
 * Names are matched case-insensitively, as everything in GDL is, and numeric
 * labels by value — so `0100:` answers `GOSUB 100`.
 */
function labelKey(raw: string): string {
	const n = Number(raw);
	return /^\d+(\.\d+)?$/.test(raw) && Number.isFinite(n) ? String(n) : raw.toLowerCase();
}

/** The label a jump names, or undefined when it cannot be resolved statically. */
function jumpTarget(toks: readonly Token[], i: number): Token | undefined {
	const target = toks[i + 1];
	if (!target) return undefined;
	if (target.type === 'string') {
		if (target.unterminated) return undefined;
	} else if (target.type !== 'number') {
		// A variable or anything else computed — `GOSUB _subid[i]`.
		return undefined;
	}

	// An operator after the literal means it is one term of an expression:
	// `GOSUB 100 + 10 * markerStyle`. Only a target standing on its own is
	// judged; a following keyword (`... THEN GOSUB "x" ELSE ...`) is fine.
	const after = toks[i + 2];
	if (after?.type === 'operator') return undefined;

	return target;
}

function nameOf(tok: Token): string {
	return tok.type === 'string' ? tok.text.slice(1, -1) : tok.text;
}

export function provideLabelDiagnostics(
	doc: GdlDocument,
	td: TextDocument,
	resolve: TextResolver,
): Diagnostic[] {
	// The set of labels in reach is what makes this checkable, so bail out
	// whenever any part of it is unknown. Outside a library part the master
	// script cannot be found at all, and a jump may well be answered there.
	let master: GdlDocument | undefined;
	if (doc.script !== '1d') {
		if (!libPartFor(doc.uri)) return [];
		// Undefined here means the part genuinely has no master script, so
		// there are no inherited labels — not that we failed to look.
		master = masterScriptFor(doc.uri, doc.script, resolve);
	}

	const known = new Set<string>();
	for (const key of doc.labels.keys()) known.add(labelKey(key));
	if (master) for (const key of master.labels.keys()) known.add(labelKey(key));

	const diagnostics: Diagnostic[] = [];

	for (const stmt of doc.statements) {
		const toks = stmt.tokens;
		for (let i = 0; i < toks.length; i++) {
			const tok = toks[i];
			// A jump may sit anywhere in a statement: `IF a THEN GOSUB "x"`.
			if (tok.type !== 'identifier' || !JUMPS.has(tok.lower)) continue;
			// A user variable shadowing the keyword is not a jump.
			if (doc.variables.has(tok.lower)) continue;

			const target = jumpTarget(toks, i);
			if (!target) continue;

			const name = nameOf(target);
			if (name === '' || known.has(labelKey(name))) continue;

			const where =
				doc.script === '1d' ? 'this script' : 'this script or the master script';
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: { start: td.positionAt(target.start), end: td.positionAt(target.end) },
				message:
					`No label \`${name}\` in ${where}. ` +
					`\`${tok.text.toUpperCase()}\` to a missing label stops the object, ` +
					`even where the jump is never reached.`,
				source: SOURCE,
			});
		}
	}

	return diagnostics;
}
