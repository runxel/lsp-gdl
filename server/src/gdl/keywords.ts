/**
 * Lookup layer over the generated keyword table.
 *
 * GDL is case-insensitive, so every index is keyed on the lower-cased name.
 * Variant spellings (`CPRISM_{2}`) are indexed both whole and by their base
 * name, because a user typing `CPRISM_` should still get a hover.
 */

import { KEYWORDS, type GdlKeyword, type KeywordKind } from '../data/keywords.generated';
import { referenceDoc } from './referenceDocs';
import type { ScriptKind } from './scriptKind';

const byName = new Map<string, GdlKeyword>();
const byBaseName = new Map<string, GdlKeyword[]>();

for (const kw of KEYWORDS) {
	const lower = kw.name.toLowerCase();
	if (!byName.has(lower)) byName.set(lower, kw);

	const base = lower.replace(/\{\d+\}$/, '');
	const bucket = byBaseName.get(base);
	if (bucket) bucket.push(kw);
	else byBaseName.set(base, [kw]);
}

export { KEYWORDS };
export type { GdlKeyword, KeywordKind };

/** Exact (case-insensitive) lookup. */
export function lookup(name: string): GdlKeyword | undefined {
	return byName.get(name.toLowerCase());
}

/**
 * Lookup that also resolves a bare name to its variants, so `CPRISM_` finds
 * `CPRISM_{2}` when only the variant is documented.
 */
export function lookupWithVariants(name: string): GdlKeyword | undefined {
	const exact = byName.get(name.toLowerCase());
	if (exact) return exact;
	return byBaseName.get(name.toLowerCase())?.[0];
}

/** All documented variants of a name, e.g. every `POLY2_B{n}`. */
export function variantsOf(name: string): GdlKeyword[] {
	const base = name.toLowerCase().replace(/\{\d+\}$/, '');
	return byBaseName.get(base) ?? [];
}

/**
 * Where `kw` may legally appear, narrowed by the reference guide.
 *
 * The vendored list has no per-script information for globals, so it credits
 * every one of them to every script. The guide knows better for 230 of them —
 * `GLOB_SCALE` is "view dependent, do not use in parameter/property scripts" —
 * and its availability matrix says which. That matrix only ever *removes*
 * scripts here: it covers five columns and says nothing about the master or
 * migration scripts, and a hand-narrowed entry in `data/keywords.gdl` must not
 * be widened again by a guide that is one Archicad version behind.
 *
 * Without the GRAPHISOFT extension installed there is no matrix, and the
 * keyword table's own answer stands.
 */
export function validScripts(kw: GdlKeyword): readonly ScriptKind[] {
	const excluded = referenceDoc(kw.name)?.excludedScripts;
	if (!excluded?.length) return kw.scripts;
	return kw.scripts.filter((script) => !excluded.includes(script));
}

/** True when `kw` may legally appear in `script`. */
export function isValidIn(kw: GdlKeyword, script: ScriptKind): boolean {
	return validScripts(kw).includes(script);
}

/** Every keyword usable in a given script, for completion. */
export function keywordsFor(script: ScriptKind | undefined): readonly GdlKeyword[] {
	if (script === undefined) return KEYWORDS;
	return KEYWORDS.filter((kw) => isValidIn(kw, script));
}

/**
 * The kinds of name an author may not claim for a variable, and how each is
 * described when one is reported.
 *
 * The guide's rule (§ GDL Syntax, Identifiers) names keywords *and* globals:
 * "Keywords and global variable names are determined by the program you're
 * using GDL in; all other identifiers can be used as variable names." It
 * contradicts itself on the globals a page later — "By using the `=` command,
 * you can assign a numeric or string value to local and global variables" —
 * and real code sides with the looser reading, GRAPHISOFT's own ACLib included.
 * So only the keyword kinds are held against an author here; see
 * `providers/reservedNames.ts` for the corpus behind that split.
 */
const VARIABLE_NAME_CONFLICTS: Readonly<Partial<Record<KeywordKind, string>>> = {
	statement: 'command',
	function: 'function',
	operator: 'operator',
};

/** How a conflicting keyword is described in prose, e.g. "command". */
export function keywordKindLabel(kw: GdlKeyword): string | undefined {
	return VARIABLE_NAME_CONFLICTS[kw.kind];
}

/**
 * The keyword `name` collides with, or undefined when the name is the author's
 * to use. One account of which names are off limits, read by the reserved-name
 * diagnostic and by rename's refusal to hand one out as a new name.
 *
 * A dotted identifier is a path into a dictionary — `pt.start`, `_d.f` — and
 * only its head names a variable, so that is the half looked up. The table's
 * own dotted entries are all `Builtin.*` properties, which are never judged.
 */
export function reservedForVariables(name: string): GdlKeyword | undefined {
	const head = name.split('.')[0];
	if (!head) return undefined;
	const kw = lookupWithVariants(head);
	return kw && keywordKindLabel(kw) ? kw : undefined;
}

/** True when `name` may not be used for a variable. */
export function isReservedName(name: string): boolean {
	return reservedForVariables(name) !== undefined;
}
