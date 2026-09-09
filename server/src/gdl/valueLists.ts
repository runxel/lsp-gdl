/**
 * The values a name may legitimately take, and what each of them means.
 *
 *     IF GLOB_VIEW_TYPE = |            →  2 (2D Floor Plan), 3 (3D), 4 (Section)…
 *     IF iMarkerDir = |                →  DIRVALUES_PERPEND (Senkrecht zur…)…
 *
 * This is the question no grammar can answer and no keyword list holds: a bare
 * `3` in a script says nothing, and the author has to leave the editor to find
 * out which view type it is. Both halves of the answer are already on the
 * machine — one in the reference guide, one in the object's own parameter
 * script — and this module reads them into one shape.
 *
 * ## The guide, for globals and fixed parameters
 *
 * 89 of the guide's pages enumerate their values, and `referenceDocs.ts`
 * already parses the block they sit in — hover has been showing them as prose
 * all along. They arrive in two spellings, and both are real:
 *
 *     GLOB_VIEW_TYPE     one detail paragraph per value: `2 - 2D (Floor Plan)`
 *     GLOB_CONTEXT       one paragraph holding the lot: `1 - library part
 *                        editor, 2 - floor plan, …`, and often with a sentence
 *                        of prose in front of the first and behind the last
 *
 * Across the corpus, 1818 sites compare a `GLOB_*` or `AC_*` name against a
 * numeric literal, and 1270 of them are on a name the guide enumerates.
 *
 * ## The object's own parameter script
 *
 * `VALUES` is how a library part restricts a parameter, so it *is* the list of
 * legal values — and `VALUES{2}` gives each one a caption written by the
 * author, in the author's language:
 *
 *     values{2} "dk_panel_folding_nmbr" 0, `stumpf`, 1, `einfach`, 2, `zweifach`
 *
 * Four spellings occur, and only the first is self-explanatory. The rest name
 * their value with a constant and their caption with a table lookup — GDL
 * having neither enums nor constants, this is what library code does instead:
 *
 *     0, `stumpf`                              184 corpus statements
 *     DIRVALUES_PERPEND, stMarkerDirValues[1]  160
 *     SIZE_LIST, `Liste`                        51
 *     aMidGeometry, sMidGeometry                74   ← two whole tables
 *
 * The constant is the part that matters. `DIRVALUES_PERPEND` is what belongs in
 * the script — the number behind it is an implementation detail the author
 * deliberately hid — so that is what is offered, with the resolved caption as
 * its meaning. `literals.ts` does the resolving and refuses whenever it cannot
 * be sure; an unresolved caption costs the meaning, never the value itself.
 *
 * The two-whole-tables spelling is the one shape `literals.ts` cannot index,
 * every subscript in it being a running counter:
 *
 *     aMidGeometry[i] = GEOM_REVOLVED : sMidGeometry[i] = `Gedreht` : i = i + 1
 *
 * It needs no arithmetic though, only agreement: the tables are filled in step,
 * so the k-th value goes with the k-th caption. `pairTables` takes that pairing
 * only when both tables have the same number of fills *and* every one of them
 * repeats the same subscript, which is what says they were written in step
 * rather than merely both existing.
 */

import type { GdlDocument, Statement } from './analyzer';
import type { Token } from './lexer';
import { referenceDoc } from './referenceDocs';
import { libPartFor } from './libpart';
import { sharedScriptsFor, type TextResolver } from './masterScript';
import { literalScope, foldInScope, stringValue, type ArrayFill, type LiteralScope } from './literals';
import { splitArguments } from './arguments';
import { CLAUSE_STARTERS } from './indirect';

/** One value a name may take. */
export interface EnumValue {
	/** The spelling to write in the script — a constant name, number or string. */
	readonly insert: string;
	/** What it means, when that could be established with confidence. */
	readonly meaning?: string;
	/** The number behind it, where one is known. Orders the list. */
	readonly numeric?: number;
}

export interface ValueSet {
	readonly values: readonly EnumValue[];
	/** `guide` for the reference documentation, `values` for the object's own list. */
	readonly source: 'guide' | 'values';
}

// ---------------------------------------------------------------------------
// The reference guide
// ---------------------------------------------------------------------------

/**
 * `N - description`, either opening the paragraph or following a comma, colon
 * or full stop — the three ways the guide runs a lead-in sentence into its list
 * (`Cut type of the lower edge: 0 - Vertical, 1 - Perpendicular`).
 *
 * The dash may be unspaced (`0-no, 1-yes`), so the description is allowed to
 * start with a digit — `1 - 2D script` is a real entry — and a description that
 * is *nothing but* a number is thrown out below, which is what keeps a written
 * range such as `0 - 1` from reading as a value.
 */
const VALUE_RE = /(?:^|[,:.]\s*)(-?\d+)\s*[-–]\s*(?=\S)/g;

/** Longer than this and it is prose that happened to follow a number. */
const MAX_MEANING = 90;

/**
 * Trims the prose the guide sometimes puts after the final value —
 * `46 - generating as an operator from a list. See the section called …`.
 *
 * Only a full stop that closes a sentence counts: one followed by a capital, or
 * by nothing at all. `e.g. two` and `0.5` are left alone.
 */
function untilSentenceEnd(text: string): string {
	const end = /\.(\s+[A-Z“(]|\s*$)/.exec(text);
	return (end ? text.slice(0, end.index) : text).trim();
}

/**
 * A subscript anywhere on the page, which marks the whole of it as describing
 * the *columns* of an array rather than the values of one thing.
 *
 * These pages carry several enumerations, one per column, and nothing but the
 * column number tells them apart:
 *
 *     [n][2] - edge type starting from node
 *       0 - leading … 1 - trailing … -1 - closing
 *     [n][3] - visibility of the edge (1 - visible, 0 - omitted)
 *
 * Read flat that is two unrelated lists run together under one name, and the
 * duplicate rule below stops on whichever column happens to come first — so
 * `WALL_SKINS_PARAMS` offered its *core status* column as though it were the
 * array's own values. Judging paragraph by paragraph cannot see the difference,
 * since the values arrive in paragraphs of their own with no bracket in them;
 * only the page as a whole shows it. There is no scalar here to complete anyway
 * — every one of these names is read a column at a time.
 */
const COLUMN_RE = /\[\s*\w+\s*\]/;

/** The values one detail paragraph enumerates. */
function valuesInParagraph(text: string): EnumValue[] {
	const marks = [...text.matchAll(VALUE_RE)];
	const values: EnumValue[] = [];

	for (let i = 0; i < marks.length; i++) {
		const mark = marks[i];
		const from = mark.index + mark[0].length;
		const to = i + 1 < marks.length ? marks[i + 1].index : text.length;
		const meaning = untilSentenceEnd(text.slice(from, to).replace(/,\s*$/, ''));

		// A description that is only a number is a written range (`0 - 1`), and
		// an over-long one is a sentence this pattern happened to land in.
		if (!meaning || meaning.length > MAX_MEANING || /^[\d.]+$/.test(meaning)) return [];

		values.push({ insert: mark[1], meaning, numeric: Number(mark[1]) });
	}
	return values;
}

/**
 * The values the reference guide documents for `name`.
 *
 * Every paragraph of the page is read, since the itemized spelling puts one
 * value in each; a paragraph that enumerates nothing simply contributes
 * nothing, which is how the guide's closing advice ("Use the exact needed
 * values…") stays out of the list.
 *
 * **The version history is not read**, and both halves of that matter. 90 pages
 * carry a `Compatibility:` paragraph saying what a value used to mean, and
 * reading one costs more than it gives — `CWFRAME_CLASS` would offer AC21's
 * `1 - transom` beside today's `3 - other`. So a paragraph opening on that word
 * ends the page.
 *
 * **A repeated value ends the list** as well, which catches the same history
 * written as an aside rather than a paragraph:
 *
 *     … 0 - not flipped, 1 - flipped. (old meaning: 0 - Right, 1 - Left)
 *
 * The current meaning is always written first, so what stands before the repeat
 * is what this version of Archicad does. Discarding the whole page instead —
 * the first rule tried — lost `CWFRAME_POSITION` and `AC_CON_WALL_DIRECTION_TYPE`
 * to their own changelogs.
 */
export function documentedValues(name: string): EnumValue[] {
	const doc = referenceDoc(name);
	if (!doc) return [];

	if (doc.details.some((paragraph) => COLUMN_RE.test(paragraph))) return [];

	const values: EnumValue[] = [];
	const seen = new Set<number>();
	for (const paragraph of doc.details) {
		if (/^Compatibility\b/i.test(paragraph)) break;
		for (const value of valuesInParagraph(paragraph)) {
			if (seen.has(value.numeric ?? NaN)) return values.length >= 2 ? values : [];
			seen.add(value.numeric ?? NaN);
			values.push(value);
		}
	}
	return values.length >= 2 ? values : [];
}

// ---------------------------------------------------------------------------
// The object's own VALUES statements
// ---------------------------------------------------------------------------

/** Variant suffix, as in `VALUES{2}`. */
const VARIANT_RE = /\{(\d+)\}$/;

/**
 * Sub-clauses of a value list that are not values.
 *
 * `RANGE` bounds an interval rather than listing anything, `CUSTOM` says the
 * user may type their own, and the two mask clauses filter an attribute
 * chooser. All four are written after the discrete values, so everything from
 * the first of them on is dropped.
 */
const NOT_A_VALUE = new Set(['range', 'custom', 'filltypes_mask', 'profiletypes_mask']);

/** A run of tokens rendered as source, which is what gets inserted. */
function sourceOf(toks: readonly Token[]): string {
	return toks.map((t) => t.text).join('');
}

/**
 * The value spelling to offer for an argument, or undefined when it is not one
 * thing that can be written down.
 *
 * A lone token is the whole of it in practice — a number, a string, or the
 * constant that is the point of the exercise — with a signed number the one
 * two-token shape that occurs.
 */
function valueSpelling(toks: readonly Token[]): string | undefined {
	if (toks.length === 1 && (toks[0].type === 'number' || toks[0].type === 'string')) return toks[0].text;
	if (toks.length === 1 && toks[0].type === 'identifier') return toks[0].text;
	if (toks.length === 2 && toks[0].type === 'operator' && toks[0].text === '-' && toks[1].type === 'number') {
		return sourceOf(toks);
	}
	return undefined;
}

/**
 * The caption an argument names, resolved as far as it honestly can be.
 *
 * A literal answers for itself. Anything else is a name the script filled in
 * elsewhere — a scalar, or a slot of a table picked out by a constant — and
 * `literals.ts` answers only where it is sure.
 */
function captionOf(toks: readonly Token[], scope: LiteralScope): string | undefined {
	const literal = toks.length === 1 ? stringValue(toks[0]) : undefined;
	if (literal !== undefined) return literal;

	if (toks.length === 1 && toks[0].type === 'identifier') return scope.stringOf(toks[0].lower);

	// `stMarkerDirValues[1]`, and `str_myenum[ENUM_1]` — the subscript is itself
	// routinely a constant, which is why it is folded in scope rather than flat.
	if (toks.length >= 4 && toks[0].type === 'identifier' && toks[1].text === '[' && toks[toks.length - 1].text === ']') {
		const at = foldInScope(toks.slice(2, -1), scope);
		if (at !== undefined) return scope.stringAt(toks[0].lower, at);
	}
	return undefined;
}

/** Builds one offering from a value expression and, for `VALUES{2}`, its caption. */
function toValue(value: readonly Token[], caption: readonly Token[] | undefined, scope: LiteralScope): EnumValue | undefined {
	const insert = valueSpelling(value);
	if (insert === undefined) return undefined;

	const meaning = caption ? captionOf(caption, scope) : undefined;
	// The number behind a constant is worth knowing even though it is not what
	// gets written — it is how the list is ordered, and it answers the question
	// a reader of the old code will have.
	const numeric =
		value.length === 1 && value[0].type === 'identifier' ? scope.numberOf(value[0].lower) : Number(insert);

	return {
		insert,
		...(meaning ? { meaning } : {}),
		...(numeric !== undefined && Number.isFinite(numeric) ? { numeric } : {}),
	};
}

/**
 * Pairs two whole tables filled in step —
 * `values{2} "iMidGeometry" aMidGeometry, sMidGeometry`.
 *
 * The subscripts are running counters, so nothing here folds: the guarantee
 * comes from the two tables having the same number of fills and repeating the
 * same subscript at each of them, which is what an author writing the pair on
 * one line produces and what an unrelated pair of arrays does not.
 */
function pairTables(values: readonly ArrayFill[], captions: readonly ArrayFill[], scope: LiteralScope): EnumValue[] {
	if (values.length === 0 || values.length !== captions.length) return [];
	if (values.some((fill, i) => fill.subscript !== captions[i].subscript)) return [];

	const paired: EnumValue[] = [];
	for (let i = 0; i < values.length; i++) {
		const value = toValue(values[i].value, captions[i].value, scope);
		if (!value) return [];
		paired.push(value);
	}
	return paired;
}

/** True when the argument is a bare name, the shape a whole table arrives as. */
function tableName(toks: readonly Token[]): string | undefined {
	return toks.length === 1 && toks[0].type === 'identifier' ? toks[0].lower : undefined;
}

/**
 * The values one `VALUES` statement lists, or an empty array when it lists none
 * this server can read.
 */
function valuesInStatement(stmt: Statement, scope: LiteralScope): EnumValue[] {
	const head = stmt.head;
	if (!head || head.replace(VARIANT_RE, '') !== 'values') return [];
	const paired = VARIANT_RE.exec(head)?.[1] === '2';

	const args = splitArguments(stmt).map((arg) => arg.tokens);
	if (args.length === 0) return [];

	// The comma after the parameter name is optional, so the first argument may
	// carry the name *and* the first value. `paramNames.ts` reads the same
	// syntax line from the other end.
	const first = args[0];
	if (first[0]?.type !== 'string') return [];
	const rest = first.length > 1 ? [first.slice(1), ...args.slice(1)] : args.slice(1);

	// Everything from the first sub-clause on, and anything after a clause
	// keyword — `IF a THEN VALUES "s" 1 ELSE VALUES "s" 2` is one statement.
	const listed: (readonly Token[])[] = [];
	for (const arg of rest) {
		const lead = arg[0];
		if (!lead) break;
		if (lead.type === 'identifier' && (NOT_A_VALUE.has(lead.lower) || CLAUSE_STARTERS.has(lead.lower))) break;
		listed.push(arg);
	}
	if (listed.length === 0) return [];

	// A list that is nothing but bare names is the whole-table spelling: one
	// table of values, or — for `{2}` — a table of values and a table of
	// captions. It is told from an ordinary one-pair list (`SIZE_LIST,
	// \`Liste\`') by the script actually filling the names as tables; a pair of
	// plain constants falls through to the element reading below.
	const names = listed.map(tableName);
	const fills = names.map((name) => (name ? scope.fillsOf(name) : []));

	if (paired && listed.length === 2 && fills[0].length && fills[1].length) {
		// Both are tables, so this statement says nothing element by element.
		// If they were not filled in step we cannot pair them, and a guess here
		// would offer the table's own name as though it were a value.
		return pairTables(fills[0], fills[1], scope);
	}
	if (!paired && listed.length === 1 && fills[0].length) {
		const table = fills[0].map((fill) => toValue(fill.value, undefined, scope));
		return table.every((value) => value) ? (table as EnumValue[]) : [];
	}

	const values: EnumValue[] = [];
	for (let i = 0; i < listed.length; i += paired ? 2 : 1) {
		const caption = paired ? listed[i + 1] : undefined;
		// A `{2}` list with an odd tail is half-written; the values still stand.
		const value = toValue(listed[i], caption, scope);
		if (value) values.push(value);
	}
	return values;
}

/** Every parameter the scripts in scope restrict, and to what. */
function buildIndex(docs: readonly GdlDocument[]): Map<string, EnumValue[]> {
	const scope = literalScope(docs);
	const index = new Map<string, EnumValue[]>();
	const seen = new Map<string, Set<string>>();

	for (const script of docs) {
		for (const stmt of script.statements) {
			if (!stmt.head?.startsWith('values')) continue;
			const named = stmt.tokens[1];
			if (named?.type !== 'string') continue;
			const key = stringValue(named)?.toLowerCase();
			if (!key) continue;

			let values = index.get(key);
			if (!values) {
				values = [];
				index.set(key, values);
				seen.set(key, new Set());
			}
			// A parameter is often restricted twice, in either arm of an `IF`.
			// Both lists are legal values; the first caption for a value wins.
			const already = seen.get(key)!;
			for (const value of valuesInStatement(stmt, scope)) {
				const spelling = value.insert.toLowerCase();
				if (already.has(spelling)) continue;
				already.add(spelling);
				values.push(value);
			}
		}
	}
	return index;
}

/**
 * The index, kept until one of the scripts behind it changes.
 *
 * Completion runs on a keystroke, so the shape of the cost matters. Measured on
 * `Generic_panel_macro`, the corpus's largest part at 3800 statements across the
 * three scripts in scope: the first lookup costs ~99ms, nearly all of it reading
 * and analysing the two sibling scripts, and `masterScript.ts` then holds those.
 * After that a keystroke costs ~1.8ms, of which the scan here is ~1ms.
 *
 * So this is not what makes the feature usable — it was already usable — but
 * every parameter is indexed in one pass instead of one pass per parameter, and
 * an edit elsewhere in the part costs nothing at all. Keyed on the document
 * being edited and invalidated by comparing the texts, as `masterScript.ts`
 * does with its analyses.
 */
const indexCache = new Map<string, { texts: readonly string[]; index: Map<string, EnumValue[]> }>();

/**
 * The values the library part itself allows for `parameter`.
 *
 * Scope is the current document plus the scripts that run across the whole
 * part, which is where `VALUES` is written — `masterScript.ts` decides which
 * those are, and it is the same scope a rename of a shared name uses.
 */
export function declaredValues(parameter: string, doc: GdlDocument, resolve: TextResolver): EnumValue[] {
	const docs = [doc, ...sharedScriptsFor(doc.uri, resolve)];
	const texts = docs.map((d) => d.text);

	const cached = indexCache.get(doc.uri);
	const index =
		cached && cached.texts.length === texts.length && cached.texts.every((text, i) => text === texts[i])
			? cached.index
			: buildIndex(docs);
	if (index !== cached?.index) indexCache.set(doc.uri, { texts, index });

	return index.get(parameter.toLowerCase()) ?? [];
}


// ---------------------------------------------------------------------------
// Putting the two together
// ---------------------------------------------------------------------------

/**
 * The values `name` may take, from whichever source knows.
 *
 * The object's own `VALUES` wins where it has one: a fixed parameter such as
 * `AC_SYMB_DISPLAY_OPTION` is documented by the guide *and* frequently
 * restricted further by the part, and the part is the more specific answer.
 */
export function valuesFor(name: string, doc: GdlDocument, resolve: TextResolver): ValueSet | undefined {
	const libpart = libPartFor(doc.uri);
	if (libpart?.parameters.has(name.toLowerCase())) {
		const declared = declaredValues(name, doc, resolve);
		if (declared.length) return { values: declared, source: 'values' };
	}

	const documented = documentedValues(name);
	return documented.length ? { values: documented, source: 'guide' } : undefined;
}

// ---------------------------------------------------------------------------
// Where the cursor has to be
// ---------------------------------------------------------------------------

/**
 * Operators after which a value of the left-hand name is expected.
 *
 * Equality and its negations only. The guide is explicit that a range test on
 * an enumeration is the wrong shape — "Use the exact needed values. Using
 * ranges are not recommended due to possible future value extensions" — so
 * offering a list after `<` would be advising against the documentation.
 */
const VALUE_OPERATORS = new Set(['=', '<>', '#']);

/** Only whitespace, or a continuation, may stand between the operator and the cursor. */
const GAP_RE = /^[ \t]*(?:\\[ \t]*(?:\r\n|\r|\n)[ \t]*)*$/;

/**
 * The name whose value is being written at `offset`, if the cursor is in such a
 * place at all.
 *
 *     IF GLOB_VIEW_TYPE = |          →  GLOB_VIEW_TYPE
 *     IF a = 1 & iMarkerDir <> DIR|  →  iMarkerDir
 *     count = |                      →  count
 *
 * The left-hand side may be subscripted (`pen[1] = |`), an array parameter
 * being addressed one element at a time; the head of that path is the name.
 */
export function valueNameAt(doc: GdlDocument, offset: number): string | undefined {
	const stmt = statementAround(doc, offset);
	if (!stmt) return undefined;

	const toks = stmt.tokens;
	let i = toks.length - 1;
	while (i >= 0 && toks[i].start >= offset) i--;
	if (i < 0) return undefined;

	// The word being typed is not yet an operand — `= DIR|` is still a value
	// position — so step over it and judge what stands in front.
	const last = toks[i];
	if (last.end >= offset && (last.type === 'identifier' || last.type === 'number')) i--;
	else if (!GAP_RE.test(doc.text.slice(last.end, offset))) return undefined;

	const operator = toks[i];
	if (operator?.type !== 'operator' || !VALUE_OPERATORS.has(operator.text)) return undefined;

	// Walk back over the left-hand path to its head identifier, stepping over as
	// many subscripts as it carries — `WALL_SKINS_PARAMS[i][6]` has two.
	let j = i - 1;
	while (toks[j]?.type === 'operator' && toks[j].text === ']') {
		let depth = 0;
		for (; j >= 0; j--) {
			if (toks[j].type !== 'operator') continue;
			if (toks[j].text === ']') depth++;
			else if (toks[j].text === '[') {
				depth--;
				if (depth === 0) break;
			}
		}
		if (j < 0) return undefined;
		j--;
	}

	const name = toks[j];
	if (name?.type !== 'identifier' || CLAUSE_STARTERS.has(name.lower)) return undefined;
	return name.text;
}

/** The statement the cursor sits in or immediately after. */
function statementAround(doc: GdlDocument, offset: number): Statement | undefined {
	let found: Statement | undefined;
	for (const stmt of doc.statements) {
		if (stmt.start > offset) break;
		found = stmt;
	}
	return found;
}
