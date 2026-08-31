/**
 * Jump labels — GDL's subroutines.
 *
 * A label is a lone number or string terminated by a colon, and `GOSUB` /
 * `GOTO` name it back:
 *
 *     gosub "draw handle"
 *     end
 *     "draw handle":
 *         block 0.02, 0.02, 0.1
 *     return
 *
 * This module is the model both features over labels share: the diagnostic in
 * `providers/labels.ts`, which reports a jump that answers to nothing, and
 * rename, which is the reason the model has to find every *site* rather than
 * merely resolve a key.
 *
 * A site is one of three things, and missing the third breaks objects:
 *
 *   - a **definition**, `"draw handle":`
 *   - a **jump**, `GOSUB "draw handle"`
 *   - an **alias**, `_substr = "EndBlock"` for a variable the script elsewhere
 *     jumps to — `GOSUB _substr`. The statement naming the label mentions no
 *     jump keyword at all, exactly as a group name reached through a variable
 *     does; `indirect.ts` holds the rules both obey. The corpus has 25 of
 *     these against 130 variable-target jumps, `Euro-Palette AOL/3d.gdl`
 *     (`_substr = "EndBlock"`) and `Dämmkeil 2D/2d.gdl`
 *     (`INSU_METHOD = "Draw_Spline"`) among them.
 *
 * Scope, confirmed with the project owner: a jump reaches **its own script plus
 * the master script**, which runs ahead of every other and so contributes its
 * subroutines to all of them. Sibling scripts are independent, as variables
 * are. The corpus agrees without exception — across 2455 scripts not one jump
 * names a label defined only in a sibling, and not one alias crosses a script
 * boundary either.
 *
 * **Only a lone literal is a site.** The guide calls the label a string or
 * numeric *expression* and real code takes it at its word: `GOSUB 10 + idx`,
 * `GOSUB i_type * 10`, `GOSUB "fixing" + STR (i, 1, 0)`, `GOSUB _subid[i]`.
 * 210 of the corpus's 9158 jumps are computed like that and none is knowable
 * without running the script, so they are left alone — as an unresolvable name
 * is everywhere else in this server.
 */

import type { GdlDocument, Statement } from './analyzer';
import type { Token } from './lexer';
import { forEachLiteralAssignment, isOperator } from './indirect';

/** How a label is spelt. Both are legal targets of the same `GOSUB`. */
export type LabelSpelling = 'named' | 'numeric';

/** What a site does with the name. */
export type LabelSiteKind = 'definition' | 'jump' | 'alias';

/**
 * A label as written at its definition site.
 *
 * `name` is the spelling; `key` is what a jump matches, so two definitions
 * sharing a key are two subroutines behind one name — see `labelDefinitions`.
 */
export interface LabelDefinition {
	readonly key: string;
	/** The name as written, quotes stripped. */
	readonly name: string;
	readonly spelling: LabelSpelling;
	readonly token: Token;
}

export interface LabelSite {
	readonly kind: LabelSiteKind;
	readonly spelling: LabelSpelling;
	/** The key both sides agree on — see `labelKey`. */
	readonly key: string;
	/** The token spelling it: quotes included, for a named label. */
	readonly token: Token;
}

const JUMPS = new Set(['gosub', 'goto']);

const NUMERIC_RE = /^\d+(\.\d+)?$/;

/**
 * A label key both sides agree on.
 *
 * Names are matched case-insensitively, as everything in GDL is, and numeric
 * labels by value — so `0100:` answers `GOSUB 100`.
 */
export function labelKey(raw: string): string {
	const n = Number(raw);
	return NUMERIC_RE.test(raw) && Number.isFinite(n) ? String(n) : raw.toLowerCase();
}

/** The name a label token spells, quotes stripped. */
export function labelName(tok: Token): string {
	return tok.type === 'string' ? tok.text.slice(1, -1) : tok.text;
}

function spellingOf(tok: Token): LabelSpelling {
	return tok.type === 'number' ? 'numeric' : 'named';
}

/**
 * The label a jump names, or undefined when it cannot be resolved statically.
 *
 * `toks[i]` is the `GOSUB` or `GOTO`; the target is what follows it.
 */
export function jumpTarget(toks: readonly Token[], i: number): Token | undefined {
	const target = toks[i + 1];
	if (!target) return undefined;
	if (target.type === 'string') {
		if (target.unterminated) return undefined;
	} else if (target.type !== 'number') {
		// A variable or anything else computed — `GOSUB _subid[i]`.
		return undefined;
	}

	// An operator after the literal means it is one term of an expression:
	// `GOSUB 100 + 10 * markerStyle`. Only a target standing on its own is
	// judged; a following keyword (`... THEN GOSUB "x" ELSE ...`) is fine.
	const after = toks[i + 2];
	if (after?.type === 'operator') return undefined;

	return target;
}

/** True where this statement is a label definition: `100:` or `"tapPage":`. */
function definitionToken(stmt: Statement): Token | undefined {
	const toks = stmt.tokens;
	if (toks.length !== 2 || !isOperator(toks[1], ':')) return undefined;
	const first = toks[0];
	if (first.type !== 'number' && first.type !== 'string') return undefined;
	if (first.type === 'string' && first.unterminated) return undefined;
	return first;
}

/**
 * Every jump in one statement, target or not.
 *
 * A jump sits anywhere in a statement, not only at its head —
 * `IF gs_tap_type_m <> -1 THEN GOSUB "a" ELSE GOSUB "b"` holds two — so every
 * token is walked, as in `groups.ts`.
 */
function forEachJump(
	doc: GdlDocument,
	stmt: Statement,
	visit: (keyword: Token, target: Token | undefined, targetIndex: number) => void,
): void {
	const toks = stmt.tokens;
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i];
		if (tok.type !== 'identifier' || !JUMPS.has(tok.lower)) continue;
		// A user variable shadowing the keyword is not a jump.
		if (doc.variables.has(tok.lower)) continue;
		visit(tok, jumpTarget(toks, i), i + 1);
	}
}

/**
 * Variables the script jumps through — `GOSUB _substr`. Only the head of the
 * target counts, `GOSUB _subid[type_head_1]` reaching a whole table of them.
 */
function jumpVariables(doc: GdlDocument): Set<string> {
	const vars = new Set<string>();
	for (const stmt of doc.statements) {
		forEachJump(doc, stmt, (_keyword, _target, index) => {
			const tok = stmt.tokens[index];
			if (tok?.type === 'identifier') vars.add(tok.lower);
		});
	}
	return vars;
}

/**
 * Every label site in one script, in source order.
 *
 * This cannot be done a statement at a time: whether `_substr = "EndBlock"`
 * names a label depends on a `GOSUB _substr` that may come further down.
 */
export function labelSites(doc: GdlDocument): LabelSite[] {
	const sites: LabelSite[] = [];
	const vars = jumpVariables(doc);

	for (const stmt of doc.statements) {
		const definition = definitionToken(stmt);
		if (definition) {
			sites.push({
				kind: 'definition',
				spelling: spellingOf(definition),
				key: labelKey(labelName(definition)),
				token: definition,
			});
			continue;
		}

		forEachJump(doc, stmt, (_keyword, target) => {
			if (!target) return;
			const name = labelName(target);
			if (name === '') return;
			sites.push({
				kind: 'jump',
				spelling: spellingOf(target),
				key: labelKey(name),
				token: target,
			});
		});

		if (vars.size) {
			forEachLiteralAssignment(
				stmt,
				(head) => vars.has(head),
				(value, key) => sites.push({ kind: 'alias', spelling: 'named', key, token: value }),
			);
		}
	}

	return sites;
}

/**
 * Every label definition in one script, in source order — **including repeats**.
 *
 * `GdlDocument.labels` keeps only the first definition of each name, which is
 * the one a jump resolves against; this reports the definition sites
 * themselves, so a script's second `"draw handle":` is visible to the check
 * that flags it.
 */
export function labelDefinitions(doc: GdlDocument): LabelDefinition[] {
	const definitions: LabelDefinition[] = [];
	for (const stmt of doc.statements) {
		const token = definitionToken(stmt);
		if (!token) continue;
		const name = labelName(token);
		definitions.push({ key: labelKey(name), name, spelling: spellingOf(token), token });
	}
	return definitions;
}

/** Every site naming one label, definitions, jumps and aliases alike. */
export function labelSitesFor(doc: GdlDocument, key: string): LabelSite[] {
	return labelSites(doc).filter((site) => site.key === key);
}

/**
 * The label site under `offset`, if the cursor is on one. A string is only a
 * site where GDL reads it as a label — a `TEXT2 0, 0, "draw handle"` elsewhere
 * in the script is prose, however exactly it matches.
 */
export function labelSiteAt(doc: GdlDocument, offset: number): LabelSite | undefined {
	return labelSites(doc).find((site) => offset >= site.token.start && offset <= site.token.end);
}

/** The keys of the labels this script defines. */
export function labelDefinitionKeys(doc: GdlDocument): Set<string> {
	return new Set(labelDefinitions(doc).map((definition) => definition.key));
}
