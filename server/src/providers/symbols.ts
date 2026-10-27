/**
 * Document symbols: the named regions of a script.
 *
 * `! #region Hotspots` … `! #endregion` names a stretch of script, and listing
 * the names is what makes them worth writing — the Outline, the breadcrumbs and
 * Go to Symbol in Editor (⇧⌘O) then jump straight to one. Which markers pair up
 * is `gdl/regions.ts`'s answer, the one folding reads too.
 *
 * Nothing else is listed, deliberately. GRAPHISOFT's extension already
 * contributes symbols for `gdl-hsf` — subroutines, macro calls and the
 * `! ====` / `! Title` / `! ====` banner — and VS Code shows every provider's
 * symbols side by side, so repeating any of those here would list it twice.
 * The Outline view gives each provider a group of its own, which is what the
 * `label` this provider registers with names.
 */

import { DocumentSymbol, SymbolKind } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';

import type { GdlDocument } from '../gdl/analyzer';
import { regions } from '../gdl/regions';

/** The name of this provider's group in the Outline view. */
export const SYMBOLS_LABEL = 'Regions';

/**
 * Every named region, nested as the regions are. An unnamed region is not
 * listed — VS Code refuses a symbol without a name — and a named one inside it
 * goes to the nearest named region around it instead.
 */
export function provideDocumentSymbols(doc: GdlDocument, td: TextDocument): DocumentSymbol[] {
	const roots: DocumentSymbol[] = [];
	const open: { end: number; symbol: DocumentSymbol }[] = [];

	// Regions arrive in the order they open, and markers nest, so a stack of
	// the ones still open is the whole of the containment test.
	for (const region of regions(doc)) {
		if (region.name === '') continue;
		while (open.length > 0 && open[open.length - 1].end < region.start) open.pop();

		const symbol: DocumentSymbol = {
			name: region.name,
			kind: SymbolKind.Namespace,
			range: { start: td.positionAt(region.start), end: td.positionAt(region.end) },
			selectionRange: { start: td.positionAt(region.nameStart), end: td.positionAt(region.nameEnd) },
			children: [],
		};
		const parent = open[open.length - 1];
		if (parent) parent.symbol.children!.push(symbol);
		else roots.push(symbol);
		open.push({ end: region.end, symbol });
	}

	return roots;
}
