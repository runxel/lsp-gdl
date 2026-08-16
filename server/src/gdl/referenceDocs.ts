/**
 * Documentation for GDL names, read from the reference guide that ships with
 * the official GRAPHISOFT extension.
 *
 * The vendored keyword list gives a name, a kind and the scripts it is valid
 * in, but not a word of prose — and for the ~800 globals prose is the whole
 * point. `GLOB_CSTORY_ELEV` is unguessable; "elevation of the current story"
 * answers it.
 *
 * That prose is **not vendored here**. GRAPHISOFT's extension bundles the
 * reference guide as one HTML page per keyword under `VSCodeRef/reference/`,
 * and we declare that extension as a dependency, so it is always installed
 * alongside ours. The client hands us its path at initialisation and we read
 * the user's own copy. Nothing is copied into this repo, and the documentation
 * is always the version the user actually has.
 *
 * Only the compact form is understood — the one every global and fixed
 * parameter uses:
 *
 *     <tr><td><b>SYMB_MIRRORED</b></td><td>library part mirrored</td></tr>
 *     <tr><td … font-style: italic>
 *         <p>0-no, 1-yes …</p>
 *     </td></tr>
 *
 * A summary, then any number of detail paragraphs. Command pages
 * (`class="gdlcommand"`) are a different, much larger shape — full syntax
 * diagrams and examples — and are left alone for now.
 *
 * ## The availability matrix
 *
 * 230 of the global pages also carry a row saying which scripts the variable
 * works in. It is drawn with tick and cross *images*, which is why the printed
 * guide is no use here — but the images carry `alt="Check"` / `alt="Error"`,
 * so the row reads back exactly:
 *
 *     2D ✓  3D ✓  UI ✗  Parameter ✗  Property ✗  Default 100
 *
 * Cells are sometimes merged (`UI Parameter ✗`), so a label with no mark of
 * its own shares the next one.
 *
 * Only those five columns exist. Nothing is said about the master script or
 * the migration scripts, so this reports what the guide **rules out** and
 * leaves everything else to the keyword table — a global is never given a
 * script it was not already credited with.
 *
 * The whole directory is indexed in one pass on first use (~1300 files, ~30 ms)
 * rather than a read per name, because completion needs the availability of
 * every keyword at once.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ScriptKind } from './scriptKind';

export interface ReferenceDoc {
	/** One-line gloss from the first table row; for a fixed parameter, its type. */
	readonly summary: string;
	/** Further paragraphs, if the page carries any. */
	readonly details: readonly string[];
	/** Scripts the availability matrix explicitly rules out. */
	readonly excludedScripts?: readonly ScriptKind[];
	/** The matrix's `Default` cell, when it carries a value. */
	readonly defaultValue?: string;
}

/** `<b>NAME</b></td><td …>summary</td>` — the first row of a compact page. */
const SUMMARY_RE = /<b>([^<]*)<\/b>\s*<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/;
/** The italic block holding the detail paragraphs. */
const DETAIL_RE = /font-style:\s*italic[^>]*>([\s\S]*?)<\/td>/;
/** The availability matrix, a div laid out as a single table row. */
const MATRIX_RE = /display\s*:\s*table-row[\s\S]*?<\/div><\/div>/;

/** Column headings of the matrix, in the order the guide prints them. */
const COLUMNS: readonly (readonly [label: string, script: ScriptKind])[] = [
	['2D', '2d'],
	['3D', '3d'],
	['UI', 'ui'],
	['Parameter', 'vl'],
	['Property', 'pr'],
];

/** Sentinels the tick and cross images become before the tags come off. */
const YES = '\u2713'; // ✓
const NO = '\u2717'; // ✗

const ENTITIES: Readonly<Record<string, string>> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
};

/** Strips tags and decodes the handful of entities DocBook actually emits. */
function plainText(html: string): string {
	return html
		.replace(/<[^>]+>/g, ' ')
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
		.replace(/&(\w+);/g, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * Reads the availability row: which scripts are crossed out, and the default.
 *
 * The marks are images, so they are swapped for sentinels before the tags come
 * off — a literal `[0, 0, 0]` in the `Default` cell must not read as one.
 */
function parseMatrix(html: string): Pick<ReferenceDoc, 'excludedScripts' | 'defaultValue'> {
	const row = MATRIX_RE.exec(html)?.[0];
	if (!row) return {};

	const flat = plainText(
		row.replace(/<img[^>]*alt="Check"[^>]*>/g, YES).replace(/<img[^>]*alt="Error"[^>]*>/g, NO),
	);

	const labels = [...COLUMNS.map(([label]) => label), 'Default'];
	const marks = new RegExp(`(${labels.join('|')})`, 'g');
	const found = [...flat.matchAll(marks)];

	const excluded = new Set<ScriptKind>();
	let defaultValue: string | undefined;
	/** Labels still waiting for a mark, because their cell is merged with a later one. */
	let pending: string[] = [];

	for (let i = 0; i < found.length; i++) {
		const label = found[i][1];
		const from = found[i].index + label.length;
		const to = i + 1 < found.length ? found[i + 1].index : flat.length;
		const gap = flat.slice(from, to).trim();

		if (label === 'Default') {
			// Anything but the guide's placeholder for "no default".
			if (gap && gap !== '-') defaultValue = gap;
			continue;
		}

		pending.push(label);
		if (!gap.includes(YES) && !gap.includes(NO)) continue; // merged cell

		if (gap.includes(NO)) {
			for (const name of pending) {
				const column = COLUMNS.find(([l]) => l === name);
				if (column) excluded.add(column[1]);
			}
		}
		pending = [];
	}

	return {
		...(excluded.size ? { excludedScripts: [...excluded] } : {}),
		...(defaultValue ? { defaultValue } : {}),
	};
}

/** Parses one page, or returns undefined if it is not the compact shape. */
function parsePage(html: string): ReferenceDoc | undefined {
	// Command pages carry a wholly different structure; skip them rather than
	// half-render one.
	if (!html.includes('class="gdlglobal"')) return undefined;

	const summary = SUMMARY_RE.exec(html);
	if (!summary) return undefined;

	const details = DETAIL_RE.exec(html)?.[1]
		.split(/<\/p>/)
		.map(plainText)
		.filter((p) => p.length > 0);

	return {
		summary: plainText(summary[2]),
		details: details ?? [],
		...parseMatrix(html),
	};
}

let root: string | undefined;
let index: Map<string, ReferenceDoc> | undefined;

/**
 * Points the lookup at the reference folder of the installed GRAPHISOFT
 * extension. Passing undefined — the extension is missing, or the server is
 * running outside VS Code — simply leaves hovers without documentation.
 */
export function setReferenceRoot(path: string | undefined): void {
	if (path === root) return;
	root = path;
	index = undefined;
}

function pages(): Map<string, ReferenceDoc> {
	if (index) return index;
	index = new Map();
	if (!root) return index;

	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		// No reference guide installed where we were told to look.
		return index;
	}

	for (const name of names) {
		if (!name.toLowerCase().endsWith('.html')) continue;
		try {
			const doc = parsePage(readFileSync(join(root, name), 'utf8'));
			if (doc) index.set(name.slice(0, -'.html'.length).toLowerCase(), doc);
		} catch {
			// Unreadable page — treated as no documentation.
		}
	}
	return index;
}

/** The reference guide's entry for `name`, if it has a compact one. */
export function referenceDoc(name: string): ReferenceDoc | undefined {
	return pages().get(name.toLowerCase());
}
