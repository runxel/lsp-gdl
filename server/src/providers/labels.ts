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
 *
 * What a jump is, and how a label name is keyed, live in `gdl/labels.ts` —
 * rename reads a label through the same model.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import { libPartFor } from '../gdl/libpart';
import { jumpTarget, labelKey, labelName } from '../gdl/labels';
import { masterScriptFor, type TextResolver } from '../gdl/masterScript';

export const SOURCE = 'gdl';

const JUMPS = new Set(['gosub', 'goto']);

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

			const name = labelName(target);
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
