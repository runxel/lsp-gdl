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
 *
 * ## Values, which outrank all five
 *
 * One position knows far more than any of that. After `IF GLOB_VIEW_TYPE =` the
 * answer is not "every name in scope" but one of eight numbers, and the editor
 * can say which — see `gdl/valueLists.ts` for where the eight come from.
 *
 * So a value position is answered with values, and the two ways of arriving
 * there are treated differently:
 *
 *   - **Typing the operator** (`=`, `#`, the `>` closing a `<>`) returns the
 *     values *and nothing else*, or an empty list where none are known. A
 *     trigger character that popped the whole keyword table after every
 *     assignment in the file would be a nuisance, and turning the feature off
 *     is not the answer — saying nothing is.
 *   - **Asking for completions** — Ctrl+Space, or typing into the value — puts
 *     the values at the head of the ordinary list, where a name may still be
 *     what is wanted: `iMarkerDir = iDefaultDir` is perfectly good GDL.
 */

import {
	CompletionItem,
	CompletionItemKind,
	InsertTextFormat,
	MarkupKind,
} from 'vscode-languageserver/node';
import type { GdlDocument } from '../gdl/analyzer';
import { valueNameAt, valuesFor, type EnumValue, type ValueSet } from '../gdl/valueLists';
import { keywordsFor, validScripts, type GdlKeyword } from '../gdl/keywords';
import { referenceDoc } from '../gdl/referenceDocs';
import { libPartFor } from '../gdl/libpart';
import { masterScriptVariables, type TextResolver } from '../gdl/masterScript';
import { SCRIPT_LABELS } from '../gdl/scriptKind';

/** Sort keys — lower sorts first in VS Code's completion list. */
const SORT = {
	/** A legal value of the name being compared: nothing beats knowing the answer. */
	value: '0',
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

/** Where completions were asked for, and how. */
export interface CompletionSite {
	/** Cursor offset in the document. */
	readonly offset: number;
	/** True when the editor triggered on an operator rather than being asked. */
	readonly triggered: boolean;
}

/**
 * One legal value, as an item.
 *
 * The meaning goes in `detail`, which VS Code prints beside the label in the
 * list itself — that is the whole feature, and burying it in `documentation`
 * would mean pressing a key to see the thing you came for. The number behind a
 * named constant goes below it: it is not what should be written, but it is
 * what the author of the old code wrote, and it answers the next question.
 */
function valueItem(value: EnumValue, set: ValueSet, name: string, index: number): CompletionItem {
	const notes: string[] = [];
	if (value.meaning) notes.push(`**${value.meaning}**`);
	if (value.numeric !== undefined && String(value.numeric) !== value.insert) {
		notes.push(`\`${name}\` = \`${value.numeric}\``);
	}
	notes.push(
		set.source === 'guide'
			? '_Documented value, from the GDL reference guide._'
			: '_Allowed by this library part\u2019s parameter script._',
	);

	return {
		label: value.insert,
		kind: CompletionItemKind.EnumMember,
		...(value.meaning ? { detail: value.meaning } : {}),
		documentation: { kind: MarkupKind.Markdown, value: notes.join('\n\n') },
		// Padded so the author's own order survives: a value list is written in
		// the order it makes sense to read, not alphabetically.
		sortText: SORT.value + String(index).padStart(3, '0'),
	};
}

/** The values legal at `site`, if it is a value position with a known answer. */
function valueItems(doc: GdlDocument, resolve: TextResolver, site: CompletionSite | undefined): CompletionItem[] {
	if (!site) return [];
	const name = valueNameAt(doc, site.offset);
	if (!name) return [];

	const set = valuesFor(name, doc, resolve);
	if (!set) return [];
	return set.values.map((value, i) => valueItem(value, set, name, i));
}

export function provideCompletion(
	doc: GdlDocument,
	resolve: TextResolver = () => undefined,
	site?: CompletionSite,
): CompletionItem[] {
	const items: CompletionItem[] = valueItems(doc, resolve, site);

	// The operator was just typed, so the author is writing a value and nothing
	// else: answer with what is legal there, or say nothing at all.
	if (site?.triggered) return items;

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
