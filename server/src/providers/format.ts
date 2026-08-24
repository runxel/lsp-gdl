/**
 * Column alignment for continued argument lists.
 *
 *     put \
 *         1,          1.12345,    sr,
 *         1.0394*abc, 0,          s
 *
 * GDL's long lists — `PUT`, coordinate rows, `VALUES`, `PARAMETERS` — are
 * written one row per line and read as a table, so the eye wants columns. This
 * is the only thing the formatter does: it changes the whitespace *between*
 * fields and nothing else. No line break is ever added or removed, no comma is
 * moved, no token is rewritten. That invariant is what makes it safe to run
 * over a shipped library part — re-tokenising the result must give back exactly
 * the same tokens.
 *
 * A row is a physical line of a statement; a cell is a run of tokens up to a
 * comma at bracket depth zero, the comma included (`str(x, 1, 0)` is one cell,
 * not three). Column *n* of every row is padded to the same column, and the
 * trailing `\` and trailing comment each get a column of their own.
 *
 * Four rules govern it, every one of them written by the corpus:
 *
 *   - **Only a real table is aligned**, and the head row carrying the command
 *     is judged apart from the value rows below it. `tableRows()` below; this
 *     is the rule that keeps idiomatic code from being made worse, and it is
 *     worth reading before anything else here.
 *   - **A column of one is left as written.** Alignment needs two rows to line
 *     up. That is what keeps the idiomatic `put \` on the head line where it
 *     is, rather than dragging it out to the width of the table below; where
 *     several adjacent rows carry a `\` — the multi-line `if a | \` condition
 *     — they line up with each other, and with nothing else. Comments the same,
 *     bar the adjacency, for which see the next rule.
 *   - **A `\` lines up only within an unbroken run of them.** Unlike a comment,
 *     which annotates the row it sits on, a `\` says the row *below* belongs to
 *     this one, so a pair of them draws a visible edge only where their rows
 *     adjoin. Any row without one breaks that edge, and the markers either side
 *     of the break have nothing to line up with. See `runsOf` and the note in
 *     `layout`.
 *   - **Indentation is the author's.** Column 0 is never moved, so the columns
 *     after it are computed from where each row actually starts.
 *   - **Padding follows the editor.** `insertSpaces` decides tabs or spaces and
 *     `tabSize` decides where a tab lands, both handed over by the client, so
 *     the file stays whatever the workspace already is.
 *
 * ### The 255-character limit
 *
 * Archicad refuses a script line longer than 255 characters. Alignment only
 * ever makes lines longer, so it is the one way this could break a working
 * script — and the failure would be introduced by the tool, in a file that
 * compiled a moment ago. So the whole statement is laid out first and measured;
 * if any of its rows would come out over the limit, the statement is left
 * exactly as written. Not partially aligned — a half-aligned table is worse
 * than an unaligned one. A statement that is *already* over the limit is left
 * alone too, rather than being nudged further out.
 *
 * ### When a statement is left alone
 *
 * Anything the model does not fully understand is skipped rather than guessed
 * at, in the same spirit as `parens.ts`:
 *
 *   - a single-line statement — there is nothing to align it with;
 *   - an unterminated string, or a string continued across lines, since the row
 *     model assumes a token sits on one line;
 *   - unbalanced brackets, or a row starting inside brackets: its cells do not
 *     correspond to the columns above it;
 *   - anything but whitespace, one `\` and a comment after the last cell of a
 *     row. That is what a second statement on the line looks like
 *     (`put 1, 2 : addx 1`), and it is also the honest answer for a shape this
 *     has never seen.
 *
 * Corpus: 2448 files, 0 crashes, and — asserted over every file, in both tabs
 * and spaces — the token stream unchanged, the second run a no-op, and not one
 * line pushed past 255 characters. 978 files hold something it would align.
 */

import type { Range, TextEdit } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument, Statement } from '../gdl/analyzer';

/** Archicad refuses a source line longer than this, so we must never write one. */
export const MAX_LINE_LENGTH = 255;

export interface AlignOptions {
	/** Columns a tab advances to, from the client's `FormattingOptions`. */
	tabSize: number;
	/** Pad with spaces rather than tabs, likewise the client's. */
	insertSpaces: boolean;
	/** Overridable for tests; production always uses `MAX_LINE_LENGTH`. */
	maxLineLength?: number;
}

/** A stretch of one line: a cell, the `\`, or the trailing comment. */
interface Field {
	readonly start: number;
	readonly end: number;
}

/** One physical line of a statement. */
interface Row {
	readonly line: number;
	readonly lineStart: number;
	/** Just past the last character, the line terminator excluded. */
	readonly lineEnd: number;
	readonly cells: Field[];
	cont?: Field;
	comment?: Field;
}

/**
 * Line boundaries of the whole document.
 *
 * Lone CR is a line ending too — classic-Mac library parts still exist, and the
 * lexer already honours them, so the row model must agree with it.
 */
class LineIndex {
	private readonly starts: number[] = [0];
	private readonly ends: number[] = [];

	constructor(text: string) {
		for (let i = 0; i < text.length; i++) {
			const c = text[i];
			if (c !== '\n' && c !== '\r') continue;
			this.ends.push(i);
			if (c === '\r' && text[i + 1] === '\n') i++;
			this.starts.push(i + 1);
		}
		this.ends.push(text.length);
	}

	lineAt(offset: number): number {
		let lo = 0;
		let hi = this.starts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.starts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	}

	startOf(line: number): number {
		return this.starts[line];
	}

	endOf(line: number): number {
		return this.ends[line];
	}
}

/** Column reached after writing `text` starting at column `col`. */
function advance(text: string, col: number, tabSize: number): number {
	for (const ch of text) {
		col = ch === '\t' ? (Math.floor(col / tabSize) + 1) * tabSize : col + 1;
	}
	return col;
}

/** The first column a following field may start at: one gap past `col`. */
function nextStop(col: number, opts: AlignOptions): number {
	return opts.insertSpaces ? col + 1 : (Math.floor(col / opts.tabSize) + 1) * opts.tabSize;
}

/** Whitespace carrying column `from` to column `target`. */
function padding(from: number, target: number, opts: AlignOptions): string {
	if (opts.insertSpaces) return ' '.repeat(Math.max(1, target - from));
	let out = '';
	let col = from;
	while (col < target) {
		col = (Math.floor(col / opts.tabSize) + 1) * opts.tabSize;
		out += '\t';
	}
	return out || '\t';
}

/**
 * Splits a statement into rows of cells, or returns undefined if it is one of
 * the shapes this must not touch.
 */
function rowsOf(stmt: Statement, text: string, lines: LineIndex): Row[] | undefined {
	const rows: Row[] = [];
	let row: Row | undefined;
	let depth = 0;
	let cellStart = -1;
	let cellEnd = -1;

	const closeCell = () => {
		if (row && cellStart >= 0) row.cells.push({ start: cellStart, end: cellEnd });
		cellStart = -1;
	};

	for (const tok of stmt.tokens) {
		if (tok.unterminated) return undefined;
		const line = lines.lineAt(tok.start);
		// A string may be continued across lines with `\`; one token then spans
		// two rows and the whole idea of columns stops applying.
		if (lines.lineAt(tok.end - 1) !== line) return undefined;

		if (!row || row.line !== line) {
			closeCell();
			// A row opening inside brackets is a fragment of the row above, so
			// its first cell is not a column-0 value.
			if (depth > 0) return undefined;
			row = {
				line,
				lineStart: lines.startOf(line),
				lineEnd: lines.endOf(line),
				cells: [],
			};
			rows.push(row);
		}

		if (cellStart < 0) cellStart = tok.start;
		cellEnd = tok.end;

		if (tok.type !== 'operator') continue;
		if (tok.text === '(' || tok.text === '[') depth++;
		else if (tok.text === ')' || tok.text === ']') {
			if (--depth < 0) return undefined;
		} else if (tok.text === ',' && depth === 0) {
			closeCell();
		}
	}
	closeCell();
	if (depth !== 0) return undefined;
	if (rows.length < 2) return undefined;

	for (const r of rows) {
		if (r.cells.length === 0) return undefined;
		// Everything before the first cell must be indentation. Anything else
		// means a second statement shares the line.
		const indent = text.slice(r.lineStart, r.cells[0].start);
		if (/[^ \t]/.test(indent)) return undefined;
		if (!readTail(r, text)) return undefined;
	}
	return rows;
}

/**
 * Reads what follows the last cell of a row: optional whitespace, an optional
 * `\`, and an optional comment. Anything else and the row is not understood.
 *
 * Note the order — the lexer accepts a comment between the `\` and the line
 * ending (`if a |\  ! note`), never the other way round.
 */
function readTail(row: Row, text: string): boolean {
	let i = row.cells[row.cells.length - 1].end;
	const skipSpace = () => {
		while (i < row.lineEnd && (text[i] === ' ' || text[i] === '\t')) i++;
	};

	skipSpace();
	if (text[i] === '\\' && i < row.lineEnd) {
		row.cont = { start: i, end: i + 1 };
		i++;
		skipSpace();
	}
	if (i >= row.lineEnd) return true;
	if (text[i] !== '!') return false;
	row.comment = { start: i, end: row.lineEnd };
	return true;
}

/**
 * The maximal runs of adjacent rows satisfying `has`, as index lists.
 *
 * Adjacency is counted over the rows of the statement rather than the lines of
 * the file, so a commented-out line inside a continuation — a no-op the lexer
 * runs straight through, and never a row — does not break a run in two.
 */
function runsOf(rows: readonly Row[], has: (r: Row) => boolean): number[][] {
	const runs: number[][] = [];
	let run: number[] | undefined;
	rows.forEach((r, i) => {
		if (!has(r)) {
			run = undefined;
			return;
		}
		if (!run) runs.push((run = []));
		run.push(i);
	});
	return runs;
}

/** A whitespace stretch to be rewritten. */
interface Gap {
	readonly start: number;
	readonly end: number;
	readonly text: string;
}

/**
 * Which rows form the table, empty when the statement holds none.
 *
 * This is the judgement the corpus forced. Aligning anything with a comma in it
 * turned idiomatic code into something worse:
 *
 *     VALUES{2} "iDoorPanelType" 1, "Typ 1", 2, "Typ 2", ... 7, "Typ 7",
 *         8, "Typ 8", 9, "Typ 9", ...
 *
 * Those are not columns, they are a stream of pairs wrapped where the line ran
 * out, and lining them up put the strings 30 characters from the numbers they
 * belong to. So the value rows must actually agree: **every row carrying a
 * comma has the same number of cells**, or none of them is moved. Rows with no
 * comma at all — `put \` opening the statement, `then` closing it — are not
 * part of the table and neither widen it nor get widened.
 *
 * **The head row is judged separately**, because it is the one row that is not
 * only values: it carries the command, and whatever arguments come before the
 * list proper. That is the ordinary shape of a GDL table —
 *
 *     poly2_b 5, 1+2*bDrawFill+64, gs_fill_pen, gs_back_pen,
 *         -RAD_BLIND_SPOUT, 0,      1,
 *         -RAD_BLIND_SPOUT, -0.007, 1,
 *          RAD_BLIND_SPOUT, 0,      1
 *
 * — four cells of preamble over rows of three. Requiring the head to agree with
 * them left every `POLY2_B`, `PRISM_`, `COOR`, `TUBE` and `EXTRUDE` in the
 * corpus untouched, which is most of what anyone would reach for this command
 * to do: 2860 tables in 313 files, the coordinate lists this exists for. So a
 * head row of a different width is simply not a row of the table. The rows
 * below line up with each other and its own spacing is left as the author wrote
 * it, which is also what keeps it from dragging column 1 out to the width of a
 * command — the very thing that spoiled the `VALUES{2}` above. Where the head
 * *does* agree — `put 1, 2, 3,` over more triples — it takes part as before.
 *
 * The last row is held to the same width as the rest, though it is the one row
 * that could honestly run short, the list having ended. Letting it off brought
 * the `VALUES{2}` stream straight back: its wrapped rows agree by accident and
 * only the remainder at the end does not, so the exemption made it a table.
 *
 * Statements that fail all this still have their `\` and comment columns
 * aligned; those never depended on the cells lining up.
 */
function tableRows(rows: readonly Row[]): ReadonlySet<number> {
	const none: ReadonlySet<number> = new Set();
	const values = rows.map((_, i) => i).filter((i) => rows[i].cells.length > 1);
	// The head is judged against the body, never the other way round.
	const body = values.filter((i) => i !== 0);
	if (body.length === 0) return none;
	const width = rows[body[0]].cells.length;
	if (!body.every((i) => rows[i].cells.length === width)) return none;
	const table = new Set(body);
	if (values[0] === 0 && rows[0].cells.length === width) table.add(0);
	return table.size < 2 ? none : table;
}

/**
 * Lays a statement's rows out in columns.
 *
 * Returns the gaps to rewrite, or undefined when the result would be too long
 * and the statement must therefore be left as it is.
 */
function layout(rows: Row[], text: string, opts: AlignOptions): Gap[] | undefined {
	const limit = opts.maxLineLength ?? MAX_LINE_LENGTH;
	const cellText = (r: Row, c: number) => text.slice(r.cells[c].start, r.cells[c].end);

	// Column 0 stays where the author put it, so the columns after it are
	// measured from wherever each row actually starts.
	const startCol = rows.map(() => [] as number[]);
	const endCol = rows.map(() => [] as number[]);
	rows.forEach((r, i) => {
		startCol[i][0] = advance(text.slice(r.lineStart, r.cells[0].start), 0, opts.tabSize);
		endCol[i][0] = advance(cellText(r, 0), startCol[i][0], opts.tabSize);
	});

	/**
	 * Where a column lands, or undefined for a column with only one row in it.
	 *
	 * A column of one is nothing to line up with, so its gap is left exactly as
	 * written. That is what keeps the idiomatic `put \` from being re-spaced,
	 * and it is why a ragged last cell is not nudged either — the formatter
	 * aligns tables, it does not re-space arithmetic.
	 */
	const columnOf = (
		participants: number[],
		prevEnd: (i: number) => number,
	): number | undefined => {
		if (participants.length < 2) return undefined;
		return Math.max(...participants.map((i) => nextStop(prevEnd(i), opts)));
	};

	// Every column is measured whether or not it is aligned: the `\` and the
	// comment sit at the end of the row, so their columns are only as good as
	// the running width of the cells in front of them.
	const table = tableRows(rows);
	const columns = Math.max(...rows.map((r) => r.cells.length));
	const cellTarget: (number | undefined)[] = [];
	for (let c = 1; c < columns; c++) {
		// A row outside the table is still measured — the `\` and the comment sit
		// at the end of it — but it is neither moved nor allowed to widen a column.
		const present = rows.map((_, i) => i).filter((i) => rows[i].cells.length > c);
		const target = columnOf(present.filter((i) => table.has(i)), (i) => endCol[i][c - 1]);
		cellTarget[c] = target;
		for (const i of present) {
			const gap = text.slice(rows[i].cells[c - 1].end, rows[i].cells[c].start);
			startCol[i][c] = (table.has(i) ? target : undefined) ?? advance(gap, endCol[i][c - 1], opts.tabSize);
			endCol[i][c] = advance(cellText(rows[i], c), startCol[i][c], opts.tabSize);
		}
	}

	const lastEnd = (i: number) => endCol[i][rows[i].cells.length - 1];

	// The `\` and the comment line up only with their own kind — see the note
	// on marker columns at the top of the file. A `\` goes further and lines up
	// only within an unbroken run of rows carrying one: it is a boundary mark,
	// saying the row below belongs to this one, so two of them draw an edge
	// only where their rows adjoin. A row without one breaks the edge, and
	// pulling a `\` out to meet another seven rows down aligns it with nothing
	// a reader can see — that was the `call … parameters \ … returned_parameters \`
	// shape, where the first marker was dragged out to the width of the second.
	const contTarget: (number | undefined)[] = rows.map(() => undefined);
	for (const run of runsOf(rows, (r) => r.cont !== undefined)) {
		const target = columnOf(run, lastEnd);
		for (const i of run) contTarget[i] = target;
	}
	const contEnd = (i: number) => {
		const cont = rows[i].cont;
		if (!cont) return lastEnd(i);
		const from = contTarget[i] ?? advance(text.slice(rows[i].cells[rows[i].cells.length - 1].end, cont.start), lastEnd(i), opts.tabSize);
		return from + 1;
	};
	const commentRows = rows.map((_, i) => i).filter((i) => rows[i].comment);
	const commentCol = columnOf(commentRows, contEnd);

	const gaps: Gap[] = [];
	const trims: Gap[] = [];
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		const rowGaps: Gap[] = [];
		let out = text.slice(r.lineStart, r.cells[0].start) + cellText(r, 0);
		let col = endCol[i][0];

		/** Rewrites one gap, or leaves it be when its column has no partner. */
		const gap = (from: number, to: number, target: number | undefined) => {
			const written = text.slice(from, to);
			const pad = target === undefined ? written : padding(col, target, opts);
			if (target !== undefined) rowGaps.push({ start: from, end: to, text: pad });
			out += pad;
			col = advance(pad, col, opts.tabSize);
		};

		for (let c = 1; c < r.cells.length; c++) {
			gap(r.cells[c - 1].end, r.cells[c].start, table.has(i) ? cellTarget[c] : undefined);
			out += cellText(r, c);
			col = endCol[i][c];
		}

		let prevEnd = r.cells[r.cells.length - 1].end;
		if (r.cont) {
			gap(prevEnd, r.cont.start, contTarget[i]);
			out += '\\';
			col++;
			prevEnd = r.cont.end;
		}
		if (r.comment) {
			gap(prevEnd, r.comment.start, commentCol);
			out += text.slice(r.comment.start, r.comment.end);
		} else if (prevEnd < r.lineEnd) {
			// Nothing follows, so trailing whitespace goes — but only if this
			// statement was aligned at all. Trimming a statement we otherwise
			// left alone would put lines in the diff that the command was never
			// asked to touch.
			trims.push({ start: prevEnd, end: r.lineEnd, text: '' });
		}

		// Both tests are on the assembled row: one line over the limit condemns
		// the whole statement, and a line already over it was not ours to widen.
		if (out.length > limit) return undefined;
		if (r.lineEnd - r.lineStart > limit) return undefined;
		gaps.push(...rowGaps);
	}
	if (gaps.some((g) => text.slice(g.start, g.end) !== g.text)) gaps.push(...trims);
	return gaps;
}

/**
 * Aligns every continued list in the document, or in `range` if one is given.
 */
export function provideFormattingEdits(
	doc: GdlDocument,
	td: TextDocument,
	opts: AlignOptions,
	range?: Range,
): TextEdit[] {
	const text = doc.text;
	const lines = new LineIndex(text);
	const from = range ? td.offsetAt(range.start) : 0;
	const to = range ? td.offsetAt(range.end) : text.length;

	const edits: TextEdit[] = [];
	for (const stmt of doc.statements) {
		if (stmt.end < from || stmt.start > to) continue;

		const rows = rowsOf(stmt, text, lines);
		if (!rows) continue;
		const gaps = layout(rows, text, opts);
		if (!gaps) continue;

		for (const gap of gaps) {
			if (text.slice(gap.start, gap.end) === gap.text) continue;
			edits.push({
				range: { start: td.positionAt(gap.start), end: td.positionAt(gap.end) },
				newText: gap.text,
			});
		}
	}
	return edits;
}
