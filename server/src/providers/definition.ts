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
 */

import { Location, Range, type Position } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import { groupDefinitions, groupNameAt } from '../gdl/groups';

export function provideDefinition(
	doc: GdlDocument,
	td: TextDocument,
	position: Position,
): Location | null {
	const reference = groupNameAt(doc, td.offsetAt(position));
	if (!reference) return null;

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
