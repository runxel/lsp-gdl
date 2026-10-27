/**
 * Explicit regions: `! #region Hotspots` … `! #endregion`.
 *
 * Read by folding, which collapses them, and by document symbols, which list
 * the named ones so the Outline and Go to Symbol can jump to them. One account
 * of which markers pair up, so a region that folds is the region that is
 * listed.
 */

import type { GdlDocument } from './analyzer';
import type { Token } from './lexer';

/**
 * The spelling VS Code's own languages use for a line comment — `//#region`,
 * `// region` — so `! #region Hotspots` and `!endregion` both work. The `#` is
 * optional there, and here.
 *
 * GDL has no convention of its own: 11762 corpus scripts hold not one marker
 * of any spelling. They section with banners instead (`! ======`), and a
 * banner says where a section starts but never where it ends — so it cannot be
 * folded on, and the marker is what an author writes when they want that.
 *
 * `endregion` cannot match the start pattern: `region` must follow the `!` or
 * `#` directly.
 */
const REGION_START = /^!\s*#?region\b/i;
const REGION_END = /^!\s*#?endregion\b/i;

export interface Region {
	/** What follows the marker, trimmed and unbracketed; empty when unnamed. */
	readonly name: string;
	/** Offset of the `#region` comment. */
	readonly start: number;
	/** End offset of the `#endregion` comment. */
	readonly end: number;
	/** Where the name sits on the marker line; both `start`'s line. */
	readonly nameStart: number;
	readonly nameEnd: number;
}

/** A comment with nothing but whitespace before it on its line. */
export function standsAlone(text: string, tok: Token): boolean {
	for (let i = tok.start - 1; i >= 0; i--) {
		const c = text[i];
		if (c === '\n' || c === '\r') return true;
		if (c !== ' ' && c !== '\t' && c !== '﻿') return false;
	}
	return true;
}

/**
 * Which marker a comment is, if any. Only a comment standing alone on its line
 * counts: a marker trailing a command would put the fold's header in the middle
 * of code.
 */
export function regionMarker(text: string, tok: Token): 'start' | 'end' | undefined {
	if (tok.type !== 'comment' || !standsAlone(text, tok)) return undefined;
	if (REGION_START.test(tok.text)) return 'start';
	if (REGION_END.test(tok.text)) return 'end';
	return undefined;
}

/**
 * Every matched pair, in the order the regions open. Markers nest; an
 * `#endregion` with nothing open and a `#region` never closed are dropped, the
 * latter because the optional `#` makes `! region of the sill` a marker too, and
 * prose has no `#endregion` to close it.
 */
export function regions(doc: GdlDocument): Region[] {
	const found: Region[] = [];
	const open: Token[] = [];
	for (const tok of doc.tokens) {
		const marker = regionMarker(doc.text, tok);
		if (marker === 'start') {
			open.push(tok);
		} else if (marker === 'end') {
			const startTok = open.pop();
			if (startTok) found.push(region(startTok, tok.end));
		}
	}
	return found.sort((a, b) => a.start - b.start);
}

/**
 * The name is whatever follows the marker, and may be written in square
 * brackets — `! #region [Listfield Items]`, the spelling the project owner
 * uses — which delimit it and are not part of it. Only one enclosing pair is
 * taken off, so `[a] and [b]` keeps its brackets.
 */
function region(tok: Token, end: number): Region {
	const marker = REGION_START.exec(tok.text)![0];
	let nameStart = tok.start + marker.length;
	let name = tok.text.slice(marker.length);
	const strip = (lead: number, trail: number) => {
		nameStart += lead;
		name = name.slice(lead, name.length - trail);
	};
	strip(name.length - name.trimStart().length, name.length - name.trimEnd().length);
	if (/^\[[^\]]*\]$/.test(name)) {
		strip(1, 1);
		strip(name.length - name.trimStart().length, name.length - name.trimEnd().length);
	}
	return { name, start: tok.start, end, nameStart, nameEnd: nameStart + name.length };
}
