/**
 * GDL library parts are split across several scripts, each with its own
 * dialect: a command legal in the 3D script is an error in the parameter
 * script. Knowing which script a file *is* underpins nearly every smart
 * feature this server provides.
 *
 * In HSF (Hierarchical Source Format) the script kind is carried by the
 * filename inside `<libpart>/scripts/`.
 */

export type ScriptKind = '1d' | '2d' | '3d' | 'vl' | 'ui' | 'pr' | 'fwm' | 'bwm';

export const SCRIPT_KINDS: readonly ScriptKind[] = ['1d', '2d', '3d', 'vl', 'ui', 'pr', 'fwm', 'bwm'];

export const SCRIPT_LABELS: Readonly<Record<ScriptKind, string>> = {
	'1d': 'Master script',
	'2d': '2D script',
	'3d': '3D script',
	'vl': 'Parameter script',
	'ui': 'Interface script',
	'pr': 'Properties script',
	'fwm': 'Forward migration script',
	'bwm': 'Backward migration script',
};

/**
 * The master script runs ahead of every other script, so it legitimately
 * contains commands belonging to any of them. Context checks must stay
 * permissive here or they drown real code in false positives.
 */
export const PERMISSIVE_SCRIPTS: readonly ScriptKind[] = ['1d'];

const FILENAME_TO_KIND = new Map<string, ScriptKind>([
	['1d', '1d'],
	['2d', '2d'],
	['3d', '3d'],
	['vl', 'vl'],
	['ui', 'ui'],
	['pr', 'pr'],
	['fwm', 'fwm'],
	['bwm', 'bwm'],
	// Names seen in the wild / older tooling.
	['master', '1d'],
	['parameter', 'vl'],
	['interface', 'ui'],
	['properties', 'pr'],
]);

/**
 * Derives the script kind from a document URI.
 *
 * Returns `undefined` for a `.gdl` file that is not a recognised HSF script —
 * a scratch file, say. Callers should then fall back to permissive behaviour
 * rather than guessing.
 */
export function scriptKindFromUri(uri: string): ScriptKind | undefined {
	const path = uri.replace(/[?#].*$/, '');
	const file = path.slice(path.lastIndexOf('/') + 1);
	const stem = decodeURIComponent(file).replace(/\.gdl$/i, '').toLowerCase();
	return FILENAME_TO_KIND.get(stem);
}

/** True when `kind` should not be subjected to script-context diagnostics. */
export function isPermissive(kind: ScriptKind | undefined): boolean {
	return kind === undefined || PERMISSIVE_SCRIPTS.includes(kind);
}
