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
 *     (`VALUES "iDetail"`, `LOCK "bFrame"`, `UI_INFIELD "bFrame"`), so both
 *     spellings must change — as must the `Name=` attribute in the XML itself.
 *     A rename starts from either spelling: `gdl/paramNames.ts` says where GDL
 *     reads a string as a parameter name, so the cursor may sit on one.
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
 * **Jump labels** — GDL's subroutines — are the other string-named thing, and
 * they scope like neither. A jump reaches its own script *plus the master*, so
 * a subroutine written in `1d.gdl` is renamed across the whole part while one
 * written anywhere else never leaves its file. Three spellings are rewritten:
 * the definition `"draw handle":`, every `GOSUB` / `GOTO` naming it, and the
 * assignment that hands the name to a variable the script jumps through
 * (`_substr = "EndBlock"` … `GOSUB _substr`). See `gdl/labels.ts`.
 *
 * A **numeric** label is refused, which is the one place this file declines a
 * name it can see. `100:` is jumped to arithmetically (`GOSUB 100 + idx`,
 * `GOSUB i_type * 10`) and aliased through constants (`COUNT_OFFSET = 107`),
 * and neither shape can be rewritten — a rename would leave the object broken
 * in the way this server exists to prevent.
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
import { parameterNameAt } from '../gdl/paramNames';
import {
	labelDefinitionKeys,
	labelDefinitions,
	labelKey,
	labelSitesFor,
	labelSiteAt,
	looseLabelKey,
	type LabelSite,
} from '../gdl/labels';
import { masterScriptFor } from '../gdl/masterScript';
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

/**
 * What a label name may not hold — the same two things as a group name, and
 * for the same reasons: a label is a string too, so `"simple tap style"` is a
 * perfectly good subroutine name.
 */
const BAD_IN_LABEL_NAME = BAD_IN_GROUP_NAME;

/** A name GDL would read as a *numeric* label, whatever the quotes say. */
const NUMERIC_NAME = /^\d+(\.\d+)?$/;

export class RenameError extends Error {}

interface RenameTarget {
	readonly name: string;
	readonly range: Range;
	readonly parameter?: GdlParameter;
	/** Set when the cursor is on a group named by a string literal. */
	readonly group?: GroupName;
	/** Set when the cursor is on a jump label — its definition, or a jump. */
	readonly label?: LabelSite;
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
 * How far a label rename must reach.
 *
 * A jump sees its own script and the master script, so a subroutine defined in
 * `1d.gdl` belongs to the whole library part while one defined anywhere else
 * never leaves its file. A script that defines a label of its own name shadows
 * the master's, which keeps the rename out of it entirely — the corpus holds no
 * such collision, but a silent merge of two subroutines is not a risk worth
 * taking on a coincidence.
 *
 * A jump that resolves to nothing — the leftover `providers/labels.ts` reports
 * — stays in its own file too. There is no definition to follow anywhere.
 */
function labelReachesWholePart(doc: GdlDocument, key: string, resolve: TextResolver): boolean {
	if (!libPartFor(doc.uri)) return false;
	if (labelDefinitionKeys(doc).has(key)) return doc.script === '1d';
	const master = masterScriptFor(doc.uri, doc.script, resolve);
	return master ? labelDefinitionKeys(master).has(key) : false;
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

	// A jump label, the other name spelt as a string rather than an identifier.
	// Only where GDL reads the string as a label: its definition, a `GOSUB` /
	// `GOTO` naming it, or the assignment that hands it to a variable jumped
	// through. Prose that merely matches is left alone, as with a group.
	const label = labelSiteAt(doc, offset);
	if (label) {
		if (label.spelling === 'numeric') {
			throw new RenameError(
				`\`${label.token.text}\` is a numeric jump label and cannot be renamed safely. ` +
					'Numeric labels are reached by arithmetic (`GOSUB 100 + idx`) and through ' +
					'constants (`COUNT_OFFSET = 107`), and neither can be rewritten — the rename ' +
					'would leave the object jumping to a label that no longer exists.',
			);
		}
		const inner = label.token.text.slice(1, -1);
		return {
			name: inner,
			range: Range.create(
				td.positionAt(label.token.start + 1),
				td.positionAt(label.token.end - 1),
			),
			label,
			projectWide: labelReachesWholePart(doc, label.key, resolve),
		};
	}

	// A parameter addressed by name rather than written bare. `VALUES`, `LOCK`,
	// `HIDEPARAMETER` and the interface script's controls all reach into the
	// parameter list with a string, and that string is a reference as surely as
	// the bare spelling is — so a rename must be reachable from it, and must
	// carry the parameter's own scope: the whole library part, XML included.
	const named = parameterNameAt(doc, offset);
	if (named) {
		const inner = Range.create(
			td.positionAt(named.token.start + 1),
			td.positionAt(named.token.end - 1),
		);
		const part = libPartFor(doc.uri);
		const param = part?.parameters.get(named.name.toLowerCase());
		if (param?.fix) {
			throw new RenameError(
				`\`${param.name}\` is a fixed parameter of this library part and cannot be renamed.`,
			);
		}
		if (!part) {
			throw new RenameError(
				`\`${named.name}\` names a parameter, but this script is not inside a ` +
					'library part, so there is no parameter list to rename it in.',
			);
		}
		if (!param) {
			// Nothing to rename: either the name is a typo `providers/paramRefs.ts`
			// already reports, or this is a macro, whose parameter commands address
			// the *caller's* list — which is not ours to rewrite.
			throw new RenameError(
				`\`${named.name}\` is not a parameter of \`${part.name}\`, so there is ` +
					'nothing to rename.',
			);
		}
		return { name: named.name, range: inner, parameter: param, projectWide: true };
	}

	const token = tokenAt(doc, offset);
	if (!token || token.type !== 'identifier') {
		throw new RenameError(
			'Only variables, parameters, groups and jump labels can be renamed.',
		);
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

/**
 * Rewrites every string that names this label — its definition, the jumps to
 * it, and the assignments that hand the name to a variable jumped through.
 *
 * The edit lands *inside* the quotes, so whichever delimiter the author used at
 * each site survives; the same routine is quite often `"draw"` on one line and
 * `'draw'` on the next, single quotes being how a `"` is embedded elsewhere.
 */
function renameLabel(
	doc: GdlDocument,
	td: TextDocument,
	label: LabelSite,
	projectWide: boolean,
	newName: string,
	resolve: TextResolver,
): WorkspaceEdit {
	if (!newName) {
		throw new RenameError('A jump label cannot be empty.');
	}
	if (BAD_IN_LABEL_NAME.test(newName)) {
		throw new RenameError('A jump label cannot contain a quote mark or a line break.');
	}
	// `"100":` and `100:` are the same label to `GOSUB 100`, which resolves a
	// numeric target by value — so a named label must not become a number, or
	// it would answer jumps meant for a numeric one and vice versa.
	if (NUMERIC_NAME.test(newName)) {
		throw new RenameError(
			`\`${newName}\` would read as a numeric jump label, which \`GOSUB\` matches by ` +
				'value — give the subroutine a name that is not a number.',
		);
	}

	const newKey = labelKey(newName);
	const libpart = libPartFor(doc.uri);

	/** Every script the rename may touch, the current document included. */
	const scripts = projectWide && libpart ? libPartScripts(libpart.root) : [];

	// The new name must not already be a subroutine a jump in reach could mean.
	// For a script-local label that is this script and the master; for one the
	// master publishes it is every script of the part, since renaming onto a
	// sibling's own label would put two subroutines behind one name there — and
	// a reused label stops the object outright.
	//
	// A name differing from an existing label only in case is refused as well,
	// though GDL would tell the two apart: it is the near-miss
	// `providers/labels.ts` warns about, and a rename has no business making
	// one. The label being renamed is exempt, since its own definition is what
	// moves — which is what leaves `"tapPage"` → `"TapPage"` free, the rename
	// anyone spelling a name consistently would reach for.
	const newLoose = looseLabelKey(newName);
	const refuseIfTaken = (other: GdlDocument, where: string) => {
		if (newKey === label.key) return;
		const taken = labelDefinitions(other).find(
			(definition) =>
				definition.key !== label.key && looseLabelKey(definition.name) === newLoose,
		);
		if (!taken) return;
		throw new RenameError(
			taken.key === newKey
				? `\`${newName}\` is already a jump label in ${where} — two subroutines ` +
					'cannot share a name, and a reused label stops the object.'
				: `\`${taken.name}\` is already a jump label in ${where}, and ` +
					`\`${newName}\` differs from it only in case — GDL would take them as ` +
					'two subroutines, which reads as one.',
		);
	};

	refuseIfTaken(doc, 'this script');
	if (scripts.length === 0) {
		const master = masterScriptFor(doc.uri, doc.script, resolve);
		if (master) refuseIfTaken(master, 'the master script');
	}

	const editsFor = (scriptDoc: GdlDocument, scriptTd: TextDocument): TextEdit[] =>
		labelSitesFor(scriptDoc, label.key).map((site) =>
			TextEdit.replace(
				Range.create(
					scriptTd.positionAt(site.token.start + 1),
					scriptTd.positionAt(site.token.end - 1),
				),
				newName,
			),
		);

	if (scripts.length === 0) {
		return { changes: { [doc.uri]: editsFor(doc, td) } };
	}

	const changes: Record<string, TextEdit[]> = {};
	for (const script of scripts) {
		const text = script.uri === doc.uri ? td.getText() : readText(script.uri, resolve);
		if (text === undefined) continue;
		const scriptDoc = script.uri === doc.uri ? doc : analyze(script.uri, text);

		// A script with a label of its own by this name resolves its jumps
		// there, so they are not ours to rewrite.
		if (script.kind !== '1d' && labelDefinitionKeys(scriptDoc).has(label.key)) continue;
		refuseIfTaken(scriptDoc, `\`${script.kind}.gdl\``);

		const scriptTd =
			script.uri === doc.uri ? td : TextDocument.create(script.uri, 'gdl-hsf', 0, text);
		const edits = editsFor(scriptDoc, scriptTd);
		if (edits.length) changes[script.uri] = edits;
	}
	return { changes };
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
	// target is resolved first — a group and a jump label are strings, and
	// answer to none of the rules an identifier does.
	const target = resolveRenameTarget(doc, td, position, resolve);

	if (target.group) return renameGroup(doc, td, target.group, trimmed);
	if (target.label) return renameLabel(doc, td, target.label, target.projectWide, trimmed, resolve);

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
