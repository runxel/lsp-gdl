/**
 * Rename for GDL.
 *
 * The unit of renaming is one HSF library part — the folder holding
 * `paramlist.xml` and `scripts/`. Getting the *scope* right is the whole
 * problem, because GDL's scripts do not share a namespace the way a normal
 * module system does:
 *
 *   - The **master script** (`1d.gdl`) runs before every other script, so a
 *     variable it defines is visible everywhere. Renaming it must touch all
 *     scripts.
 *   - The **parameter script** (`vl.gdl`) likewise reaches across the object.
 *   - Every other script runs independently of its siblings. A `count` in
 *     `2d.gdl` and a `count` in `3d.gdl` are *different variables that merely
 *     share a name*. Renaming one must NOT touch the other.
 *   - **Parameters** from `paramlist.xml` are in scope in all scripts, and are
 *     referred to both as bare identifiers and as string literals
 *     (`VALUES "iDetail"`, `LOCK "bFrame"`), so both spellings must change —
 *     as must the `Name=` attribute in the XML itself.
 *
 * **Groups** are the exception to all of that, and they scope the other way.
 * The guide has group names unique "inside the current script", and a group is
 * cleared when interpretation ends, so a rename of one never leaves the file it
 * was typed in — not even from `1d.gdl`. Both spellings are handled:
 *
 *   - `GROUP fixingGroup` names the group through a variable, so renaming it is
 *     an ordinary variable rename and takes the ordinary variable scope.
 *   - `GROUP "gr_leg"` names it with a *string*, which no other rename here
 *     touches. Only the strings GDL actually reads as a group are rewritten —
 *     a `TEXT2 0, 0, "gr_leg"` in the same script is prose and stays put.
 *
 * Names Archicad owns — keywords, globals, and fixed parameters such as `A`,
 * `zzyzx` or `ac_bottomlevel` — are refused outright.
 */

import {
	Range,
	TextEdit,
	type WorkspaceEdit,
	type Position,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { tokenize, type Token } from '../gdl/lexer';
import { analyze, tokenAt, type GdlDocument } from '../gdl/analyzer';
import { lookup } from '../gdl/keywords';
import { libPartFor, libPartScripts, paramListPath, type GdlParameter } from '../gdl/libpart';
import { groupNameAt, groupNames, type GroupName } from '../gdl/groups';
import { URI } from 'vscode-uri';
import { readFileSync } from 'node:fs';

/** Supplies current text for a URI, preferring unsaved editor content. */
export type TextResolver = (uri: string) => string | undefined;

/** Scripts whose variables are visible to every other script of the object. */
const PROJECT_WIDE_SCRIPTS = new Set(['1d', 'vl']);

const IDENTIFIER_RE = /^[A-Za-z_~][A-Za-z0-9_]*$/;

/**
 * What a group name may not hold. It is a string rather than an identifier, so
 * it takes far more than a variable may — `GROUP "simple tap style"` is
 * idiomatic — and only two things are genuinely out: one of the three string
 * delimiters, which would close the literal early wherever the name is spelt
 * with that one, and a line break, which no GDL string may cross.
 */
const BAD_IN_GROUP_NAME = /["'`\r\n]/;

export class RenameError extends Error {}

interface RenameTarget {
	readonly name: string;
	readonly range: Range;
	readonly parameter?: GdlParameter;
	/** Set when the cursor is on a group named by a string literal. */
	readonly group?: GroupName;
	/** Rename across the whole library part rather than this file alone. */
	readonly projectWide: boolean;
}

function readText(uri: string, resolve: TextResolver): string | undefined {
	const open = resolve(uri);
	if (open !== undefined) return open;
	try {
		return readFileSync(URI.parse(uri).fsPath, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * Identifies what is under the cursor and how far a rename of it must reach.
 * Throws `RenameError` with a user-facing reason when the symbol cannot be
 * renamed at all.
 */
export function resolveRenameTarget(
	doc: GdlDocument,
	td: TextDocument,
	position: Position,
	resolve: TextResolver,
): RenameTarget {
	const offset = td.offsetAt(position);

	// A group named by a string. Checked before the token kind, since this is
	// the one rename whose target is a literal rather than an identifier — and
	// only where GDL reads that string as a group. A group named by a *variable*
	// deliberately falls through: it is a variable, and takes a variable's scope.
	const group = groupNameAt(doc, offset);
	if (group?.kind === 'literal') {
		const inner = group.token.text.slice(1, -1);
		return {
			name: inner,
			range: Range.create(
				td.positionAt(group.token.start + 1),
				td.positionAt(group.token.end - 1),
			),
			group,
			projectWide: false,
		};
	}

	const token = tokenAt(doc, offset);
	if (!token || token.type !== 'identifier') {
		throw new RenameError('Only variables, parameters and groups can be renamed.');
	}

	// A dotted name (`pt.start`) renames only its leading segment.
	const name = token.text.split('.')[0];
	const range = Range.create(td.positionAt(token.start), td.positionAt(token.start + name.length));

	const keyword = lookup(name);
	if (keyword) {
		const what =
			keyword.kind === 'global'
				? 'a global variable'
				: keyword.kind === 'fixparam'
					? 'a fixed parameter name set by Archicad'
					: `a GDL ${keyword.kind}`;
		throw new RenameError(`\`${keyword.name}\` is ${what} and cannot be renamed.`);
	}

	const libpart = libPartFor(doc.uri);
	const parameter = libpart?.parameters.get(name.toLowerCase());
	if (parameter?.fix) {
		throw new RenameError(
			`\`${parameter.name}\` is a fixed parameter of this library part and cannot be renamed.`,
		);
	}

	if (parameter) {
		return { name, range, parameter, projectWide: true };
	}

	// Not a parameter: project-wide only if the master or parameter script
	// defines it, since those two run across the whole object.
	const projectWide = libpart
		? libPartScripts(libpart.root).some((script) => {
				if (!PROJECT_WIDE_SCRIPTS.has(script.kind)) return false;
				const text = readText(script.uri, resolve);
				if (text === undefined) return false;
				return analyze(script.uri, text).variables.has(name.toLowerCase());
			})
		: false;

	return { name, range, projectWide };
}

/**
 * Occurrences of `name` in one script.
 *
 * Identifier matches are case-insensitive, as GDL is. String matches are only
 * collected for parameters, where a literal spelling of the name is a genuine
 * reference rather than prose.
 */
function occurrencesIn(
	text: string,
	oldName: string,
	newName: string,
	includeStrings: boolean,
): TextEdit[] {
	const lower = oldName.toLowerCase();
	const td = TextDocument.create('inmemory://scan', 'gdl-hsf', 0, text);
	const edits: TextEdit[] = [];

	const edit = (start: number, length: number) => {
		edits.push(TextEdit.replace(Range.create(td.positionAt(start), td.positionAt(start + length)), newName));
	};

	for (const tok of tokenize(text) as Token[]) {
		if (tok.type === 'identifier') {
			if (tok.lower === lower) {
				edit(tok.start, tok.text.length);
				continue;
			}
			// Dict member access: rename only the leading segment of `pt.start`.
			if (tok.lower.startsWith(lower + '.')) {
				edit(tok.start, lower.length);
			}
			continue;
		}
		if (includeStrings && tok.type === 'string' && !tok.unterminated) {
			const inner = tok.text.slice(1, -1);
			if (inner.toLowerCase() === lower) {
				edit(tok.start + 1, inner.length);
			}
		}
	}
	return edits;
}

/** Rewrites the `Name=` attribute of one parameter in paramlist.xml. */
function paramListEdit(xmlPath: string, oldName: string, newName: string): TextEdit[] {
	let xml: string;
	try {
		xml = readFileSync(xmlPath, 'utf8');
	} catch {
		return [];
	}
	const td = TextDocument.create('inmemory://paramlist', 'xml', 0, xml);
	const edits: TextEdit[] = [];
	const re = /(<\w+\s+Name=")([^"]*)(")/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(xml)) !== null) {
		if (m[2].toLowerCase() !== oldName.toLowerCase()) continue;
		const start = m.index + m[1].length;
		edits.push(
			TextEdit.replace(Range.create(td.positionAt(start), td.positionAt(start + m[2].length)), newName),
		);
	}
	return edits;
}

/**
 * Rewrites every string that names this group, in this script and no other.
 *
 * The edit lands *inside* the quotes, which keeps whichever delimiter the
 * author used at each site — the same group may well be written `"gr_leg"` in
 * one line and `'gr_leg'` in the next, the second spelling being how a `"` is
 * embedded elsewhere.
 */
function renameGroup(
	doc: GdlDocument,
	td: TextDocument,
	group: GroupName,
	newName: string,
): WorkspaceEdit {
	if (!newName) {
		throw new RenameError('A group name cannot be empty.');
	}
	if (BAD_IN_GROUP_NAME.test(newName)) {
		throw new RenameError('A group name cannot contain a quote mark or a line break.');
	}

	const names = groupNames(doc);
	const wanted = newName.toLowerCase();

	// The guide requires group names to be unique within a script, so renaming
	// one onto another would silently merge two sets of bodies.
	if (names.some((n) => n.kind === 'literal' && n.key === wanted && n.key !== group.key)) {
		throw new RenameError(
			`\`${newName}\` is already a group in this script — group names must be unique within one script.`,
		);
	}

	const edits = names
		.filter((n) => n.kind === 'literal' && n.key === group.key)
		.map((n) =>
			TextEdit.replace(
				Range.create(td.positionAt(n.token.start + 1), td.positionAt(n.token.end - 1)),
				newName,
			),
		);

	return { changes: { [doc.uri]: edits } };
}

export function provideRename(
	doc: GdlDocument,
	td: TextDocument,
	position: Position,
	newName: string,
	resolve: TextResolver,
): WorkspaceEdit {
	const trimmed = newName.trim();

	// What makes a valid new name depends on what is being renamed, so the
	// target is resolved first — a group name is a string and answers to none
	// of the rules an identifier does.
	const target = resolveRenameTarget(doc, td, position, resolve);

	if (target.group) return renameGroup(doc, td, target.group, trimmed);

	if (!IDENTIFIER_RE.test(trimmed)) {
		throw new RenameError(
			`\`${trimmed}\` is not a valid GDL name — use letters, digits and underscores, not starting with a digit.`,
		);
	}
	const clash = lookup(trimmed);
	if (clash) {
		throw new RenameError(`\`${clash.name}\` is already a GDL ${clash.kind} — pick another name.`);
	}

	const changes: Record<string, TextEdit[]> = {};

	const libpart = libPartFor(doc.uri);

	// Script-local: siblings may hold an unrelated variable of the same name,
	// so the edit must not leave this file.
	if (!target.projectWide || !libpart) {
		changes[doc.uri] = occurrencesIn(td.getText(), target.name, trimmed, false);
		return { changes };
	}

	const isParameter = target.parameter !== undefined;
	for (const script of libPartScripts(libpart.root)) {
		const text = readText(script.uri, resolve);
		if (text === undefined) continue;
		const edits = occurrencesIn(text, target.name, trimmed, isParameter);
		if (edits.length) changes[script.uri] = edits;
	}

	if (isParameter) {
		const xmlPath = paramListPath(libpart.root);
		const edits = paramListEdit(xmlPath, target.name, trimmed);
		if (edits.length) changes[URI.file(xmlPath).toString()] = edits;
	}

	return { changes };
}
