/**
 * A variable written and never read.
 *
 *     _oldOffset = wallThk / 2        ! nothing ever reads it
 *
 * The leftover of an edit: a temporary whose last reader was deleted, a
 * variable renamed at its uses but not at its assignment, a calculation kept
 * "just in case". GDL says nothing about it — an unread variable is perfectly
 * legal and costs a few bytes — so this is not an error and is deliberately not
 * reported as one. It is a `Hint` carrying `DiagnosticTag.Unnecessary`, which
 * is what greys the text out in the editor and keeps it out of the Problems
 * panel, exactly as an unused import is greyed in TypeScript.
 *
 * (`DiagnosticTag` is the mechanism for this and semantic tokens are not: the
 * LSP's standard token modifiers have no `unused`, and VS Code's fade comes
 * from the tag. `checkDeprecated` in `diagnostics.ts` already takes the same
 * route for `DiagnosticTag.Deprecated`.)
 *
 * ## Where a read may come from
 *
 * The whole difficulty is that "never read" is a claim about more than one
 * file, and GDL's scopes are not the obvious ones:
 *
 *   - **The master script publishes downward.** `1d.gdl` runs before every
 *     other script, so a variable it writes may be read anywhere in the part;
 *     the parameter script (`vl.gdl`) reaches across it the same way. A
 *     variable of either is judged against *every* script of the library part,
 *     and outside a library part — where the siblings cannot be found — the
 *     check stands down for those two entirely, as `arrays.ts` does.
 *   - **The master script also reads upward**, which is the one that is easy to
 *     miss. A jump reaches its own script plus the master's, so `GOSUB "helper"`
 *     from `3d.gdl` runs master code that may read variables `3d.gdl` set a
 *     moment earlier. So the master's reads count for every script, not just
 *     for its own.
 *
 * ## What is not a variable of this script
 *
 *   - **A parameter**, whether `paramlist.xml` declares it or the keyword table
 *     knows it as fixed. Assigning a parameter is writing the object's state,
 *     and the reader is Archicad.
 *   - **A global**, for the same reason: `GLOB_USER_1 = 3` is written to be
 *     read by something outside the script. Both fall out of the keyword-table
 *     test in `usage.ts`.
 *   - **A `PARAMETERS name = …` target**, which addresses a parameter list and
 *     defines nothing. `usage.ts` skips those positions.
 *   - **A `FOR` counter.** `FOR i = 1 TO 5 … NEXT i` with a body that never
 *     mentions `i` is how GDL spells "do this five times", and greying the
 *     counter would call idiomatic code a mistake.
 */

import { Diagnostic, DiagnosticSeverity, DiagnosticTag } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import { libPartFor } from '../gdl/libpart';
import { masterScriptFor, siblingScripts, type TextResolver } from '../gdl/masterScript';
import { namesRead, nameUsage, variableKey } from '../gdl/usage';

export const SOURCE = 'gdl';

/** Scripts whose variables reach the rest of the library part. */
const PUBLISHING_SCRIPTS = new Set(['1d', 'vl']);

export function provideUnusedDiagnostics(
	doc: GdlDocument,
	td: TextDocument,
	resolve: TextResolver = () => undefined,
): Diagnostic[] {
	const publishes = PUBLISHING_SCRIPTS.has(doc.script ?? '');
	const libpart = libPartFor(doc.uri);

	// A published variable can be read anywhere in the part, so without the
	// part there is nothing to read against and the honest answer is silence.
	if (publishes && !libpart) return [];

	const elsewhere = new Set<string>();

	// The master script's subroutines run inside whichever script jumped to
	// them, so its reads reach this script's variables. For the master itself
	// this returns nothing, which is right — it cannot jump into anyone else.
	const master = masterScriptFor(doc.uri, doc.script, resolve);
	if (master) for (const key of namesRead(master)) elsewhere.add(key);

	if (publishes && libpart) {
		for (const sibling of siblingScripts(doc.uri, resolve)) {
			for (const key of namesRead(sibling)) elsewhere.add(key);
		}
	}

	const diagnostics: Diagnostic[] = [];

	for (const [key, entry] of nameUsage(doc)) {
		if (entry.reads > 0 || entry.writes.length === 0) continue;
		if (entry.isLoopVariable) continue;
		if (elsewhere.has(key)) continue;
		// Declared in `paramlist.xml`, so the object owns the name.
		if (libpart?.parameters.has(key)) continue;
		// Something has to be *computed* into the name for anything to be wrong.
		// A literal bound to a name is a declaration and a discarded call result
		// is the price of making the call; neither is work going to waste. Only
		// the computed sites are greyed, so a scratch name reused for a dozen
		// `REQUEST`s does not turn grey the moment one line does arithmetic — see
		// `WriteKind` for the three shapes and what the corpus said about them.
		const wasted = entry.writes.filter((w) => w.kind === 'value');
		if (wasted.length === 0) continue;

		// Every wasted site, not just the first. One missing reader is one
		// mistake, but a second assignment a hundred lines down carrying no fade
		// reads as the check being broken — the lesson `arrays.ts` records under
		// "An array never declared".
		for (const { token: tok } of wasted) {
			diagnostics.push({
				severity: DiagnosticSeverity.Hint,
				tags: [DiagnosticTag.Unnecessary],
				range: {
					start: td.positionAt(tok.start),
					end: td.positionAt(tok.start + variableKey(tok).length),
				},
				message: `\`${entry.name}\` is assigned but never read.`,
				source: SOURCE,
			});
		}
	}

	return diagnostics;
}
