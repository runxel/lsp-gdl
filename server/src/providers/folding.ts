/**
 * Folding ranges.
 *
 * Until a server answers this, VS Code folds a `.gdl` file by indentation, and
 * the moment one does, indentation folding is switched off for the language —
 * the provider's answer is the whole answer. So this must give at least what
 * indentation did, and the point of it is what indentation cannot see:
 *
 * - **Blocks** — `IF`/`ENDIF`, `FOR`/`NEXT`, both `WHILE` loops,
 *   `REPEAT`/`UNTIL`, `GROUP`/`ENDGROUP`, `PARAGRAPH`/`ENDPARAGRAPH` — found by
 *   the same rules `checkBlocks` uses, from `gdl/blocks.ts`, so an unindented
 *   block folds just as an indented one does. An `IF` with an `ELSE` folds as
 *   two branches, the closer and the `ELSE` staying in view.
 * - **Subroutines** — a label through the `RETURN` that leaves it.
 * - **Wrapped statements** — a coordinate list continued over forty rows is the
 *   longest thing in most 3D scripts, and its rows are rarely indented.
 * - **Comment runs**, and **`! #region` … `! #endregion`** markers, read
 *   through `gdl/regions.ts`, which the document symbols share.
 *
 * Every range is whole lines, which is all VS Code folds.
 */

import { FoldingRange, FoldingRangeKind } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { GdlDocument, Statement } from '../gdl/analyzer';
import { closesBlock, opensBlock } from '../gdl/blocks';
import { regionMarker, regions, standsAlone } from '../gdl/regions';

export function provideFoldingRanges(doc: GdlDocument, td: TextDocument): FoldingRange[] {
	const lineOf = (offset: number) => td.positionAt(offset).line;
	const ranges: FoldingRange[] = [];
	const add = (startLine: number, endLine: number, kind?: FoldingRangeKind) => {
		if (endLine > startLine) ranges.push(kind ? { startLine, endLine, kind } : { startLine, endLine });
	};

	foldBlocks(doc.statements, lineOf, add);
	foldSubroutines(doc.statements, lineOf, add);

	// A wrapped statement folds from its first row to its last. One that also
	// opens a block starts on the same line as the block's fold, and `nest`
	// keeps the block's, being the longer.
	for (const stmt of doc.statements) add(lineOf(stmt.start), lineOf(stmt.end));

	foldComments(doc, td, add);

	return nest(ranges);
}

type Add = (startLine: number, endLine: number, kind?: FoldingRangeKind) => void;

/**
 * Each block folds from its opener's first line to the line before its closer,
 * so the `ENDIF` stays in view — what indentation folding did, and what every
 * brace language does with its `}`.
 *
 * Unlike `checkBlocks`, which reports a mismatched closer and leaves the stack
 * alone, this recovers: a closer pops down to the nearest opener of its kind,
 * dropping whatever unclosed blocks stand above it. One missing `ENDIF` is
 * then one block without a fold, rather than every block after it — the
 * diagnostic already says where the mistake is.
 */
function foldBlocks(statements: readonly Statement[], lineOf: (offset: number) => number, add: Add) {
	const stack: { label: string; startLine: number }[] = [];

	for (const stmt of statements) {
		if (!stmt.head) continue;
		const line = lineOf(stmt.start);

		// `ELSE` heading its own statement ends one branch of the `IF` it
		// belongs to and starts the next.
		const top = stack[stack.length - 1];
		if (stmt.head === 'else' && top?.label === 'IF') {
			add(top.startLine, line - 1);
			top.startLine = line;
			continue;
		}

		const closes = closesBlock(stmt);
		if (closes) {
			let i = stack.length - 1;
			while (i >= 0 && stack[i].label !== closes) i--;
			if (i < 0) continue;
			add(stack[i].startLine, line - 1);
			stack.length = i;
			continue;
		}

		const opens = opensBlock(stmt);
		if (opens) stack.push({ label: opens, startLine: line });
	}
}

/** `100:` or `"draw handle":` — the shape `analyzer.ts` reads a label from. */
function isLabel(stmt: Statement): boolean {
	const [name, colon] = stmt.tokens;
	return (
		stmt.tokens.length === 2 &&
		(name.type === 'number' || name.type === 'string') &&
		colon.type === 'operator' &&
		colon.text === ':'
	);
}

/**
 * A subroutine folds from its label through the `RETURN` that leaves it, the
 * `RETURN` included: collapsed, a run of subroutines then reads as a list of
 * their names, which is what anyone folding them wants to see.
 *
 * That `RETURN` is the first one at the label's own block depth — an early
 * `IF done THEN RETURN` sits deeper and is not the end. The search gives up at
 * the next label, or if a block the label sat inside closes first, either of
 * which means the label was not heading a subroutine: a `GOTO` target in the
 * middle of the main body, or one label falling through into the next. Those
 * get no fold rather than one swallowing whatever follows.
 *
 * Labels stacked with nothing between them are one routine under several
 * names — `"LoD100":` … `"LoD350":` over a single body in `Generic_hinge_macro`
 * — so a label standing straight under another does not end the search. Each
 * name folds through the shared `RETURN`, nested, and collapsing the outermost
 * leaves the first name alone in view.
 */
function foldSubroutines(statements: readonly Statement[], lineOf: (offset: number) => number, add: Add) {
	// The block depth before each statement, computed as `foldBlocks` walks.
	const depths: number[] = [];
	const stack: string[] = [];
	for (const stmt of statements) {
		depths.push(stack.length);
		const closes = closesBlock(stmt);
		if (closes) {
			const i = stack.lastIndexOf(closes);
			if (i >= 0) stack.length = i;
			continue;
		}
		const opens = opensBlock(stmt);
		if (opens) stack.push(opens);
	}

	for (let i = 0; i < statements.length; i++) {
		if (!isLabel(statements[i])) continue;
		const depth = depths[i];
		let stacked = true;
		for (let j = i + 1; j < statements.length; j++) {
			const stmt = statements[j];
			if (depths[j] < depth) break;
			if (isLabel(stmt)) {
				if (stacked) continue;
				break;
			}
			stacked = false;
			if (stmt.head === 'return' && depths[j] === depth) {
				add(lineOf(statements[i].start), lineOf(stmt.end));
				break;
			}
		}
	}
}

/**
 * Runs of whole-line comments fold as comments, and region markers fold the
 * lines between them, the `#endregion` line included so the region's name is
 * the only line left in view. A marker line is never part of a run: a
 * description written straight under `! #region` would otherwise start a fold
 * on the same line as the region's, and only one of them could survive.
 */
function foldComments(doc: GdlDocument, td: TextDocument, add: Add) {
	const lineOf = (offset: number) => td.positionAt(offset).line;
	for (const region of regions(doc)) add(lineOf(region.start), lineOf(region.end), FoldingRangeKind.Region);

	let runStart = -1;
	let runEnd = -1;
	const endRun = () => {
		add(runStart, runEnd, FoldingRangeKind.Comment);
		runStart = runEnd = -1;
	};

	for (const tok of doc.tokens) {
		if (tok.type !== 'comment' || !standsAlone(doc.text, tok)) continue;
		if (regionMarker(doc.text, tok)) {
			if (runStart >= 0) endRun();
			continue;
		}

		const line = lineOf(tok.start);
		if (runStart >= 0 && line === runEnd + 1) {
			runEnd = line;
		} else {
			if (runStart >= 0) endRun();
			runStart = runEnd = line;
		}
	}
	if (runStart >= 0) endRun();
}

/**
 * Ranges VS Code can show: one per start line, and each either inside another
 * or clear of it. The rules above produce that on well-formed code, but a
 * region marker may straddle a block, and a statement wrapped onto the line an
 * `ENDIF` closes on overlaps the block's last line. VS Code would silently
 * drop such a range anyway; doing it here makes the answer deterministic — on
 * a shared start line the longer range wins, and a crossing range loses to the
 * one that began first.
 */
function nest(ranges: FoldingRange[]): FoldingRange[] {
	ranges.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
	const kept: FoldingRange[] = [];
	const open: FoldingRange[] = [];
	for (const range of ranges) {
		if (kept.length > 0 && kept[kept.length - 1].startLine === range.startLine) continue;
		while (open.length > 0 && open[open.length - 1].endLine < range.startLine) open.pop();
		const parent = open[open.length - 1];
		if (parent && range.endLine > parent.endLine) continue;
		kept.push(range);
		open.push(range);
	}
	return kept;
}
