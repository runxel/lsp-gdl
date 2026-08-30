/**
 * Command syntax read from the reference guide, for signature help and for
 * decoding bitmask arguments.
 *
 * `referenceDocs.ts` reads the *compact* pages — one gloss and a matrix, which
 * is all a global needs — and deliberately skips the 348 `class="gdlcommand"`
 * pages because they are a different, much larger shape. Those are what this
 * reads: the syntax line, a gloss per argument, and the bit tables.
 *
 * ## Scope: 2D shapes only, for now
 *
 * The guide files every command under a section, and this indexes the 31 pages
 * in **2D Shapes** and nothing else. That is a deliberate baseline — the same
 * parser covers 3D Shapes (130 pages), Attributes (37) and the rest, and
 * widening it is a matter of adding sections to `SECTIONS` once the shape has
 * been proven on real editing. Nothing below is 2D-specific.
 *
 * ## The page shape
 *
 *     <pre class="programlisting"><b id="POLY2__keyword_…">POLY2_</b> n, frame_fill, x1, y1, s1, ..., xn, yn, sn</pre>
 *     <div …><code><b>n: </b></code>number of nodes.</div>
 *     <div …><code><b>frame_fill: </b></code></div>
 *     <div><code>frame_fill = j<sub>1</sub> + 2*j<sub>2</sub> + 4*j<sub>3</sub></code>, where each j can be 0 or 1.</div>
 *     <div><code>j<sub>1</sub>: </code>draw contour,</div>
 *     <div><code>j<sub>2</sub>: </code>draw fill,</div>
 *
 * Three traps, each of which silently produced nothing until it was handled:
 *
 * - **The pages are written with non-breaking spaces.** `frame_fill&#160;=&#160;j`
 *   never matches a pattern written with ordinary ones. Same class of trap as
 *   the availability matrix's tick *images* in `referenceDocs.ts`: what the
 *   guide looks like and what it is made of are two different things.
 * - **The name is taken from the `<b>`, never from the filename.** The page for
 *   `POLY2_B{5}` is `POLY2_B5.html`, and it is the braced spelling the lexer
 *   produces and the user types.
 * - **A page may carry several formulas**, and they share one run of
 *   `j<sub>n</sub>:` lines. `POLY2_`'s `si` reuses `j1`, `j5` and `j6` with
 *   wholly different meanings from its `frame_fill`, so the descriptions are
 *   scoped to the region between one formula and the next. Reading them into a
 *   single table gave `frame_fill = 1` the meaning of `si = 1`.
 *
 * ## Inheritance
 *
 * The guide does not repeat itself: `POLY2_B`'s page says "Advanced versions of
 * the POLY2_ command, with additional parameters" and glosses only the two that
 * are new. So a page with no table of its own for an argument, or with a bit it
 * leaves undescribed, inherits from the command it says it advances — a chain
 * that runs `POLY2_B{6}` → `{5}` → `{4}` → `{3}` → `POLY2_B` → `POLY2_`.
 *
 * A child's own formula always wins: `POLY2_B{5}` moved the cut/cover bits out
 * of `frame_fill` into `fillcategory`, so inheriting the parent's *shape* would
 * describe bits that no longer mean that. Only descriptions are filled in, and
 * only by matching weight.
 *
 * The relationship is stated in prose rather than in a link — `POLY2_B{4}`'s
 * page carries no `<a>` at all — which is why it is read from the sentence.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { plainText } from './referenceDocs';

/**
 * Guide sections whose commands are indexed; empty means all of them.
 *
 * Started at `['2D Shapes']` as a baseline and now covers the guide entire —
 * see "Which sections are indexed" in the module notes below.
 */
const SECTIONS: readonly string[] = [];

export interface CommandParam {
	/** As the guide writes it — `frame_fill`, `x1`, `"customDescription"`. */
	readonly name: string;
	/** Span of this argument inside the signature label. */
	readonly label: readonly [start: number, end: number];
	/** The guide's gloss for this argument, where it has one. */
	readonly documentation?: string;
}

export interface CommandSignature {
	/** The command this line spells, braces and all — a page may hold two. */
	readonly command: string;
	/** The whole syntax line, `[optional]` brackets and all. */
	readonly label: string;
	readonly params: readonly CommandParam[];
	/**
	 * The repeating tail — `x1, y1, s1, ..., xn, yn, sn` — as an index into
	 * `params` and a group size. Absent when the syntax does not repeat, or
	 * repeats in a shape this does not model (see `parseRepeat`).
	 */
	readonly repeat?: { readonly start: number; readonly size: number };
	/**
	 * The last argument may simply be given again and again —
	 * `PUT expression [, expression, ...]`. Distinct from `repeat`, which names
	 * a *group* whose members differ.
	 */
	readonly variadic?: boolean;
}

export interface MaskBit {
	readonly weight: number;
	/** Undefined where neither the page nor its ancestors describe the bit. */
	readonly text?: string;
}

export interface CommandDoc {
	/** As the guide spells it, braces included: `POLY2_B{5}`. */
	readonly name: string;
	readonly signatures: readonly CommandSignature[];
	/** Bitmask arguments, keyed on the lower-cased argument name. */
	readonly masks: ReadonlyMap<string, readonly MaskBit[]>;
}

/** `<pre class="programlisting">` — the syntax lines, and a few stray notes. */
const LISTING_RE = /<pre class="programlisting">([\s\S]*?)<\/pre>/g;
/** The command name inside a syntax line, which is what anchors it. */
const KEYWORD_RE = /^\s*<b id="[^"]*_keyword[^"]*">([^<]*)<\/b>([\s\S]*)$/;
/** `<code><b>frame_fill: </b></code>gloss` — one argument's documentation. */
const GLOSS_RE = /<code><b>([^<]*?):\s*<\/b><\/code>([^<]*)/g;
/** `frame_fill = j1 + 2*j2 + 4*j3` — a bitmask's shape. */
const FORMULA_RE = /<code>([A-Za-z_0-9]+) = ((?:\d*\*?j<sub>\d+<\/sub>(?: \+ )?)+)<\/code>/g;
/** `j<sub>1</sub>: draw contour` — one bit's meaning. */
const BIT_RE = /<code>j<sub>(\d+)<\/sub>:\s*<\/code>([^<]*)/g;
/** "Advanced version of the POLY2_B command" — the inheritance the guide states. */
const ADVANCES_RE = /Advanced versions? of (?:the )?([A-Za-z0-9_{} ]+?)\s*(?:command|,)/;

/**
 * Splits a syntax line's argument list.
 *
 * Commas separate arguments; `[` and `]` mark optionality and are *not* a
 * grouping construct, so they never hold a comma that should be ignored —
 * `x, y [, unID [, paramReference]]` is four arguments, not two. Stripping the
 * brackets from each piece is therefore the whole of it.
 *
 * `...` is kept as an argument of its own so `parseRepeat` can find it, and it
 * is split off its neighbour where the guide omits the comma: `SPLINE2A` writes
 * `... xn` while everything else writes `..., xn`.
 */
function splitParams(rest: string, offset: number): CommandParam[] {
	const params: CommandParam[] = [];

	const push = (from: number, to: number) => {
		const raw = rest.slice(from, to);
		// Trim the optionality brackets and surrounding space off each end.
		const lead = /^[\s[\]]*/.exec(raw)?.[0].length ?? 0;
		const trail = /[\s[\]]*$/.exec(raw)?.[0].length ?? 0;
		const name = raw.slice(lead, raw.length - trail);
		if (name) params.push({ name, label: [offset + from + lead, offset + to - trail] });
	};

	let start = 0;
	for (let i = 0; i <= rest.length; i++) {
		if (i < rest.length && rest[i] !== ',') continue;
		// `... xn` — an ellipsis running straight into the next argument.
		const piece = rest.slice(start, i);
		const gap = /\.\.\.\s+(?=\S)/.exec(piece);
		if (gap) {
			push(start, start + gap.index + 3);
			push(start + gap.index + gap[0].length, i);
		} else {
			push(start, i);
		}
		start = i + 1;
	}
	return params;
}

/**
 * Finds the repeating tail, `x1, y1, s1, ..., xn, yn, sn`.
 *
 * The tail after the ellipsis names the same arguments with an `n` where the
 * group before it has a `1`, and matching those two runs against each other is
 * what proves the shape rather than guessing it from the ellipsis alone.
 *
 * `PROJECT2{4}` repeats twice and spells its second tail
 * `method(numCutplanes+1)`, so nothing matches and it simply gets no repeat —
 * signature help still shows the whole line, it just cannot say which iteration
 * the cursor is in. 24 uses in the corpus, against 2200 `POLY2_B`s.
 */
function parseRepeat(params: readonly CommandParam[]): CommandSignature['repeat'] {
	const ellipsis = params.findIndex((p) => p.name === '...');
	if (ellipsis < 0) return undefined;

	const tail = params.slice(ellipsis + 1);
	const size = tail.length;
	if (size === 0 || ellipsis < size) return undefined;
	if (!tail.every((p) => p.name.endsWith('n'))) return undefined;

	const group = params.slice(ellipsis - size, ellipsis);
	if (!group.every((p) => p.name.endsWith('1'))) return undefined;
	// `x1`/`xn`, `length_previous1`/`length_previousn` — same base either side.
	const base = (name: string) => name.slice(0, -1);
	if (!group.every((p, i) => base(p.name) === base(tail[i].name))) return undefined;

	return { start: ellipsis - size, size };
}

/**
 * Keeps the run of arguments that can actually be counted.
 *
 * Not every syntax line is a comma-separated list. The guide writes control
 * statements as prose — `IF condition THEN statement [ ELSE statement]`,
 * `FOR variable_name = initial_value TO end_value` — and several commands run a
 * clause into their list: `CALL macro_name_string [,] PARAMETERS [ ALL ]…`,
 * `VALUES "parameter_name" [,]value_definition1`, `DEFINE MATERIAL name type,`.
 * Counting commas through any of those puts the cursor on the wrong argument,
 * which is worse than saying nothing.
 *
 * **A space inside an argument is the tell**, since a real one is a single
 * token. So the list is cut at the first argument that holds one, and a line
 * that is prose from the start keeps nothing at all — which is how `IF`, `FOR`,
 * `WHILE` and `GROUP` end up with no signature rather than a misleading one.
 *
 * Cutting rather than discarding is what keeps `PROJECT2{3}`: its first eight
 * arguments are an ordinary list and its `parts` mask is among them; only the
 * trailing `[[,] PARAMETERS name1=value1, …]` is uncountable.
 */
function countable(params: readonly CommandParam[]): CommandParam[] {
	const end = params.findIndex((param) => /\s/.test(param.name));
	return [...(end < 0 ? params : params.slice(0, end))];
}

/**
 * What to do with an ellipsis that `parseRepeat` did not claim.
 *
 * Counting cannot continue past it either way, so the list ends there. Whether
 * the cursor may still *rest* on the last argument is the question, and the two
 * cases look quite different:
 *
 * - `PUT expression [, expression, ...]`, `END [v1, v2, ..., vn]`,
 *   `LOCK "name1" [, "name2", ..., "namen"]` — the same argument, given again.
 *   The tail is empty, or is the single `n`-form of the one before the
 *   ellipsis. Holding the cursor on that argument is right however many are
 *   given, so the signature is variadic.
 * - `TUBE n, m, mask, u1, w1, s1, ... un, wn, sn, x1, y1, z1, …` — two
 *   repeating groups, the second of which `parseRepeat` cannot model. Clamping
 *   would put the cursor on `s1` while the user is on `w3`, so nothing is
 *   claimed past the ellipsis at all.
 */
function afterEllipsis(
	params: readonly CommandParam[],
): { end: number; variadic: boolean } | undefined {
	const at = params.findIndex((param) => param.name === '...');
	if (at < 0) return undefined;

	const tail = params.slice(at + 1);
	const previous = params[at - 1]?.name;
	const variadic =
		tail.length === 0 ||
		(tail.length === 1 &&
			previous !== undefined &&
			tail[0].name.slice(0, -1) === previous.slice(0, -1));

	return { end: at, variadic };
}

function parseSignatures(html: string, glosses: ReadonlyMap<string, string>): CommandSignature[] {
	const signatures: CommandSignature[] = [];

	for (const [, listing] of html.matchAll(LISTING_RE)) {
		const keyword = KEYWORD_RE.exec(listing);
		// Listings that are not a syntax line — `n >= 2` and the like.
		if (!keyword) continue;

		const name = plainText(keyword[1]);
		const rest = plainText(keyword[2]);
		const label = rest ? `${name} ${rest}` : name;
		const params = countable(splitParams(rest, name.length + 1)).map((p) => {
			const doc = glosses.get(p.name.toLowerCase()) ?? glosses.get(genericName(p.name));
			return doc ? { ...p, documentation: doc } : p;
		});
		// Nothing left to count into — `RETURN`, or a line that is prose from
		// its first word.
		if (params.length === 0) continue;

		const repeat = parseRepeat(params);
		const tail = repeat ? undefined : afterEllipsis(params);
		signatures.push({
			command: name,
			label,
			params: tail ? params.slice(0, tail.end) : params,
			...(repeat ? { repeat } : {}),
			...(tail?.variadic ? { variadic: true } : {}),
		});
	}

	return signatures;
}

/**
 * The name a repeating argument is glossed under.
 *
 * The syntax line writes `cutplaneHeight1` and `partsi`; the gloss below it is
 * filed under `cutplaneHeighti` and `partsi`. Reducing both to a bare base is
 * what lets one find the other.
 */
function genericName(name: string): string {
	return name.toLowerCase().replace(/[1in]$/, '');
}

function parseGlosses(html: string): Map<string, string> {
	const glosses = new Map<string, string>();
	for (const [, names, text] of html.matchAll(GLOSS_RE)) {
		const gloss = plainText(text).replace(/[,.]$/, '');
		if (!gloss) continue;
		// A gloss may cover a run of arguments: `x1, y1, ..., xn, yn: coordinates`.
		for (const name of names.split(',')) {
			const key = plainText(name).toLowerCase();
			if (!key || key === '...') continue;
			if (!glosses.has(key)) glosses.set(key, gloss);
			const generic = genericName(key);
			if (generic && !glosses.has(generic)) glosses.set(generic, gloss);
		}
	}
	return glosses;
}

/**
 * The bitmask arguments of one page, each bit scoped to its own formula.
 *
 * The `j<sub>n</sub>:` lines belong to the formula above them, not to the page,
 * which is why the search is bounded by the next formula's position.
 */
function parseMasks(html: string): Map<string, MaskBit[]> {
	const masks = new Map<string, MaskBit[]>();
	const formulas = [...html.matchAll(FORMULA_RE)];

	for (let i = 0; i < formulas.length; i++) {
		const formula = formulas[i];
		const to = i + 1 < formulas.length ? formulas[i + 1].index : html.length;

		const described = new Map<number, string>();
		for (const [, index, text] of html.slice(formula.index + formula[0].length, to).matchAll(BIT_RE)) {
			const gloss = plainText(text).replace(/[,.]$/, '');
			if (gloss) described.set(Number(index), gloss);
		}

		const bits: MaskBit[] = [];
		for (const [, weight, index] of formula[2].matchAll(/(\d*)\*?j<sub>(\d+)<\/sub>/g)) {
			const text = described.get(Number(index));
			bits.push({ weight: weight ? Number(weight) : 1, ...(text ? { text } : {}) });
		}
		masks.set(formula[1].toLowerCase(), bits);
	}

	return masks;
}

interface RawPage {
	readonly name: string;
	readonly html: string;
	/** The page's filename is the command it documents, so it owns that name. */
	readonly authoritative: boolean;
	/** The command this page says it advances, as the guide spells it. */
	readonly advances?: string;
}

/**
 * Fills a page's gaps from the command it advances: whole masks it never
 * declares, and individual bits it leaves undescribed.
 *
 * Only descriptions cross the boundary. A child that declares its own formula
 * keeps its own bits, because a variant may reassign a weight — `POLY2_B{5}`
 * moved cut and cover fill out of `frame_fill` into `fillcategory`.
 */
function inherit(
	masks: Map<string, MaskBit[]>,
	ancestors: readonly Map<string, MaskBit[]>[],
): Map<string, MaskBit[]> {
	for (const ancestor of ancestors) {
		for (const [name, bits] of ancestor) {
			const own = masks.get(name);
			if (!own) {
				masks.set(name, bits);
				continue;
			}
			masks.set(
				name,
				own.map((bit) =>
					bit.text ? bit : { ...bit, ...(describe(bits, bit.weight) ? { text: describe(bits, bit.weight) } : {}) },
				),
			);
		}
	}
	return masks;
}

function describe(bits: readonly MaskBit[], weight: number): string | undefined {
	return bits.find((b) => b.weight === weight)?.text;
}

/** `POLY2_B{5}` and its page `POLY2_B5.html` reduced to one comparable form. */
function indexKey(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

let root: string | undefined;
let index: Map<string, CommandDoc> | undefined;

/**
 * Points the lookup at the reference folder of the installed GRAPHISOFT
 * extension — the same folder `referenceDocs.ts` reads, set separately so
 * neither module has to know about the other.
 */
export function setCommandDocsRoot(path: string | undefined): void {
	if (path === root) return;
	root = path;
	index = undefined;
}

function build(): Map<string, CommandDoc> {
	if (index) return index;
	index = new Map();
	if (!root) return index;

	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return index;
	}

	// Read the pages first: inheritance means a page cannot be finished until
	// the one it advances has been seen, whatever order the directory is in.
	const raw: RawPage[] = [];
	for (const file of names) {
		if (!file.toLowerCase().endsWith('.html')) continue;
		try {
			const html = readFileSync(join(root, file), 'utf8').replace(/\u00a0/g, ' ');
			if (!html.includes('class="gdlcommand"')) continue;

			const flat = plainText(html);
			if (SECTIONS.length && !SECTIONS.some((section) => flat.includes(`Related in ${section}`))) continue;

			const keyword = /<b id="[^"]*_keyword[^"]*">([^<]*)<\/b>/.exec(html);
			if (!keyword) continue;

			const name = plainText(keyword[1]);
			const advances = ADVANCES_RE.exec(flat)?.[1].replace(/\s+/g, '');
			const base = file.slice(0, -'.html'.length);
			raw.push({
				name,
				html,
				authoritative: indexKey(base) === indexKey(name),
				...(advances ? { advances } : {}),
			});
		} catch {
			// Unreadable page — treated as no documentation.
		}
	}

	// `DELTOP.html` spells `<b>DEL</b> TOP`, so it names the same keyword as
	// `DEL.html`. Whichever page is named after the command it documents owns
	// that name, for inheritance as well as for lookup.
	const byName = new Map<string, RawPage>();
	for (const page of raw) {
		const key = page.name.toLowerCase();
		if (page.authoritative || !byName.has(key)) byName.set(key, page);
	}

	const built: { page: RawPage; doc: CommandDoc; names: string[] }[] = [];
	for (const page of raw) {
		const ancestors: Map<string, MaskBit[]>[] = [];
		const seen = new Set<string>([page.name.toLowerCase()]);
		for (let at = page.advances; at; ) {
			const key = at.toLowerCase();
			if (seen.has(key)) break;
			seen.add(key);
			const parent = byName.get(key);
			if (!parent) break;
			ancestors.push(parseMasks(parent.html));
			at = parent.advances;
		}

		const doc: CommandDoc = {
			name: page.name,
			signatures: parseSignatures(page.html, parseGlosses(page.html)),
			masks: inherit(parseMasks(page.html), ancestors),
		};
		// A page may document two commands at once — `END / EXIT` is one page
		// with a syntax line each — so every name it spells answers to it.
		const names = [page.name, ...doc.signatures.map((signature) => signature.command)];
		built.push({ page, doc, names });
	}

	// A multi-word command marks only its first word as the keyword —
	// `DELTOP.html` spells `<b>DEL</b> TOP` — so it would otherwise claim `DEL`
	// from the page that actually documents it. The page whose *filename* is the
	// command it documents wins; the rest fill in only what is still free.
	for (const authoritative of [true, false]) {
		for (const { page, doc, names } of built) {
			if (page.authoritative !== authoritative) continue;
			for (const name of names) {
				const key = name.toLowerCase();
				if (!authoritative && index.has(key)) continue;
				index.set(key, doc);
			}
		}
	}

	return index;
}

/** The guide's entry for a command, if it is one of the indexed sections. */
export function commandDoc(name: string): CommandDoc | undefined {
	return build().get(name.toLowerCase());
}
