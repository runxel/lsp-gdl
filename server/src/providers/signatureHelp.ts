/**
 * Signature help for the guide's 2D commands.
 *
 * GDL commands are positional and take no brackets — `POLY2_B n, frame_fill,
 * fill_pen, fill_background_pen, x1, y1, s1, …` — so the fifteenth value on a
 * wrapped line is identified by nothing but its distance from the command word.
 * That is the whole reason this is worth having, and it is also why the trigger
 * characters are unusual: there is no `(` to open on, so a space after the
 * command opens the popup and a comma moves it on.
 *
 * **Counting into the repeating tail is the feature**, not a refinement of it.
 * `POLY2_B` is four fixed arguments and then `x, y, s` per vertex, forty or a
 * hundred values deep; answering "argument 27" would be useless, so a cursor
 * past the fixed part is reported as `y8` — the slot within the group, and
 * which vertex it belongs to. Where the guide's syntax repeats in a shape
 * `commandDocs.ts` does not model (`PROJECT2{4}`, 24 uses in the corpus) there
 * is no repeat to fold into and the fixed part is all that is offered.
 *
 * Bitmask arguments carry their bit table into the parameter's documentation,
 * so `frame_fill` explains itself at the point it is being typed rather than
 * only after the fact — that is the same data `inlayHints.ts` decodes.
 */

import {
	MarkupKind,
	type ParameterInformation,
	type SignatureHelp,
	type SignatureInformation,
} from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Position } from 'vscode-languageserver-textdocument';

import type { GdlDocument, Statement } from '../gdl/analyzer';
import { argumentAt, splitArguments } from '../gdl/arguments';
import { commandDoc, type CommandDoc, type CommandSignature, type MaskBit } from '../gdl/commandDocs';
import { maskTable } from './masks';

/** The statement the offset sits in, if any. */
function statementAt(doc: GdlDocument, offset: number): Statement | undefined {
	return doc.statements.find((stmt) => offset >= stmt.start && offset <= stmt.end);
}

/**
 * Which parameter of the signature an argument index lands on.
 *
 * Before the repeating tail the two are the same. Inside it the index folds
 * back onto the group, and the iteration is reported alongside so the label can
 * say `y8` rather than `y1`.
 */
function resolveParameter(
	signature: CommandSignature,
	argument: number,
): { index: number; iteration?: number } | undefined {
	const repeat = signature.repeat;
	if (repeat && argument >= repeat.start) {
		const within = argument - repeat.start;
		return {
			index: repeat.start + (within % repeat.size),
			iteration: Math.floor(within / repeat.size) + 1,
		};
	}

	if (argument < signature.params.length) return { index: argument };

	// Past the last argument the guide names. `PUT expression [, expression, …]`
	// simply takes more of the same, so it holds; anything else has either been
	// given too many arguments or was cut short by `countable`, and clamping to
	// the last one would claim the cursor is somewhere it is not.
	return signature.variadic ? { index: signature.params.length - 1 } : undefined;
}

/** `x1` in the guide's syntax is `x8` on the eighth vertex. */
function iterationName(name: string, iteration: number): string {
	return /\d$/.test(name) ? name.replace(/\d+$/, String(iteration)) : `${name}${iteration}`;
}

function documentationFor(
	doc: CommandDoc,
	name: string,
	gloss: string | undefined,
	iteration: number | undefined,
): string | undefined {
	const parts: string[] = [];
	if (iteration !== undefined) parts.push(`Repeats — this is ${iterationName(name, iteration)}.`);
	if (gloss) parts.push(gloss);

	const mask: readonly MaskBit[] | undefined = doc.masks.get(name.toLowerCase());
	if (mask) parts.push(maskTable(mask));

	return parts.length ? parts.join('\n\n') : undefined;
}

export function provideSignatureHelp(
	gdl: GdlDocument,
	textDocument: TextDocument,
	position: Position,
): SignatureHelp | null {
	const offset = textDocument.offsetAt(position);
	const stmt = statementAt(gdl, offset);
	if (!stmt?.head) return null;

	const doc = commandDoc(stmt.head);
	if (!doc || doc.signatures.length === 0) return null;

	// The cursor must be past the command word — on the word itself there is no
	// argument yet, and a popup over a name being typed is noise.
	const head = stmt.tokens[0];
	if (offset <= head.end) return null;

	const argument = argumentAt(splitArguments(stmt), offset);

	const signatures: SignatureInformation[] = [];
	for (const signature of doc.signatures) {
		const resolved = resolveParameter(signature, argument);
		if (!resolved) continue;
		const { index, iteration } = resolved;
		const parameters: ParameterInformation[] = signature.params.map((param, at) => {
			const documentation = documentationFor(
				doc,
				param.name,
				param.documentation,
				at === index ? iteration : undefined,
			);
			return {
				label: [param.label[0], param.label[1]] as [number, number],
				...(documentation ? { documentation: { kind: MarkupKind.Markdown, value: documentation } } : {}),
			};
		});
		signatures.push({ label: signature.label, parameters, activeParameter: Math.max(index, 0) });
	}

	// Every form was exhausted — the statement has more arguments than the guide
	// can account for, and a popup pointing at the wrong one is worse than none.
	if (signatures.length === 0) return null;

	// The guide writes one syntax line per command bar a handful — `FRAGMENT2`,
	// `LOCK`, `CALL` — which spell their forms separately; the first is general.
	return { signatures, activeSignature: 0, activeParameter: signatures[0].activeParameter ?? 0 };
}
