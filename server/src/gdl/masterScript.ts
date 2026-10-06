/**
 * Variables the master script publishes to the rest of the library part.
 *
 * The master script (`1d.gdl`) runs before every other script, so anything it
 * assigns is in scope in all of them. That makes its variables worth offering
 * as completions everywhere — they are, in practice, the object's shared state.
 *
 * One exception, by convention rather than by language rule: **names beginning
 * with an underscore are treated as private to their script** and are not
 * offered elsewhere. GDL itself still shares them; this is a house style that
 * marks a variable as scratch, and suggesting `_tmp` from the master script in
 * a UI script would be noise.
 */

import { readFileSync } from 'node:fs';
import { URI } from 'vscode-uri';
import { analyze, type GdlDocument } from './analyzer';
import { libPartFor, libPartScripts } from './libpart';
import type { ScriptKind } from './scriptKind';

export interface MasterVariable {
	readonly name: string;
	/** True when the master script writes it back with `PARAMETERS`. */
	readonly isParameterWrite: boolean;
}

/** Supplies current text for a URI, preferring unsaved editor content. */
export type TextResolver = (uri: string) => string | undefined;

/** Cached per script, invalidated when its text changes. */
const cache = new Map<string, { text: string; doc: GdlDocument }>();

/** True for names the house style marks as script-private. */
export function isPrivateName(name: string): boolean {
	return name.startsWith('_');
}

/**
 * The analysed script of `kind` in the library part owning `uri`, or undefined
 * when the part, the script or its text cannot be read.
 */
function siblingScript(
	uri: string,
	kind: ScriptKind,
	resolve: TextResolver,
): GdlDocument | undefined {
	const libpart = libPartFor(uri);
	if (!libpart) return undefined;

	const sibling = libPartScripts(libpart.root).find((s) => s.kind === kind);
	if (!sibling || sibling.uri === uri) return undefined;
	return analyzedScript(sibling.uri, resolve);
}

/**
 * Any script by URI, analysed and cached until its text changes.
 *
 * Prefers unsaved editor content and falls back to what is on disk, since a
 * script reached from another one — a sibling, or a macro it calls — is
 * usually not the file being edited.
 */
export function analyzedScript(uri: string, resolve: TextResolver): GdlDocument | undefined {
	let text = resolve(uri);
	if (text === undefined) {
		try {
			text = readFileSync(URI.parse(uri).fsPath, 'utf8');
		} catch {
			return undefined;
		}
	}

	const cached = cache.get(uri);
	if (cached && cached.text === text) return cached.doc;

	const doc = analyze(uri, text);
	cache.set(uri, { text, doc });
	return doc;
}

/**
 * The analysed master script of the library part owning `uri`.
 *
 * Returns undefined for the master script itself — its variables are already
 * local there — and whenever the part or its master cannot be read.
 */
export function masterScriptFor(
	uri: string,
	script: ScriptKind | undefined,
	resolve: TextResolver,
): GdlDocument | undefined {
	if (script === '1d') return undefined;
	return siblingScript(uri, '1d', resolve);
}

/**
 * The scripts whose names reach `uri`, itself excluded.
 *
 * Only the master script (`1d.gdl`) does: Archicad prepends it to every other
 * script it runs, so what it defines is there when they start — a variable, an
 * array's `DIM`, an inline `DEFINE STYLE`. Whatever cannot apply in the script
 * it lands in is silently ignored.
 *
 * **The parameter script reaches nothing.** Confirmed by the project owner: it
 * runs only on certain occasions, and nothing it does — a variable, a `DIM`, a
 * `DEFINE` — is visible to any other script. Its one way back into the object
 * is `PARAMETERS`, which writes a parameter's value; that is the parameter list
 * speaking, not the script. An earlier version counted `vl.gdl` here, on the
 * reasoning that seeing one script too many could only quieten a check — but it
 * also made a name set only in `vl` look set everywhere, and that name reads as
 * 0 in every other script.
 *
 * A list, so callers need not change if a second such script is ever found.
 */
export function sharedScriptsFor(
	uri: string,
	resolve: TextResolver,
): GdlDocument[] {
	const master = siblingScript(uri, '1d', resolve);
	return master ? [master] : [];
}

/**
 * The parameter script of the library part owning `uri`, or undefined for
 * `vl.gdl` itself and whenever it cannot be read.
 *
 * Not a scope — see `sharedScriptsFor` — but where `VALUES` restricts the
 * parameters, which is a fact about the parameter list and so holds in every
 * script that reads one.
 */
export function parameterScriptFor(uri: string, resolve: TextResolver): GdlDocument | undefined {
	return siblingScript(uri, 'vl', resolve);
}

/**
 * Every other script of the library part owning `uri`.
 *
 * `sharedScriptsFor` above answers "which scripts reach me"; this answers the
 * mirror, "which scripts do I reach", which is the question a variable of the
 * master script raises — it is prepended to every other, so anything asking
 * whether such a variable is live has to read all of them.
 *
 * Returns nothing outside a library part, where the siblings cannot be found.
 */
export function siblingScripts(uri: string, resolve: TextResolver): GdlDocument[] {
	const libpart = libPartFor(uri);
	if (!libpart) return [];

	const docs: GdlDocument[] = [];
	for (const script of libPartScripts(libpart.root)) {
		if (script.uri === uri) continue;
		const doc = siblingScript(uri, script.kind, resolve);
		if (doc) docs.push(doc);
	}
	return docs;
}

/**
 * The master script's shared variables, for a document in the same library
 * part — the ones worth offering as completions everywhere. Script-private
 * names are left out; see the note at the top of this file.
 */
export function masterScriptVariables(
	uri: string,
	script: ScriptKind | undefined,
	resolve: TextResolver,
): MasterVariable[] {
	const master = masterScriptFor(uri, script, resolve);
	if (!master) return [];

	const variables: MasterVariable[] = [];
	for (const info of master.variables.values()) {
		if (isPrivateName(info.name)) continue;
		variables.push({ name: info.name, isParameterWrite: info.isParameterWrite });
	}
	return variables;
}

/** Drops cached master-script analyses. */
export function invalidateMasterScriptCache(): void {
	cache.clear();
}
