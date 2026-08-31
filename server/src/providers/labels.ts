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
 * The other half of this file is the mirror image: a **name that answers two
 * subroutines**. A label defined twice in one script, or once here and once in
 * the master script that runs ahead of it, leaves a `GOSUB` naming two
 * routines — so one of them is unreachable, and nothing in the guide says
 * which. That is a copy-paste leftover rather than a jump that fails outright,
 * so it is reported as a warning where the missing label is an error.
 *
 * Both spellings collide the way a jump matches them: case-insensitively for a
 * name and by value for a number, so `0100:` and `100:` are one label defined
 * twice. The corpus holds neither shape — 2458 files, 0 duplicates and 0
 * master collisions — which is why `labels.test.ts` carries the whole proof
 * that these fire, as it does for `commas.ts` and `operators.ts`.
 *
 * What a jump is, and how a label name is keyed, live in `gdl/labels.ts` —
 * rename reads a label through the same model.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import { libPartFor } from '../gdl/libpart';
import {
	jumpTarget,
	labelDefinitions,
	labelKey,
	labelName,
	type LabelDefinition,
} from '../gdl/labels';
import { masterScriptFor, type TextResolver } from '../gdl/masterScript';

export const SOURCE = 'gdl';

const JUMPS = new Set(['gosub', 'goto']);

/**
 * How two spellings of one label differ, where they do — `0100:` against
 * `100:`, `"TapPage":` against `"tapPage":`. Worth saying out loud, since the
 * two read as different names until you know how a jump matches them.
 */
function sameLabelNote(a: LabelDefinition, b: LabelDefinition): string {
	if (a.name === b.name) return '';
	const how =
		a.spelling === 'numeric'
			? 'a numeric label is matched by value'
			: 'names are matched case-insensitively';
	return ` \`${a.name}\` and \`${b.name}\` are one label: ${how}.`;
}

export function provideLabelDiagnostics(
	doc: GdlDocument,
	td: TextDocument,
	resolve: TextResolver,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	// A label defined twice in this script. This needs nothing from the rest of
	// the library part, so it is judged before the master script is looked for,
	// and it stands outside a library part too.
	const firstDefinition = new Map<string, LabelDefinition>();
	for (const definition of labelDefinitions(doc)) {
		const first = firstDefinition.get(definition.key);
		if (!first) {
			firstDefinition.set(definition.key, definition);
			continue;
		}
		const firstRange = {
			start: td.positionAt(first.token.start),
			end: td.positionAt(first.token.end),
		};
		diagnostics.push({
			severity: DiagnosticSeverity.Warning,
			range: {
				start: td.positionAt(definition.token.start),
				end: td.positionAt(definition.token.end),
			},
			message:
				`Label \`${definition.name}\` is already defined in this script, ` +
				`at line ${firstRange.start.line + 1}. A jump can only reach one of ` +
				`the two.${sameLabelNote(first, definition)}`,
			source: SOURCE,
			relatedInformation: [
				{
					location: { uri: doc.uri, range: firstRange },
					message: `First definition of \`${first.name}\`.`,
				},
			],
		});
	}

	// The set of labels in reach is what makes this checkable, so bail out
	// whenever any part of it is unknown. Outside a library part the master
	// script cannot be found at all, and a jump may well be answered there.
	let master: GdlDocument | undefined;
	if (doc.script !== '1d') {
		if (!libPartFor(doc.uri)) return diagnostics;
		// Undefined here means the part genuinely has no master script, so
		// there are no inherited labels — not that we failed to look.
		master = masterScriptFor(doc.uri, doc.script, resolve);
	}

	// A name this script and the master script both define. It is reported on
	// this script's definition rather than the master's: the master is shared by
	// every script of the part, so the copy that turned up second is the one to
	// look at.
	if (master) {
		const inMaster = new Map<string, LabelDefinition>();
		for (const definition of labelDefinitions(master)) {
			if (!inMaster.has(definition.key)) inMaster.set(definition.key, definition);
		}
		// Positions in the master are wanted only here, and a collision is rare
		// enough that laying the text out for one costs nothing.
		let masterTd: TextDocument | undefined;
		for (const definition of firstDefinition.values()) {
			const shared = inMaster.get(definition.key);
			if (!shared) continue;
			masterTd ??= TextDocument.create(master.uri, td.languageId, 0, master.text);
			const masterRange = {
				start: masterTd.positionAt(shared.token.start),
				end: masterTd.positionAt(shared.token.end),
			};
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range: {
					start: td.positionAt(definition.token.start),
					end: td.positionAt(definition.token.end),
				},
				message:
					`Label \`${definition.name}\` is also defined in the master script, ` +
					`at line ${masterRange.start.line + 1}. The master runs before this ` +
					`script, so two subroutines share one name and a jump here can only ` +
					`reach one of them.${sameLabelNote(shared, definition)}`,
				source: SOURCE,
				relatedInformation: [
					{
						location: { uri: master.uri, range: masterRange },
						message: `\`${shared.name}\` in the master script.`,
					},
				],
			});
		}
	}

	const known = new Set<string>();
	for (const key of doc.labels.keys()) known.add(labelKey(key));
	if (master) for (const key of master.labels.keys()) known.add(labelKey(key));

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
