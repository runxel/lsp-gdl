/**
 * Quick fixes.
 *
 * A check that knows its own repair works it out while it still holds the
 * statements, and hands it over in the diagnostic's `data` — which the protocol
 * carries from the diagnostic report into the code-action request untouched.
 * So nothing is re-derived here, and this module holds no language knowledge:
 * it only turns a `QuickFix` back into a `CodeAction`.
 *
 * The first, and so far only, producer is `checkMissingContinuations` in
 * `diagnostics.ts`.
 */

import { CodeAction, CodeActionKind, type Diagnostic, type TextEdit } from 'vscode-languageserver/node';
import { SOURCE } from './diagnostics';

/** What a diagnostic's `data` holds when it can be fixed in place. */
export interface QuickFix {
	readonly quickFix: {
		readonly title: string;
		readonly edits: readonly TextEdit[];
	};
}

function isQuickFix(data: unknown): data is QuickFix {
	const fix = (data as QuickFix | undefined)?.quickFix;
	return typeof fix?.title === 'string' && Array.isArray(fix.edits);
}

export function provideCodeActions(uri: string, diagnostics: readonly Diagnostic[]): CodeAction[] {
	const actions: CodeAction[] = [];
	for (const d of diagnostics) {
		if (d.source !== SOURCE || !isQuickFix(d.data)) continue;
		actions.push({
			title: d.data.quickFix.title,
			kind: CodeActionKind.QuickFix,
			diagnostics: [d],
			isPreferred: true,
			edit: { changes: { [uri]: [...d.data.quickFix.edits] } },
		});
	}
	return actions;
}
