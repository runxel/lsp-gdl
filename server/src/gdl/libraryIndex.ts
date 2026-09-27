/**
 * Every library part in the workspace, by name — what a `CALL` resolves against.
 *
 * `CALL "Pila Knoten"` names a library part, not a file, so following it means
 * knowing which folder on disk *is* that part. In HSF the answer is the folder
 * name: a part lives at `<name>/libpartdata.xml`, and LP_XMLConverter builds
 * `<name>.gsm` from it. The binary `.gsm` form is indexed as well, because a
 * library checked out beside its sources routinely carries both, and a macro
 * present only compiled is still *present* — it merely cannot be opened.
 *
 * Measured on the corpus, one repo at a time as a workspace would be:
 *
 *   - **Names match without regard to case.** `CALL "GetDWOplines"` reaches
 *     the folder `GetDWOpLines` four times over, and the object works.
 *   - **A name may carry its extension**, `"Generic_frame_macro.gsm"` — 54
 *     calls, all in `bim-all-doors`. `macroKey` strips it.
 *   - **A name may be found twice.** 33 calls in one repo have two HSF copies
 *     to choose from (a `_temp` folder beside the original, typically), and the
 *     nearer one is the likelier meant — see `nearest`.
 *
 * Built on first use and held until the client reports a library part created
 * or removed; the walk skips `node_modules` and dot-folders, and does not
 * descend into a part once found, since HSF parts do not nest.
 */

import { readdirSync, type Dirent } from 'node:fs';
import { basename, join, sep } from 'node:path';

export interface IndexedLibraryPart {
	/** The part's name as its folder or file spells it. */
	readonly name: string;
	/** HSF root folder, when the part is present as source. */
	readonly root?: string;
	/** The compiled `.gsm`, when that is all there is. */
	readonly gsm?: string;
}

/** Walks stop here, so a workspace opened on a home folder cannot hang the server. */
const MAX_DIRECTORIES = 50_000;
const MAX_DEPTH = 16;

let roots: readonly string[] = [];
let fallback: string | undefined;
let index: Map<string, IndexedLibraryPart[]> | undefined;

/** The folders to search — the workspace folders, as the client reports them. */
export function setLibraryRoots(folders: readonly string[]): void {
	roots = [...folders];
	index = undefined;
}

/**
 * Where to look when no workspace folder is open — a script opened on its own.
 * The folder holding its library part is where a library keeps the macros
 * beside it, so that is searched rather than nothing at all. Ignored whenever
 * a workspace folder is open.
 */
export function setFallbackLibraryRoot(folder: string | undefined): void {
	if (roots.length > 0 || folder === fallback) return;
	fallback = folder;
	index = undefined;
}

export function invalidateLibraryIndex(): void {
	index = undefined;
}

/**
 * The key a macro name is indexed under: trimmed, lower-cased, and without a
 * `.gsm` extension.
 */
export function macroKey(name: string): string {
	return name.trim().replace(/\.gsm$/i, '').toLowerCase();
}

function build(): Map<string, IndexedLibraryPart[]> {
	const found = new Map<string, IndexedLibraryPart[]>();
	const add = (part: IndexedLibraryPart) => {
		const key = macroKey(part.name);
		const list = found.get(key);
		if (list) list.push(part);
		else found.set(key, [part]);
	};

	let visited = 0;
	const walk = (dir: string, depth: number) => {
		if (visited++ > MAX_DIRECTORIES || depth > MAX_DEPTH) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		if (entries.some((e) => e.isFile() && e.name.toLowerCase() === 'libpartdata.xml')) {
			add({ name: basename(dir), root: dir });
			return;
		}

		for (const entry of entries) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
			if (entry.isDirectory()) walk(join(dir, entry.name), depth + 1);
			else if (entry.isFile() && entry.name.toLowerCase().endsWith('.gsm')) {
				add({ name: entry.name.slice(0, -4), gsm: join(dir, entry.name) });
			}
		}
	};
	for (const root of roots.length > 0 ? roots : fallback ? [fallback] : []) walk(root, 0);

	// Source before binary, so the part that can be opened is the one offered.
	for (const list of found.values()) list.sort((a, b) => Number(!a.root) - Number(!b.root));
	return found;
}

/** Every part in the workspace answering to `name`, sources first. */
export function libraryPartsNamed(name: string): readonly IndexedLibraryPart[] {
	index ??= build();
	return index.get(macroKey(name)) ?? [];
}

/**
 * Of several parts sharing a name, the one closest to `fromPath` — the one
 * sharing the longest run of leading folders with it, source before binary.
 *
 * A library usually keeps a macro beside the objects calling it, while a
 * second copy is a backup or a vendored library further off; ties go to the
 * first found, which the sort in `build` makes a source folder.
 */
export function nearest(
	parts: readonly IndexedLibraryPart[],
	fromPath: string | undefined,
): IndexedLibraryPart | undefined {
	if (parts.length <= 1 || !fromPath) return parts[0];
	const from = fromPath.split(sep);
	const shared = (p: IndexedLibraryPart) => {
		const segments = (p.root ?? p.gsm ?? '').split(sep);
		let n = 0;
		while (n < from.length && n < segments.length && from[n] === segments[n]) n++;
		return n;
	};
	let best = parts[0];
	let bestScore = shared(best);
	for (const part of parts.slice(1)) {
		const score = shared(part);
		// A source part is never displaced by a binary one, however near.
		if (score > bestScore && (part.root || !best.root)) {
			best = part;
			bestScore = score;
		}
	}
	return best;
}
