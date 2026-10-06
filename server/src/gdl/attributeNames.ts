/**
 * Inline attributes — the styles, materials, fills and line types a script
 * defines for itself with `DEFINE`, and the commands that pick them up by name.
 *
 *     DEFINE STYLE "Label" "Arial", 2, 5, 0         ! master script
 *     …
 *     SET STYLE "Label"                              ! 2D script
 *
 * The name is a string, so nothing ties the two together but the spelling, and
 * the `DEFINE` is usually in another file: the guide has a master script's
 * inline attributes reaching every script after it, which is why a part's
 * styles are nearly always written there.
 *
 * **Which commands.** The `[SET] <kind>` forms only — `STYLE`, `MATERIAL`,
 * `FILL`, `LINE_TYPE`, with or without `SET` — at the head of a clause, the
 * walk restarting at `THEN`/`ELSE`. Those are the commands whose argument is a
 * name and nothing else. Each takes its name from a family of `DEFINE`s:
 * `DEFINE STYLE{2}` is as much a style as `DEFINE STYLE`, and a fill may come
 * from any of nine. `BUILDING_MATERIAL` has no `DEFINE` and is not here.
 *
 * **The name is spelt two ways**, as `attributes.ts` records: a string literal,
 * and a bare identifier standing for the string (`DEFINE STYLE lsg_tStyleName`
 * … `SET STYLE lsg_tStyleName`), 317 corpus sites. Either spelling matches
 * either, case-insensitively.
 *
 * Only a lone name is judged. `STYLE textstyles[i]` and `STYLE "t_" + n` are
 * computed, and unknowable without running the script.
 */

import type { GdlDocument } from './analyzer';
import type { Token } from './lexer';
import { clauseStarts } from './assignments';

/** The attribute kinds with an inline definition, and the `DEFINE`s that make one. */
const DEFINITIONS: Readonly<Record<string, readonly string[]>> = {
	style: ['style', 'style{2}'],
	material: ['material'],
	fill: [
		'fill',
		'filla',
		'symbol_fill',
		'solid_fill',
		'empty_fill',
		'linear_gradient_fill',
		'radial_gradient_fill',
		'translucent_fill',
		'image_fill',
	],
	line_type: ['line_type', 'symbol_line'],
};

/** `DEFINE` keyword → attribute kind. */
const KIND_OF_DEFINITION = new Map(
	Object.entries(DEFINITIONS).flatMap(([kind, defines]) => defines.map((d) => [d, kind] as const)),
);

/** One place an inline attribute is named. */
export interface AttributeName {
	/** `style`, `material`, `fill` or `line_type`. */
	readonly kind: string;
	/** Lower-cased name: a literal's contents, or the identifier. */
	readonly key: string;
	/** The token spelling it — quotes included, for a literal. */
	readonly token: Token;
}

function isWord(tok: Token | undefined, word: string): boolean {
	return tok?.type === 'identifier' && tok.lower === word;
}

/** The name a lone string or identifier spells, or undefined for anything else. */
function nameOf(tok: Token | undefined, after: Token | undefined): string | undefined {
	if (!tok) return undefined;
	// A subscript, a member or an operator makes it computed.
	if (after && after.type === 'operator' && after.text !== ',') return undefined;
	if (tok.type === 'string' && !tok.unterminated) return tok.text.slice(1, -1).toLowerCase();
	if (tok.type === 'identifier') return tok.lower;
	return undefined;
}

/** Every `DEFINE <kind> name` in the script, in source order. */
export function attributeDefinitions(doc: GdlDocument): AttributeName[] {
	const found: AttributeName[] = [];
	for (const stmt of doc.statements) {
		const toks = stmt.tokens;
		for (const start of clauseStarts(toks)) {
			if (!isWord(toks[start], 'define')) continue;
			const kind = KIND_OF_DEFINITION.get(toks[start + 1]?.lower ?? '');
			const token = toks[start + 2];
			const key = kind && nameOf(token, undefined);
			if (kind && key) found.push({ kind, key, token });
		}
	}
	return found;
}

/** The attribute name a `[SET] <kind> name` reference spells at `offset`, if any. */
export function attributeReferenceAt(doc: GdlDocument, offset: number): AttributeName | undefined {
	const stmt = doc.statements.find((s) => s.start <= offset && offset <= s.end);
	if (!stmt) return undefined;
	const toks = stmt.tokens;
	for (const start of clauseStarts(toks)) {
		let at = start;
		if (isWord(toks[at], 'set')) at++;
		const kind = toks[at]?.lower ?? '';
		if (toks[at]?.type !== 'identifier' || !(kind in DEFINITIONS)) continue;
		const token = toks[at + 1];
		if (!token || offset < token.start || offset > token.end) continue;
		const key = nameOf(token, toks[at + 2]);
		return key ? { kind, key, token } : undefined;
	}
	return undefined;
}
