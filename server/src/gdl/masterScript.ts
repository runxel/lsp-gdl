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

/** Cached per master script, invalidated when its text changes. */
const cache = new Map<string, { text: string; doc: GdlDocument }>();

/** True for names the house style marks as script-private. */
export function isPrivateName(name: string): boolean {
	return name.startsWith('_');
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

	const libpart = libPartFor(uri);
	if (!libpart) return undefined;

	const master = libPartScripts(libpart.root).find((s) => s.kind === '1d');
	if (!master) return undefined;

	// Prefer unsaved editor content; fall back to what is on disk, since the
	// master script is usually not the file being edited.
	let text = resolve(master.uri);
	if (text === undefined) {
		try {
			text = readFileSync(URI.parse(master.uri).fsPath, 'utf8');
		} catch {
			return undefined;
		}
	}

	const cached = cache.get(master.uri);
	if (cached && cached.text === text) return cached.doc;

	const doc = analyze(master.uri, text);
	cache.set(master.uri, { text, doc });
	return doc;
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
