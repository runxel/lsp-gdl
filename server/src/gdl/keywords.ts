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
 * Names a GDL author must not use for their own variables. Globals and
 * fixed parameters are effectively reserved: assigning to one silently
 * changes behaviour rather than raising an error.
 */
export function isReservedName(name: string): boolean {
	const kw = byName.get(name.toLowerCase());
	if (!kw) return false;
	return kw.kind === 'global' || kw.kind === 'fixparam' || kw.kind === 'statement';
}
