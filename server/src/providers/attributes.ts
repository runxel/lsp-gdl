/**
 * An attribute command handed a name nothing ever gives a value.
 *
 *     pen foobar              <- not a parameter, never assigned
 *     material matBdoy        <- the parameter is `matBody`
 *
 * GDL reads an unset variable as 0 and says nothing, so the statement runs: the
 * body is simply drawn with pen 0, material 0, fill 0 — whatever index 0 means
 * to that attribute, which is never what was meant. The leftover is nearly
 * always a rename that missed a site, or a parameter deleted from the list
 * while a script kept using it, the same story `arrays.ts` tells about an
 * undeclared array.
 *
 * Undefined *scalars* are deliberately not checked in general (see CLAUDE.md,
 * "Deliberately not implemented yet"): an ordinary expression may lean on the
 * zero, and names arrive from more directions than one script can see. An
 * attribute argument is the narrow case where the zero is never the intent, and
 * where every route a value could take is one this server can read:
 *
 *   - **A write in this script** — an assignment, `FOR`, `LET`, `DIM`,
 *     `DICT`, or a call that fills its arguments in (`REQUEST`, `INPUT`,
 *     `RETURNED_PARAMETERS` …), wherever it stands. Source order is not
 *     execution order once `GOSUB` is in play, so a write after the use counts.
 *   - **A write in a script that reaches this one**, the master and parameter
 *     scripts — `sharedScriptsFor()`, the scope `arrays.ts` reads declarations
 *     from.
 *   - **A parameter**, from `paramlist.xml`. That list holds inherited
 *     parameters too, and a macro's values from a `CALL … PARAMETERS ALL`
 *     arrive through its own list, so nothing is missing from it.
 *   - **A keyword** — the globals and fixed parameters Archicad owns, and the
 *     functions an argument may call (`IND (MATERIAL, "x")`).
 *   - **An attribute defined under that name**, which is not a variable at
 *     all. The guide lets an identifier stand for a string name, and the
 *     corpus defines attributes that way:
 *
 *         DEFINE STYLE lsg_tStyleName sg_tFont, sg_tSize, …
 *         r = REQUEST ("Height_of_style", "lsg_tStyleName", _textSize)
 *         SET STYLE lsg_tStyleName
 *
 *     The `REQUEST` in that same master script (`02_ling`) is what settles it:
 *     the bare word *is* the string. 317 corpus sites in 113 files read this
 *     way — 272 of them in GRAPHISOFT's own library, 16 in `Öffnung
 *     polygonal` — and every one was reported before this rule. Matched
 *     case-insensitively, the lenient direction, and in the same scope as a
 *     variable — the guide has a master script's inline attributes reaching
 *     the scripts after it.
 *
 * Outside a library part the check stands down, as `arrays.ts` and the
 * missing-label half of `labels.ts` do: without `paramlist.xml` a parameter
 * cannot be told from a typo.
 *
 * **Which commands**: those whose arguments are all attribute references, per
 * the guide's Attributes section — `PEN`, `[SET] MATERIAL`, `[SET] FILL`,
 * `[SET] LINE_TYPE`, `[SET] STYLE`, `[SET] BUILDING_MATERIAL`, `SECT_FILL`,
 * `SECT_ATTRS` and `SECT_ATTRS{2}`. Only at the head of a clause, which is what
 * keeps `DEFINE MATERIAL`, `DEFINE FILL` and `DEFINE STYLE` out: there the
 * second word names a definition, not the current attribute. The walk restarts
 * at `THEN`/`ELSE`, so `IF a THEN PEN p` is judged.
 *
 * **Every identifier in the arguments is judged**, not just a bare one — the
 * array of `pen pens[i]`, its index, the head of a dotted path. Each reads as 0
 * just the same. A dict member standing after a subscript (`d.f[1].pen`) is a
 * key, not a variable, and is left alone.
 *
 * **Every site is reported**, the lesson `arrays.ts` records under "An array
 * never declared": a second use left clean reads as the check being broken.
 *
 * A **warning**, for `arrays.ts`'s reason: a value could still be arriving by a
 * route this server cannot see, and a hard error on working code is worse than
 * a soft one on a leftover.
 *
 * Corpus: 11637 files, 0 crashes, 32715 attribute commands, **145 reports in
 * 44 files**, every one read by hand a leftover — `penShaftWall3D` in `Aufzug
 * AOL`, `tube_mat` in three grab rails whose parameter lists carry no material
 * at all, `gs_Demolition_linetype` in GRAPHISOFT's own `Window Example`.
 * Sweeping the other way accounts for every identifier left alone: 27799
 * parameters, 4948 written in the same script, 940 written by the master or
 * parameter script, 1151 keywords, 317 `DEFINE` names, 2 dict members.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';
import { clauseStarts } from '../gdl/assignments';
import { lookupWithVariants } from '../gdl/keywords';
import { libPartFor } from '../gdl/libpart';
import { sharedScriptsFor, type TextResolver } from '../gdl/masterScript';
import { namesWritten, variableKey } from '../gdl/usage';

export const SOURCE = 'gdl';

/** Commands whose every argument names an attribute, and which may take `SET`. */
const SETTABLE = new Set(['material', 'fill', 'line_type', 'style', 'building_material']);

/** The same, never spelt with `SET`. */
const BARE = new Set(['pen', 'sect_fill', 'sect_attrs', 'sect_attrs{2}']);

/**
 * Words an attribute command takes in place of a value. `BUILDING_MATERIAL
 * idx, DEFAULT, pen` leaves one override pen at the material's own, per the
 * guide — and `DEFAULT` is missing from the vendored keyword list, so it would
 * otherwise read as a variable nobody assigns. Kept here rather than added to
 * the list, where it would become a reserved name for every other check.
 */
const ARGUMENT_WORDS = new Set(['default']);

function isOp(tok: Token | undefined, text: string): boolean {
	return tok?.type === 'operator' && tok.text === text;
}

function isWord(tok: Token | undefined, ...words: string[]): boolean {
	return tok?.type === 'identifier' && words.includes(tok.lower);
}

/**
 * Where the arguments of an attribute command begin, if one opens the clause
 * at `start`, and the command as the author spelt it.
 */
function attributeCommandAt(
	toks: readonly Token[],
	start: number,
): { command: string; args: number } | undefined {
	let at = start;
	if (isWord(toks[at], 'set') && SETTABLE.has(toks[at + 1]?.lower ?? '')) at++;
	const word = toks[at];
	if (word?.type !== 'identifier') return undefined;
	if (!SETTABLE.has(word.lower) && !BARE.has(word.lower)) return undefined;
	// `material = 3` is an assignment to a keyword — `reservedNames.ts`'s
	// business — and not the command.
	if (isOp(toks[at + 1], '=')) return undefined;
	return { command: word.text.toUpperCase(), args: at + 1 };
}

/**
 * Every name a script gives an attribute with `DEFINE`, lower-cased — quoted
 * or bare, since a reference may spell it the other way.
 */
function definedAttributeNames(doc: GdlDocument): Set<string> {
	const names = new Set<string>();
	for (const stmt of doc.statements) {
		const toks = stmt.tokens;
		for (const start of clauseStarts(toks)) {
			if (!isWord(toks[start], 'define')) continue;
			// `DEFINE STYLE{2} name …` — the kind lexes as one word, braces and all.
			const name = toks[start + 2];
			if (name?.type === 'identifier') names.add(name.lower);
			else if (name?.type === 'string') names.add(name.text.slice(1, -1).toLowerCase());
		}
	}
	return names;
}

export function provideAttributeDiagnostics(
	doc: GdlDocument,
	td: TextDocument,
	resolve: TextResolver = () => undefined,
): Diagnostic[] {
	const libpart = libPartFor(doc.uri);
	if (!libpart) return [];

	// Built lazily: most scripts set no attribute through a variable at all,
	// and those need neither the master read nor their own usage pass.
	let known: Set<string>[] | undefined;
	const isKnown = (key: string) => {
		if (!known) {
			const docs = [doc, ...sharedScriptsFor(doc.uri, resolve)];
			known = [...docs.map(namesWritten), ...docs.map(definedAttributeNames)];
		}
		return known.some((names) => names.has(key));
	};

	const diagnostics: Diagnostic[] = [];

	for (const stmt of doc.statements) {
		const toks = stmt.tokens;
		for (const start of clauseStarts(toks)) {
			const found = attributeCommandAt(toks, start);
			if (!found) continue;

			for (let i = found.args; i < toks.length; i++) {
				const tok = toks[i];
				if (tok.type !== 'identifier') continue;
				if (tok.lower === 'then' || tok.lower === 'else') break;

				// A dict member after a subscript is a key, not a variable.
				if (isOp(toks[i - 1], '.')) continue;
				if (ARGUMENT_WORDS.has(tok.lower)) continue;
				if (lookupWithVariants(tok.text)) continue;

				const key = variableKey(tok);
				if (libpart.parameters.has(key) || isKnown(key)) continue;
				// A dotted path whose head is a keyword — `GLOB_…` dicts.
				if (key !== tok.lower && lookupWithVariants(key)) continue;

				const name = tok.text.slice(0, key.length);
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					range: { start: td.positionAt(tok.start), end: td.positionAt(tok.start + name.length) },
					message:
						`\`${name}\` is never given a value: nothing in reach of this script assigns ` +
						`it, and \`${libpart.name}\` has no parameter of that name, so ` +
						`\`${found.command}\` reads it as 0.`,
					source: SOURCE,
				});
			}
		}
	}

	return diagnostics;
}
