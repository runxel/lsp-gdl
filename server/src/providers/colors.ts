/**
 * Colour swatches, and the picker behind them.
 *
 * GDL writes a colour as three bare numbers between 0 and 1, and nothing on the
 * line says which colour they are. `0.5284, 0.5989, 0.6167` is a slate blue and
 * reads as three coefficients; `"1 1 1"` is white and reads as a magic string.
 * Two commands spell colours that way and this puts a swatch on both, so the
 * editor's own picker opens on them:
 *
 *     DEFINE MATERIAL "water" 0, 0.5284, 0.5989, 0.6167, …
 *     n = REQUEST ("PEN_OF_RGB", "1 1 1", pen_white)
 *
 * ## What is judged
 *
 * **Only channels folded from literals.** `128 / 255` decodes exactly and
 * `1 + 2 * shade` does not, which is the line `inlayHints.ts` already draws and
 * for the same reason: a swatch is a claim about the colour, and a wrong one
 * sits in the buffer looking like fact. `foldConstant` also declines an
 * imperial number, so the `2'` of an unrelated statement can never read as a
 * channel.
 *
 * **Only a value actually in range.** The guide gives every one of these
 * channels as `[0.0..1.0]`; a number outside that is not a colour this server
 * understands, whatever the engine does with it, so it gets no swatch rather
 * than a clamped one.
 *
 * ## What the picker writes back
 *
 * **The separators are the author's, kept verbatim.** Only the three numbers
 * are rewritten; everything between them is copied out of the source, so a
 * table `format.ts` has aligned stays aligned, and a wrapped list keeps its
 * line breaks — comments and all:
 *
 *     DEFINE MATERIAL "water" 0,
 *         0.5284, 0.5989, 0.6167, ! surface RGB [0.0..1.0]
 *
 * That comment sits *between* two channels of the same colour. Replacing the
 * span with a freshly formatted `r, g, b` would delete it; splicing the numbers
 * into the text that was already there cannot.
 *
 * **A line may not exceed 255 characters**, and a picked colour is nearly
 * always longer than the `0` or `1` it replaces. So the edit is laid out and
 * measured first, and a presentation that would push any line past the limit is
 * not offered at all — the same call `format.ts` makes, for the same reason:
 * Archicad does not truncate an over-long line, it fails the script.
 *
 * ## The indirect spelling
 *
 * `request ("Pen_of_RGB", rgb_white, pen)` reaches the colour through a
 * variable, exactly as `placegroup gr_toplace` reaches a group, and the
 * assignment that supplies it mentions no request at all:
 *
 *     _rgb_white = "1 1 1"                    ! …the swatch goes here
 *     rrr = request ("Pen_of_RGB", _rgb_white, _pen_white)
 *
 * That is where a swatch is worth most — a table of named colours at the top of
 * the script is the thing anyone actually wants to edit — and it is 34 of the
 * corpus's 87 calls. `indirect.ts` already holds the rules for reading such an
 * assignment, so this follows them rather than inventing a second account of
 * the same shape. See `collectIndirectRgb`.
 */

import {
	Color,
	TextEdit,
	type ColorInformation,
	type ColorPresentation,
	type Range,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { GdlDocument, Statement } from '../gdl/analyzer';
import { foldConstant } from '../gdl/arguments';
import { CLAUSE_STARTERS, forEachLiteralAssignment, isOperator } from '../gdl/indirect';
import type { Token } from '../gdl/lexer';

/** Archicad fails a script with a longer line rather than truncating it. */
const MAX_LINE = 255;

/**
 * Six decimals, which is what the corpus already writes — `0.329412`,
 * `0.945098`, `0.670588` are all k/255 to six places. The picker hands back a
 * colour quantised to 8 bits, so six places name every one of them exactly and
 * a colour picked twice does not drift; four places lost 43 of the corpus's 210
 * channels to rounding on the way back in.
 */
const DECIMALS = 6;

/** One colour written in the source, and how to write a new one in its place. */
interface ColorSite {
	readonly color: Color;
	/** Source offsets of the text a picked colour replaces. */
	readonly start: number;
	readonly end: number;
	/** The replacement text, with the author's separators spliced back in. */
	readonly render: (color: Color) => string;
}

export function provideDocumentColors(doc: GdlDocument, td: TextDocument): ColorInformation[] {
	return colorSites(doc).map((site) => ({
		color: site.color,
		range: { start: td.positionAt(site.start), end: td.positionAt(site.end) },
	}));
}

/**
 * What the picker offers for the colour the user landed on.
 *
 * The `label` is the plain, normalised form — that is what the picker prints —
 * while the edit it carries is the faithful one, so the text in the buffer
 * keeps whatever spacing, wrapping or trailing comment it was written with.
 */
export function provideColorPresentations(
	doc: GdlDocument,
	td: TextDocument,
	color: Color,
	range: Range,
): ColorPresentation[] {
	const start = td.offsetAt(range.start);
	const end = td.offsetAt(range.end);

	const site = colorSites(doc).find((s) => s.start === start && s.end === end);
	if (!site) return [];

	const newText = site.render(color);
	if (!fitsLineLimit(doc.text, site, newText)) return [];

	return [
		{
			label: newText.replace(/\s+/g, ' ').trim(),
			textEdit: TextEdit.replace(range, newText),
		},
	];
}

/** Every colour the document spells out, in source order. */
function colorSites(doc: GdlDocument): ColorSite[] {
	const sites: ColorSite[] = [];
	for (const stmt of doc.statements) {
		collectMaterialSurface(doc, stmt, sites);
		collectPenOfRgb(stmt, sites);
	}
	collectIndirectRgb(doc, sites);
	return sites.sort((a, b) => a.start - b.start);
}

/**
 * `DEFINE MATERIAL name [,] type, surface_red, surface_green, surface_blue …`
 *
 * The surface colour is the one part of the command that does not move: the
 * guide gives eighteen material types with argument counts from 3 to 19, and
 * every one of them opens the list with the same RGB triple. So nothing here
 * needs to know the value of `type`, which is just as well — it is as often a
 * constant (`MAT_PLASTIC`) as a number.
 *
 * The later triples do move. `specular` and `emission` exist only for the
 * general types (0, 10, 20) and sit at an offset that depends on which, so
 * reading them means folding `type` first; they are left alone rather than
 * guessed at. See the note in CLAUDE.md.
 *
 * Two shapes are turned away:
 *
 * - **`DEFINE MATERIAL name BASED_ON orig`** is a different command sharing the
 *   first two words. Its arguments are `name = value` pairs, not a colour.
 * - **A name holding a top-level comma.** The guide writes the comma between
 *   name and type as optional, so the two are told apart by whether anything
 *   follows the name in the same argument — which only works while the name is
 *   a single argument itself.
 */
function collectMaterialSurface(doc: GdlDocument, stmt: Statement, sites: ColorSite[]): void {
	const toks = stmt.tokens;

	for (let i = 0; i + 1 < toks.length; i++) {
		if (toks[i].type !== 'identifier' || toks[i].lower !== 'define') continue;
		if (toks[i + 1].type !== 'identifier' || toks[i + 1].lower !== 'material') continue;

		const groups = argumentGroups(toks, i + 2);
		const name = groups[0];
		if (!name?.length) continue;

		// `BASED_ON` may follow the name with or without the comma, so both the
		// tail of the first argument and the head of the second are checked.
		const basedOn = (tok: Token | undefined) => tok?.type === 'identifier' && tok.lower === 'based_on';
		if (name.some(basedOn) || basedOn(groups[1]?.[0])) continue;

		// A lone argument is the name by itself, so `type` is the next one;
		// anything more in it is the name *and* the type, written without the
		// comma the guide marks optional.
		const surfaceAt = name.length === 1 ? 2 : 1;
		const site = channelTriple(doc, groups, surfaceAt);
		if (site) sites.push(site);
	}
}

/**
 * `n = REQUEST ("PEN_OF_RGB", "r g b", penindex)`
 *
 * The colour is inside the string, so the swatch and the edit cover the
 * literal's contents rather than the token — which leaves the quoting alone,
 * and GDL has three quote characters to leave alone.
 */
function collectPenOfRgb(stmt: Statement, sites: ColorSite[]): void {
	forEachPenOfRgb(stmt, (argument) => {
		const literal = argument.length === 1 ? argument[0] : undefined;
		if (literal?.type !== 'string' || literal.unterminated) return;

		const site = rgbString(literal);
		if (site) sites.push(site);
	});
}

/**
 * The colour handed to `PEN_OF_RGB` through a variable.
 *
 *     _rgb_white = "1 1 1"                    ! …the swatch goes here
 *     rrr = request ("Pen_of_RGB", _rgb_white, _pen_white)
 *
 * This is `groups.ts`'s hazard exactly — a name reached through a variable,
 * where the assignment that supplies it mentions no keyword at all — so it is
 * `indirect.ts` that decides what counts as one, and the rules it already
 * carries are the rules here: the target may be a whole path, the assignment
 * must open its clause, only a lone literal counts, and an empty one names
 * nothing.
 *
 * Like `groups.ts` this needs two passes over the *whole* script rather than
 * one statement at a time, because whether `_rgb_white = "1 1 1"` is a colour
 * depends on a `request` that may be a hundred lines further down. The corpus
 * writes exactly that shape: a table of named colours at the top of the script,
 * then the requests that turn them into pens.
 *
 * What keeps it honest beyond `indirect.ts`'s own rules:
 *
 * - **The argument must be a plain path**, so only a variable GDL actually
 *   hands over is tracked. `rgbTxt = STRSUB(redTxt, 1, 1) + "." + …` builds the
 *   string a character at a time in `NURBSGDLTemplate/3d.gdl`, and
 *   `_str_rgb = str(_format, red_r) + " " + …` does the same in `Color Tool
 *   AOL` — neither is a name this can follow, and neither is offered one.
 * - **The literal must still parse as three channels in `[0.0..1.0]`**, which
 *   is what keeps an ordinary string assignment from becoming a swatch.
 *
 * Scope is the current script, as it is for a group: this is a document
 * request, and a swatch that appeared only because a sibling file happened to
 * be on disk would be a strange thing to offer. Every indirect site in the
 * corpus is in the file that requests it.
 */
function collectIndirectRgb(doc: GdlDocument, sites: ColorSite[]): void {
	const named = new Set<string>();
	for (const stmt of doc.statements) {
		forEachPenOfRgb(stmt, (argument) => {
			const head = pathHead(argument);
			if (head) named.add(head);
		});
	}
	if (named.size === 0) return;

	for (const stmt of doc.statements) {
		forEachLiteralAssignment(
			stmt,
			(head) => named.has(head),
			(value) => {
				const site = rgbString(value);
				if (site) sites.push(site);
			},
		);
	}
}

/**
 * Every `REQUEST ("PEN_OF_RGB", <this>, pen)` argument in one statement.
 *
 * The question string is what identifies the call, not the command word, so a
 * `REQUEST{2}` spelling costs nothing to accept: `"PEN_OF_RGB"` in the first
 * argument is the whole tell, and no other request reads a colour this way. A
 * call sits anywhere in a statement — `if found then rrr = request (…)` — so
 * every token is walked, as in `groups.ts` and `labels.ts`.
 */
function forEachPenOfRgb(stmt: Statement, visit: (argument: Token[]) => void): void {
	const toks = stmt.tokens;

	for (let i = 0; i + 1 < toks.length; i++) {
		const tok = toks[i];
		if (tok.type !== 'identifier' || baseName(tok.lower) !== 'request') continue;
		if (!isOperator(toks[i + 1], '(')) continue;

		const groups = argumentGroups(toks, i + 2);
		if (loneString(groups[0])?.toLowerCase() !== 'pen_of_rgb') continue;
		if (groups[1]?.length) visit(groups[1]);
	}
}

/**
 * The variable a whole argument names, or nothing when it is an expression.
 *
 * `_rgb_white` and `gr_out[i]` and `_cols.warm[1].rgb` all name one; anything
 * built with an operator does not, and `+` in particular is GDL's string
 * concatenation — the one operator that really could be assembling a colour,
 * and the reason a computed argument is unknowable rather than merely awkward.
 */
function pathHead(group: Token[]): string | undefined {
	const head = group[0];
	if (head.type !== 'identifier') return undefined;

	let depth = 0;
	for (let i = 1; i < group.length; i++) {
		const tok = group[i];
		if (isOperator(tok, '[')) depth++;
		else if (isOperator(tok, ']')) {
			if (--depth < 0) return undefined;
		} else if (depth === 0 && !isOperator(tok, '.') && !isOperator(group[i - 1], '.')) {
			return undefined;
		}
	}
	return depth === 0 ? head.lower : undefined;
}

/** `"0.5 0.5 0.5"` — three numbers, and the whitespace that separates them. */
const RGB_STRING = /^(\s*)(\S+)(\s+)(\S+)(\s+)(\S+)(\s*)$/;
/** A GDL number as it may be written inside that string. No exponent, no hex. */
const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/**
 * The colour a `"r g b"` literal holds, over the span inside its quotes.
 *
 * Whitespace is kept exactly — leading, trailing and between the channels —
 * because a corpus string is as likely to be `"1 1 1"` padded out to line up
 * with the argument below it as it is to be plain.
 */
function rgbString(literal: Token): ColorSite | undefined {
	const parts = RGB_STRING.exec(literal.text.slice(1, -1));
	if (!parts) return undefined;

	const [, lead, r, sep1, g, sep2, b, trail] = parts;
	const channels = [r, g, b].map((text) => (PLAIN_NUMBER.test(text) ? Number(text) : NaN));
	if (!channels.every(inRange)) return undefined;

	return {
		color: Color.create(channels[0], channels[1], channels[2], 1),
		start: literal.start + 1,
		end: literal.end - 1,
		render: (picked) => {
			const [nr, ng, nb] = channelTexts(picked);
			return `${lead}${nr}${sep1}${ng}${sep2}${nb}${trail}`;
		},
	};
}

/**
 * Three consecutive arguments read as a colour, or nothing if any of them is
 * not a literal in range.
 */
function channelTriple(doc: GdlDocument, groups: Token[][], at: number): ColorSite | undefined {
	const triple = [groups[at], groups[at + 1], groups[at + 2]];
	if (triple.some((group) => !group?.length)) return undefined;

	const channels = triple.map((group) => foldConstant(group));
	if (!channels.every((value) => value !== undefined && inRange(value))) return undefined;

	const spans = triple.map((group) => [group[0].start, group[group.length - 1].end] as const);
	// Whatever stands between the channels — a comma, alignment padding, a line
	// break, a trailing comment — is copied out of the source untouched.
	const separators = [
		doc.text.slice(spans[0][1], spans[1][0]),
		doc.text.slice(spans[1][1], spans[2][0]),
	];

	return {
		color: Color.create(channels[0] as number, channels[1] as number, channels[2] as number, 1),
		start: spans[0][0],
		end: spans[2][1],
		render: (picked) => {
			const [r, g, b] = channelTexts(picked);
			return `${r}${separators[0]}${g}${separators[1]}${b}`;
		},
	};
}

function inRange(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * A channel as GDL would have it written: no trailing zeros, and no decimal
 * point at all on a whole number, since `1 1 1` is how the corpus spells white.
 */
function channelTexts(color: Color): [string, string, string] {
	const format = (value: number): string => {
		const clamped = Math.min(1, Math.max(0, value));
		const rounded = Math.round(clamped * 10 ** DECIMALS) / 10 ** DECIMALS;
		// `-0` is a real possibility once a picker has been through a colour
		// space, and `String` prints it with the sign.
		return String(rounded === 0 ? 0 : rounded);
	};
	return [format(color.red), format(color.green), format(color.blue)];
}

/**
 * Would the edit leave every line it touches inside the 255-character limit?
 *
 * Only the lines the span actually covers can change, so the whole of each is
 * reassembled and measured — the count is characters, so a tab is one, exactly
 * as `format.ts` counts them.
 */
function fitsLineLimit(text: string, site: ColorSite, newText: string): boolean {
	const isEol = (at: number) => text[at] === '\n' || text[at] === '\r';

	let from = site.start;
	while (from > 0 && !isEol(from - 1)) from--;
	let to = site.end;
	while (to < text.length && !isEol(to)) to++;

	const rewritten = text.slice(from, site.start) + newText + text.slice(site.end, to);
	return rewritten.split(/\r\n|[\r\n]/).every((line) => line.length <= MAX_LINE);
}

/**
 * The comma-separated arguments from `from` onwards, at bracket depth zero.
 *
 * Stops where the argument list does: at the `)` that closes the call it was
 * opened inside, or at the `THEN` / `ELSE` that starts the next command of a
 * single-line conditional — `IF a THEN DEFINE MATERIAL "x" 2, 1, 1, 1 ELSE …`
 * would otherwise read `1 ELSE` as a channel and quietly lose the swatch.
 */
function argumentGroups(tokens: readonly Token[], from: number): Token[][] {
	const groups: Token[][] = [];
	let current: Token[] = [];
	let depth = 0;

	for (let i = from; i < tokens.length; i++) {
		const tok = tokens[i];
		if (depth === 0 && tok.type === 'identifier' && CLAUSE_STARTERS.has(tok.lower)) break;

		if (isOperator(tok, '(') || isOperator(tok, '[')) depth++;
		else if (isOperator(tok, ')') || isOperator(tok, ']')) {
			if (depth === 0) break;
			depth--;
		} else if (depth === 0 && isOperator(tok, ',')) {
			groups.push(current);
			current = [];
			continue;
		}
		current.push(tok);
	}

	groups.push(current);
	return groups;
}

/** The contents of an argument that is one string literal, and nothing else. */
function loneString(group: Token[] | undefined): string | undefined {
	if (group?.length !== 1) return undefined;
	const tok = group[0];
	if (tok.type !== 'string' || tok.unterminated) return undefined;
	return tok.text.slice(1, -1);
}

/** `REQUEST{2}` names the same command as `REQUEST`. */
function baseName(lower: string): string {
	const brace = lower.indexOf('{');
	return brace === -1 ? lower : lower.slice(0, brace);
}
