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
 * The other half of this file is the mirror image: a **name reused for two
 * subroutines**. Confirmed by the project owner, and stated nowhere in the
 * guide: a reused label is a **hard failure**. Archicad detects it and the
 * object does not run — so this is an error, exactly as the missing label is,
 * and for the same reason. It counts as reuse whether the second definition is
 * in this script or in the **master script** that runs ahead of it, the two
 * being one program by the time labels are resolved.
 *
 * A collision is judged the way a jump matches, and that is not the usual GDL
 * rule. `0100:` and `100:` are one label, a numeric target being matched by
 * value. `"TapPage":` and `"tappage":` are **not** — a named label is compared
 * as the string literal it is, so those are two distinct subroutines and no
 * jump can reach both. Which is precisely the trap: they read as one name. So
 * a pair differing only in case is reported too, as a **warning** — nothing is
 * broken, but nothing is what it looks like either.
 *
 * The corpus holds none of the three — 2458 files, 0 reuses, 0 master
 * collisions and 0 case near-misses — which is why `labels.test.ts` carries
 * the whole proof that they fire, as it does for `commas.ts` and
 * `operators.ts`.
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
	looseLabelKey,
	type LabelDefinition,
} from '../gdl/labels';
import { masterScriptFor, type TextResolver } from '../gdl/masterScript';

export const SOURCE = 'gdl';

const JUMPS = new Set(['gosub', 'goto']);

/**
 * The note that explains a numeric pair spelt two ways — `0100:` against
 * `100:`. They read as different labels until you know a numeric target is
 * matched by value.
 */
function sameLabelNote(a: LabelDefinition, b: LabelDefinition): string {
	if (a.name === b.name || a.spelling !== 'numeric') return '';
	return ` \`${a.name}\` and \`${b.name}\` are one label: a numeric label is matched by value.`;
}

export function provideLabelDiagnostics(
	doc: GdlDocument,
	td: TextDocument,
	resolve: TextResolver,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	// A label defined twice in this script, and its near-miss. Neither needs
	// anything from the rest of the library part, so both are judged before the
	// master script is looked for, and both stand outside a library part too.
	const firstDefinition = new Map<string, LabelDefinition>();
	const firstLoosely = new Map<string, LabelDefinition>();
	for (const definition of labelDefinitions(doc)) {
		const loose = looseLabelKey(definition.name);
		const first = firstDefinition.get(definition.key);
		const similar = firstLoosely.get(loose);
		if (!firstDefinition.has(definition.key)) firstDefinition.set(definition.key, definition);
		if (!firstLoosely.has(loose)) firstLoosely.set(loose, definition);
		if (!first && !similar) continue;

		const previous = first ?? (similar as LabelDefinition);
		const previousRange = {
			start: td.positionAt(previous.token.start),
			end: td.positionAt(previous.token.end),
		};
		const line = previousRange.start.line + 1;
		diagnostics.push({
			severity: first ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
			range: {
				start: td.positionAt(definition.token.start),
				end: td.positionAt(definition.token.end),
			},
			message: first
				? `Label \`${definition.name}\` is already defined in this script, at ` +
					`line ${line}. A reused label stops the object: Archicad detects it ` +
					`and the script does not run.${sameLabelNote(first, definition)}`
				: `Label \`${definition.name}\` differs from \`${previous.name}\` at line ` +
					`${line} only in case. A named label is compared as a string literal, ` +
					`so these are two subroutines, and no jump can reach both.`,
			source: SOURCE,
			relatedInformation: [
				{
					location: { uri: doc.uri, range: previousRange },
					message: first
						? `First definition of \`${previous.name}\`.`
						: `\`${previous.name}\`, the label it reads as.`,
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

	// A name this script and the master script both define. That is the same
	// reuse, the master running ahead of this script and the two resolving as
	// one program — so it is the same error. It is reported on this script's
	// definition rather than the master's: the master is shared by every script
	// of the part, so the copy that turned up second is the one to look at.
	if (master) {
		const inMaster = new Map<string, LabelDefinition>();
		const inMasterLoosely = new Map<string, LabelDefinition>();
		for (const definition of labelDefinitions(master)) {
			if (!inMaster.has(definition.key)) inMaster.set(definition.key, definition);
			const loose = looseLabelKey(definition.name);
			if (!inMasterLoosely.has(loose)) inMasterLoosely.set(loose, definition);
		}
		// Positions in the master are wanted only here, and a collision is rare
		// enough that laying the text out for one costs nothing.
		let masterTd: TextDocument | undefined;
		for (const definition of firstDefinition.values()) {
			const shared = inMaster.get(definition.key);
			const similar = inMasterLoosely.get(looseLabelKey(definition.name));
			if (!shared && !similar) continue;
			const previous = shared ?? (similar as LabelDefinition);
			masterTd ??= TextDocument.create(master.uri, td.languageId, 0, master.text);
			const masterRange = {
				start: masterTd.positionAt(previous.token.start),
				end: masterTd.positionAt(previous.token.end),
			};
			const line = masterRange.start.line + 1;
			diagnostics.push({
				severity: shared ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
				range: {
					start: td.positionAt(definition.token.start),
					end: td.positionAt(definition.token.end),
				},
				message: shared
					? `Label \`${definition.name}\` is also defined in the master script, ` +
						`at line ${line}. The master runs before this script, so the label ` +
						`is reused — which stops the object.` +
						`${sameLabelNote(previous, definition)}`
					: `Label \`${definition.name}\` differs from \`${previous.name}\` in the ` +
						`master script, at line ${line}, only in case. A named label is ` +
						`compared as a string literal, so these are two subroutines, and no ` +
						`jump can reach both.`,
				source: SOURCE,
				relatedInformation: [
					{
						location: { uri: master.uri, range: masterRange },
						message: `\`${previous.name}\` in the master script.`,
					},
				],
			});
		}
	}

	// Both maps are keyed the way `labelKey` matches, so a named label is in
	// reach only under its own spelling. The loose one is not for resolving —
	// it names the near-miss in the message, a jump differing from a real label
	// only in case being far likelier a typo than a coincidence.
	const known = new Set<string>();
	const knownLoosely = new Map<string, string>();
	const note = (key: string, name: string) => {
		known.add(key);
		const loose = looseLabelKey(name);
		if (!knownLoosely.has(loose)) knownLoosely.set(loose, name);
	};
	for (const [key, info] of doc.labels) note(key, info.name);
	if (master) for (const [key, info] of master.labels) note(key, info.name);

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
			const nearMiss = knownLoosely.get(looseLabelKey(name));
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: { start: td.positionAt(target.start), end: td.positionAt(target.end) },
				message:
					`No label \`${name}\` in ${where}. ` +
					`\`${tok.text.toUpperCase()}\` to a missing label stops the object, ` +
					`even where the jump is never reached.` +
					(nearMiss
						? ` \`${nearMiss}\` differs only in case, and a named label is ` +
							'compared as a string literal.'
						: ''),
				source: SOURCE,
			});
		}
	}

	return diagnostics;
}
