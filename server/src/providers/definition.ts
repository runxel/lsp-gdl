/**
 * Go-to-definition for GDL.
 *
 * Groups are the case that needs it. A `PLACEGROUP "gr_leg"` says nothing about
 * where those bodies were built, and the `GROUP "gr_leg"` that built them is
 * usually hundreds of lines away — solid operations are written at the end of a
 * 3D script, long after the parts they combine. The same goes for the variable
 * form: `PLACEGROUP result` gives no hint of which operation produced `result`.
 *
 * Both are followed here, within the current script, which is as far as a group
 * reaches:
 *
 *     PLACEGROUP "gr_leg"          →  GROUP "gr_leg"
 *     PLACEGROUP result            →  result = SUBGROUP ("box", "sphere")
 *     PLACEGROUP fixingGroup       →  GROUP fixingGroup
 *
 * A group named by a variable has two plausible targets — the `GROUP` statement
 * and the assignment that built the name. The `GROUP` statement wins, since
 * that is where the geometry is; standing *on* it falls through to the
 * assignment instead, so the two are one step apart in either direction.
 *
 * Inline attributes are the other case, and they reach further. A
 * `SET STYLE "Label"` names a style the master script usually `DEFINE`s, so the
 * search runs through this script first and then the scripts that reach it —
 * the master, then the parameter script — stopping at the first that defines
 * the name. A later `DEFINE` of the same name replaces the master's at run
 * time, which is why this script's own wins. Every definition in that script is
 * returned: a style is routinely defined once per branch of an `IF`, at a
 * different size each, and any of them may be the one that ran.
 */

import { Location, Range, type Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import { attributeDefinitions, attributeReferenceAt } from '../gdl/attributeNames';
import { groupDefinitions, groupNameAt } from '../gdl/groups';
import { sharedScriptsFor, type TextResolver } from '../gdl/masterScript';

export function provideDefinition(
	doc: GdlDocument,
	td: TextDocument,
	position: Position,
	resolve: TextResolver = () => undefined,
): Location | Location[] | null {
	const offset = td.offsetAt(position);
	const reference = groupNameAt(doc, offset);
	if (!reference) return attributeDefinition(doc, td, offset, resolve);

	const at = (start: number, end: number) =>
		Location.create(doc.uri, Range.create(td.positionAt(start), td.positionAt(end)));

	// `GROUP "gr_leg"` — the group itself. Skipped when the cursor is already
	// there, so a definition never resolves to itself.
	const definition = groupDefinitions(doc).find(
		(d) => d.kind === reference.kind && d.key === reference.key && d.token.start !== reference.token.start,
	);
	if (definition) return at(definition.token.start, definition.token.end);

	// Otherwise the name is a variable: either a group-typed one holding the
	// result of an operation, or a plain string holding the group's name. Both
	// were made by an assignment, which is what the analyzer recorded.
	if (reference.kind === 'variable') {
		const variable = doc.variables.get(reference.key);
		if (variable && variable.definedAt !== reference.token.start) {
			return at(variable.definedAt, variable.definedAt + variable.name.length);
		}
	}

	return null;
}

/** `[SET] STYLE "Label"` → the `DEFINE STYLE "Label"` in reach of this script. */
function attributeDefinition(
	doc: GdlDocument,
	td: TextDocument,
	offset: number,
	resolve: TextResolver,
): Location[] | null {
	const reference = attributeReferenceAt(doc, offset);
	if (!reference) return null;

	const definitionsIn = (script: GdlDocument) => {
		const found = attributeDefinitions(script).filter(
			(d) => d.kind === reference.kind && d.key === reference.key,
		);
		if (found.length === 0) return undefined;
		const std = script === doc ? td : TextDocument.create(script.uri, td.languageId, 0, script.text);
		return found.map((d) =>
			Location.create(script.uri, Range.create(std.positionAt(d.token.start), std.positionAt(d.token.end))),
		);
	};

	// The master is only read when this script defines nothing of the name.
	const own = definitionsIn(doc);
	if (own) return own;
	for (const script of sharedScriptsFor(doc.uri, resolve)) {
		const shared = definitionsIn(script);
		if (shared) return shared;
	}
	return null;
}
