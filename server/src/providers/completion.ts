/**
 * Completion for GDL.
 *
 * The list is assembled from five sources, ranked so the most context-specific
 * come first:
 *
 *   1. Parameters of the owning library part (from paramlist.xml)
 *   2. Variables assigned earlier in this script
 *   3. Shared variables from the master script, which runs before every other
 *      script — excluding `_`-prefixed names, which are private by convention
 *   4. Statements & functions legal in THIS script kind
 *   5. Global variables
 *
 * Filtering keywords by script kind is the point: offering `CUTPLANE` inside a
 * parameter script is noise, and no TextMate grammar can avoid it.
 */

import {
	CompletionItem,
	CompletionItemKind,
	InsertTextFormat,
	MarkupKind,
} from 'vscode-languageserver/node';
import type { GdlDocument } from '../gdl/analyzer';
import { keywordsFor, validScripts, type GdlKeyword } from '../gdl/keywords';
import { referenceDoc } from '../gdl/referenceDocs';
import { libPartFor } from '../gdl/libpart';
import { masterScriptVariables, type TextResolver } from '../gdl/masterScript';
import { SCRIPT_LABELS } from '../gdl/scriptKind';

/** Sort keys — lower sorts first in VS Code's completion list. */
const SORT = {
	parameter: '1',
	variable: '2',
	master: '3',
	statement: '4',
	function: '4',
	global: '5',
	other: '6',
} as const;

function completionKind(kw: GdlKeyword): CompletionItemKind {
	switch (kw.kind) {
		case 'function':
			return CompletionItemKind.Function;
		case 'global':
			return CompletionItemKind.Constant;
		case 'fixparam':
			return CompletionItemKind.Property;
		case 'autotext':
		case 'query':
		case 'property':
			return CompletionItemKind.Value;
		case 'operator':
			return CompletionItemKind.Operator;
		default:
			return CompletionItemKind.Keyword;
	}
}

export function provideCompletion(doc: GdlDocument, resolve: TextResolver = () => undefined): CompletionItem[] {
	const items: CompletionItem[] = [];
	const seen = new Set<string>();

	// 1. Library part parameters — the highest-signal completions there are.
	const libpart = libPartFor(doc.uri);
	if (libpart) {
		for (const param of libpart.parameters.values()) {
			seen.add(param.name.toLowerCase());
			items.push({
				label: param.name,
				kind: CompletionItemKind.Field,
				detail: `${param.typeLabel} parameter${param.hidden ? ' (hidden)' : ''}`,
				documentation: param.description
					? { kind: MarkupKind.Markdown, value: param.description }
					: undefined,
				sortText: SORT.parameter + param.name,
			});
		}
	}

	// 2. Variables assigned in this script.
	for (const [lower, info] of doc.variables) {
		if (seen.has(lower)) continue;
		seen.add(lower);
		items.push({
			label: info.name,
			kind: CompletionItemKind.Variable,
			detail: info.isParameterWrite ? 'parameter (written back)' : 'local variable',
			sortText: SORT.variable + info.name,
		});
	}

	// 3. Shared state from the master script, which has already run by the time
	// this script does.
	for (const variable of masterScriptVariables(doc.uri, doc.script, resolve)) {
		const lower = variable.name.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);
		items.push({
			label: variable.name,
			kind: CompletionItemKind.Variable,
			detail: 'master script variable',
			sortText: SORT.master + variable.name,
		});
	}

	// 4 & 5. Keywords legal in this script.
	for (const kw of keywordsFor(doc.script)) {
		if (kw.kind === 'operator') continue;
		const lower = kw.name.toLowerCase();
		if (seen.has(lower)) continue;
		seen.add(lower);

		const sortGroup =
			kw.kind === 'global' ? SORT.global : kw.kind in SORT ? SORT[kw.kind as keyof typeof SORT] : SORT.other;

		items.push({
			label: kw.name,
			kind: completionKind(kw),
			detail: kw.deprecated ? `${kw.category} — deprecated` : kw.category,
			sortText: sortGroup + kw.name,
			insertTextFormat: InsertTextFormat.PlainText,
			tags: kw.deprecated ? [1 /* CompletionItemTag.Deprecated */] : undefined,
			data: { keyword: kw.name },
		});
	}

	return items;
}

/** Fills in documentation lazily — the full list is too large to build eagerly. */
export function resolveCompletion(item: CompletionItem, doc: GdlDocument | undefined): CompletionItem {
	const name = (item.data as { keyword?: string } | undefined)?.keyword;
	if (!name) return item;

	const kw = keywordsFor(doc?.script).find((k) => k.name === name);
	if (!kw) return item;

	const lines: string[] = [];
	if (kw.syntax) lines.push('```gdl', kw.syntax, '```');

	// The guide's one-line gloss, where it has one — the whole point of the
	// list for a global. Hover shows the detail paragraphs too; a completion
	// item wants the short answer.
	const summary = kw.kind === 'global' ? referenceDoc(kw.name)?.summary : undefined;
	if (summary) lines.push(summary);

	if (kw.note) lines.push(kw.note);
	if (kw.deprecated) lines.push('⚠️ **Deprecated.**');
	if (kw.reserved) lines.push('⚠️ **Reserved** — exists for compatibility or is not publicised.');
	if (kw.owner) lines.push(`Used with \`${kw.owner}\`.`);

	const scripts = validScripts(kw).map((s) => SCRIPT_LABELS[s]).join(', ');
	lines.push('', `_Valid in: ${scripts}_`);

	item.documentation = { kind: MarkupKind.Markdown, value: lines.join('\n') };
	return item;
}
