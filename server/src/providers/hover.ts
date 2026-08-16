/**
 * Hover for GDL.
 *
 * Resolution order matters: a library part may name a parameter `WALL_HEIGHT`,
 * shadowing nothing but confusing everything, so we check the concrete, local
 * things first and fall back to the language dictionary last.
 */

import { Hover, MarkupKind, type Position } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenAt, type GdlDocument } from '../gdl/analyzer';
import { lookupWithVariants, validScripts, variantsOf } from '../gdl/keywords';
import { libPartFor } from '../gdl/libpart';
import { isPrivateName, masterScriptFor, type TextResolver } from '../gdl/masterScript';
import { referenceDoc } from '../gdl/referenceDocs';
import { SCRIPT_LABELS } from '../gdl/scriptKind';

/**
 * The line an offset falls on, trimmed — used to show a definition in place.
 * Long lines are cut: an assignment fed by a coordinate list would otherwise
 * stretch the hover across the screen.
 */
function lineAt(text: string, offset: number, limit = 100): string {
	let start = offset;
	while (start > 0 && text[start - 1] !== '\n' && text[start - 1] !== '\r') start--;
	let end = offset;
	while (end < text.length && text[end] !== '\n' && text[end] !== '\r') end++;
	const line = text.slice(start, end).trim();
	return line.length > limit ? line.slice(0, limit - 1).trimEnd() + '…' : line;
}

/**
 * The type column of a fixed parameter's reference page. A handful of the
 * `ifc_` pages repeat the name in it — `ifc_MullionThickness - length` — which
 * is noise once the name is already the hover's heading.
 */
function typeOf(name: string, summary: string): string {
	const prefix = `${name.toLowerCase()} - `;
	return summary.toLowerCase().startsWith(prefix) ? summary.slice(prefix.length) : summary;
}

export function provideHover(
	doc: GdlDocument,
	textDocument: TextDocument,
	position: Position,
	resolve: TextResolver,
): Hover | null {
	const offset = textDocument.offsetAt(position);
	const token = tokenAt(doc, offset);
	if (!token || (token.type !== 'identifier' && token.type !== 'string')) return null;

	const range = {
		start: textDocument.positionAt(token.start),
		end: textDocument.positionAt(token.end),
	};

	const name = token.type === 'string' ? token.text.slice(1, -1) : token.text;
	const lines: string[] = [];

	// 1. A parameter of the owning library part.
	const libpart = libPartFor(doc.uri);
	const param = libpart?.parameters.get(name.toLowerCase());
	if (param) {
		const dims = param.dimensions ? `[${param.dimensions.join('][')}]` : '';
		lines.push('```gdl', `${param.name}${dims}`, '```');
		lines.push(`**${param.typeLabel} parameter** of \`${libpart!.name}\``);
		if (param.description) lines.push('', param.description);

		// A fixed parameter is one Archicad owns — `ac_bottomlevel`, `ifc_optype`
		// — and the XML only carries the label from the settings dialog. What it
		// actually *does* is in the reference guide. The parameter list gives the
		// type, so only the guide's prose is added here.
		if (param.fix) {
			for (const paragraph of referenceDoc(param.name)?.details ?? []) lines.push('', paragraph);
		}

		const flags = [param.hidden ? 'hidden' : null, param.fix ? 'fixed name' : null].filter(Boolean);
		if (flags.length) lines.push('', `_${flags.join(', ')}_`);
		return { contents: { kind: MarkupKind.Markdown, value: lines.join('\n') }, range };
	}

	// 2. A keyword, global or magic string.
	const kw = lookupWithVariants(name);
	if (kw) {
		lines.push('```gdl', kw.syntax ?? kw.name, '```');

		const kindLabel =
			kw.kind === 'global'
				? 'Global variable'
				: kw.kind === 'fixparam'
					? 'Fixed named parameter'
					: kw.kind === 'function'
						? 'Function'
						: kw.kind === 'autotext'
							? 'Autotext'
							: kw.kind === 'query'
								? `${kw.owner ?? 'Query'} string`
								: kw.kind === 'property'
									? 'Built-in property'
									: 'Statement';
		lines.push(`**${kindLabel}** · ${kw.category}`);

		// The reference guide's own words, read from the GRAPHISOFT extension.
		// Globals are the ones that need it: the keyword list gives `SYMB_POS_X`
		// a name and nothing else.
		//
		// Fixed parameters get it too, but their first column is the parameter's
		// *type* rather than a gloss, so it is labelled as one. In practice this
		// is the `ac_`/`ifc_` set, plus a handful of deprecated `gs_*` ones that
		// are documented just as well — the directory decides, so there is no
		// prefix test here.
		const documented = kw.kind === 'global' || kw.kind === 'fixparam';
		const reference = documented ? referenceDoc(kw.name) : undefined;
		if (reference) {
			lines.push(
				'',
				kw.kind === 'fixparam' ? `**Type:** ${typeOf(kw.name, reference.summary)}` : reference.summary,
			);
			for (const paragraph of reference.details) lines.push('', paragraph);
			if (reference.defaultValue) lines.push('', `**Default:** \`${reference.defaultValue}\``);
		}

		if (kw.note) lines.push('', kw.note);
		if (kw.direction) {
			lines.push('', `_Archicad ${kw.direction === 'set' ? 'writes' : 'reads'} this parameter._`);
		}
		if (kw.deprecated) lines.push('', '⚠️ **Deprecated.**');
		if (kw.reserved) {
			lines.push('', '⚠️ **Reserved** — exists for compatibility or is not publicised.');
		}

		const variants = variantsOf(name).filter((v) => v.name !== kw.name);
		if (variants.length) {
			lines.push('', `Variants: ${variants.map((v) => `\`${v.name}\``).join(', ')}`);
		}

		// Narrowed by the guide's availability matrix where it has one, so this
		// no longer contradicts a summary that says "do not use in parameter
		// script" two lines above.
		const scripts = validScripts(kw);
		lines.push('', `_Valid in: ${scripts.map((s) => SCRIPT_LABELS[s]).join(', ')}_`);

		// Flag it when the name is used outside the scripts it belongs to.
		if (doc.script && !scripts.includes(doc.script)) {
			lines.push('', `⚠️ Not normally valid in the **${SCRIPT_LABELS[doc.script]}**.`);
		}

		return { contents: { kind: MarkupKind.Markdown, value: lines.join('\n') }, range };
	}

	// 3. A variable defined in this script.
	const variable = doc.variables.get(name.toLowerCase());
	if (variable) {
		lines.push('```gdl', variable.name, '```');
		lines.push(variable.isParameterWrite ? '**Parameter** (written back via `PARAMETERS`)' : '**Local variable**');
		lines.push('', `${variable.references.length} reference${variable.references.length === 1 ? '' : 's'} in this script`);
		return { contents: { kind: MarkupKind.Markdown, value: lines.join('\n') }, range };
	}

	// 4. A variable the master script published. It runs before every other
	// script, so its names are in scope here without appearing anywhere in this
	// file — which is exactly why hovering one is worth answering: otherwise
	// the reader has no way to tell it from a typo without opening `1d.gdl`.
	const master = masterScriptFor(doc.uri, doc.script, resolve);
	const shared = master?.variables.get(name.toLowerCase());
	if (master && shared) {
		lines.push('```gdl', lineAt(master.text, shared.definedAt), '```');
		lines.push(
			shared.isParameterWrite
				? '**Parameter**, written back by the master script via `PARAMETERS`'
				: '**Master-script variable**',
		);
		lines.push('', `${shared.references.length} reference${shared.references.length === 1 ? '' : 's'} in \`1d.gdl\``);
		if (isPrivateName(shared.name)) {
			// House style, not a language rule — hence the hover rather than a
			// diagnostic. Completion hides these names outside their own script.
			lines.push('', '⚠️ The leading `_` marks it private to the master script by convention.');
		}
		return { contents: { kind: MarkupKind.Markdown, value: lines.join('\n') }, range };
	}

	return null;
}
