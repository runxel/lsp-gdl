/**
 * Reads the HSF (Hierarchical Source Format) library part that owns a script.
 *
 * An HSF library part on disk looks like:
 *
 *   MyObject/
 *     libpartdata.xml      metadata, GUID, ancestry
 *     paramlist.xml        the parameter list — names, types, descriptions
 *     calledmacros.xml     resolved macro dependencies
 *     scripts/
 *       1d.gdl 2d.gdl 3d.gdl vl.gdl ui.gdl pr.gdl fwm.gdl bwm.gdl
 *
 * The parameters in `paramlist.xml` are in scope as ordinary variables in every
 * script. Without reading them, a language server cannot tell a parameter from
 * a typo — which is why this module exists.
 *
 * v0 note: `paramlist.xml` is machine-written by LP_XMLConverter and extremely
 * regular, so it is scanned with regexes rather than a full XML parser. If we
 * ever need to *write* these files, swap in a real parser.
 */

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { URI } from 'vscode-uri';
import { scriptKindFromUri, type ScriptKind } from './scriptKind';

/** Parameter types as spelled by LP_XMLConverter, mapped to something readable. */
const TYPE_LABELS: Readonly<Record<string, string>> = {
	Length: 'Length',
	Angle: 'Angle',
	RealNum: 'Real',
	Integer: 'Integer',
	Boolean: 'Boolean',
	String: 'String',
	Material: 'Surface',
	BuildingMaterial: 'Building Material',
	LineType: 'Line Type',
	FillPattern: 'Fill',
	PenColour: 'Pen',
	PenColor: 'Pen',
	Profile: 'Profile',
	Dictionary: 'Dictionary',
	Separator: 'Separator',
	Title: 'Title',
	LightSwitch: 'Light Switch',
	ColorRGB: 'RGB Colour',
	Intensity: 'Intensity',
};

export interface GdlParameter {
	readonly name: string;
	/** Raw XML element name, e.g. `Length`. */
	readonly type: string;
	/** Human-readable type label. */
	readonly typeLabel: string;
	/** The description shown in Archicad's settings dialog. */
	readonly description: string;
	readonly hidden: boolean;
	/** Child-only / fixed parameters cannot be renamed. */
	readonly fix: boolean;
	/** Array dimensions, if the parameter is a 1D or 2D array. */
	readonly dimensions?: readonly number[];
}

export interface LibPart {
	/** Absolute path of the library part root folder. */
	readonly root: string;
	readonly name: string;
	/**
	 * The complete parameter list of this library part.
	 *
	 * Complete really does mean complete: parameters inherited from an ancestor
	 * arrive here as fixed (`<Fix/>`) entries, so `paramlist.xml` is the ground
	 * truth for what the object has. A name absent from this map does not exist.
	 */
	readonly parameters: ReadonlyMap<string, GdlParameter>;
	/** mtime of paramlist.xml when parsed, used for cache invalidation. */
	readonly stamp: number;
}

/**
 * Walks up from a script file to the library part root.
 *
 * A libpart root is the folder that directly contains `paramlist.xml`. In
 * practice a script lives at `<root>/scripts/3d.gdl`, but we search upward
 * rather than assuming, so unusual layouts still resolve.
 */
export function findLibPartRoot(scriptPath: string): string | undefined {
	let dir = dirname(scriptPath);
	for (let depth = 0; depth < 6; depth++) {
		try {
			statSync(join(dir, 'paramlist.xml'));
			return dir;
		} catch {
			// Not here — keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

const PARAM_RE = /<(\w+)\s+Name="([^"]*)"\s*(\/?)>/g;

/** Parses one `paramlist.xml`. Returns an empty map on any read/parse failure. */
export function parseParamList(xmlPath: string): Map<string, GdlParameter> {
	const params = new Map<string, GdlParameter>();
	let xml: string;
	try {
		xml = readFileSync(xmlPath, 'utf8');
	} catch {
		return params;
	}

	// Restrict to the <Parameters> block so we skip the header section.
	const blockStart = xml.indexOf('<Parameters');
	const block = blockStart === -1 ? xml : xml.slice(blockStart);

	PARAM_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = PARAM_RE.exec(block)) !== null) {
		const [, type, name, selfClosing] = m;
		if (type === 'Parameters' || !name) continue;

		// The element body holds Description / Flags / Value / array extents.
		let body = '';
		if (!selfClosing) {
			const close = block.indexOf(`</${type}>`, m.index);
			if (close !== -1) body = block.slice(m.index, close);
		}

		const description = /<Description>\s*<!\[CDATA\[\s*"?([\s\S]*?)"?\s*\]\]>\s*<\/Description>/.exec(body)?.[1] ?? '';
		const first = /<ArrayValues?\b[^>]*FirstDimension="(\d+)"/.exec(body)?.[1];
		const second = /<ArrayValues?\b[^>]*SecondDimension="(\d+)"/.exec(body)?.[1];
		const dimensions = first
			? second && second !== '0'
				? [Number(first), Number(second)]
				: [Number(first)]
			: undefined;

		params.set(name.toLowerCase(), {
			name,
			type,
			typeLabel: TYPE_LABELS[type] ?? type,
			description: description.trim(),
			hidden: /<ParFlg_Hidden\s*\/>/.test(body),
			fix: /<Fix\s*\/>/.test(body),
			...(dimensions ? { dimensions } : {}),
		});
	}

	return params;
}

const cache = new Map<string, LibPart>();

/**
 * Resolves and caches the library part owning `uri`.
 *
 * Re-reads `paramlist.xml` when its mtime changes, so editing parameters in
 * Archicad and re-exporting is picked up without restarting the server.
 */
export function libPartFor(uri: string): LibPart | undefined {
	let fsPath: string;
	try {
		const parsed = URI.parse(uri);
		if (parsed.scheme !== 'file') return undefined;
		fsPath = parsed.fsPath;
	} catch {
		return undefined;
	}

	const root = findLibPartRoot(fsPath);
	if (!root) return undefined;

	const xmlPath = join(root, 'paramlist.xml');
	let stamp = 0;
	try {
		stamp = statSync(xmlPath).mtimeMs;
	} catch {
		return undefined;
	}

	const cached = cache.get(root);
	if (cached && cached.stamp === stamp) return cached;

	const libpart: LibPart = {
		root,
		name: basename(root),
		parameters: parseParamList(xmlPath),
		stamp,
	};
	cache.set(root, libpart);
	return libpart;
}

/** Drops cached library parts. Called when the client reports file changes. */
export function invalidateLibPartCache(): void {
	cache.clear();
}

export interface LibPartScript {
	readonly kind: ScriptKind;
	readonly path: string;
	readonly uri: string;
}

/**
 * Every recognised script of a library part, in a stable order.
 *
 * This is the unit a rename operates over: the scripts of one object share a
 * parameter list, and the master script's variables are visible to all of them.
 */
export function libPartScripts(root: string): LibPartScript[] {
	const dir = join(root, 'scripts');
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}

	const scripts: LibPartScript[] = [];
	for (const name of names) {
		if (!name.toLowerCase().endsWith('.gdl')) continue;
		const path = join(dir, name);
		const uri = URI.file(path).toString();
		const kind = scriptKindFromUri(uri);
		if (kind) scripts.push({ kind, path, uri });
	}
	return scripts.sort((a, b) => a.kind.localeCompare(b.kind));
}

/** Absolute path of a library part's parameter list. */
export function paramListPath(root: string): string {
	return join(root, 'paramlist.xml');
}
