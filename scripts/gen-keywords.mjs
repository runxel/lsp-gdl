#!/usr/bin/env node
/**
 * Generates `server/src/data/keywords.generated.ts` from `data/keywords.gdl`.
 *
 * `data/keywords.gdl` is vendored from GRAPHISOFT/vscode-gdl (MIT) — see NOTICE.md.
 * It is a flat, comment-sectioned list of every GDL keyword, global, fixed
 * parameter and magic string. We turn it into a typed table that records, for
 * each name, WHICH SCRIPT it may legally appear in — the thing a TextMate
 * grammar fundamentally cannot express.
 *
 * Run: npm run gen:keywords
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(root, 'data', 'keywords.gdl');
const OUT = join(root, 'server', 'src', 'data', 'keywords.generated.ts');

const ALL = ['1d', '2d', '3d', 'vl', 'ui', 'pr', 'fwm', 'bwm'];

/**
 * Maps a `! section header` in keywords.gdl onto the semantics we care about.
 * `null` entries are pure grouping headers that carry no entries of their own.
 *
 * `scripts` lists where a name is PRIMARILY valid. The master script (1d) is
 * deliberately excluded from the geometry sections: it runs ahead of every
 * other script, so a 3D command there is legal-but-contextual. Diagnostics
 * treat 1d permissively — see server/src/providers/diagnostics.ts.
 */
const SECTIONS = {
	'operators': { kind: 'operator', scripts: ALL },
	'Common Keywords': { kind: 'statement', scripts: ALL },
	'control': { kind: 'statement', scripts: ALL, syntax: true },
	'i/o': { kind: 'statement', scripts: ALL },
	'Forward and Backward Migration Scripts': { kind: 'statement', scripts: ['fwm', 'bwm'] },
	'memory-related': { kind: 'statement', scripts: ALL },
	'communication with AC': { kind: 'statement', scripts: ALL },
	'functions': { kind: 'function', scripts: ALL },
	'Reserved Keywords': { kind: 'statement', scripts: ALL, reserved: true },

	'3D Use Only': { kind: 'statement', scripts: ['3d'] },
	'2D Use Only': { kind: 'statement', scripts: ['2d'] },
	'2D and 3D Use': { kind: 'statement', scripts: ['2d', '3d'] },

	'Non-Geometric Scripts': null,
	'Properties Script': { kind: 'statement', scripts: ['pr'] },
	'Parameter Script': { kind: 'statement', scripts: ['vl'] },
	'Interface Script': { kind: 'statement', scripts: ['ui'] },

	'autotexts': null,
	'Project info keywords': { kind: 'autotext', scripts: ALL },
	'General': { kind: 'autotext', scripts: ALL },
	'Layout autotexts': { kind: 'autotext', scripts: ALL },
	'Drawing autotexts': { kind: 'autotext', scripts: ALL },
	'Reference type autotexts': { kind: 'autotext', scripts: ALL },
	'Marker type autotexts': { kind: 'autotext', scripts: ALL },
	'Change related autotexts': { kind: 'autotext', scripts: ALL },
	'Layout revision related autotexts': { kind: 'autotext', scripts: ALL },

	'APPLICATION_QUERY, REQ, REQUEST strings': null,
	'APPLICATION_QUERY': { kind: 'query', scripts: ALL, owner: 'APPLICATION_QUERY' },
	'REQ': { kind: 'query', scripts: ALL, owner: 'REQ' },
	'REQUEST': { kind: 'query', scripts: ALL, owner: 'REQUEST' },

	'built-in properties': { kind: 'property', scripts: ALL },

	'GLOBALS': null,
	'Deprecated global variables': { kind: 'global', scripts: ALL, deprecated: true },
	'globals': { kind: 'global', scripts: ALL },

	'FIX NAMED parameters': null,
	'Parameters set by ARCHICAD': { kind: 'fixparam', scripts: ALL, direction: 'set' },
	'parameters read by ARCHICAD': { kind: 'fixparam', scripts: ALL, direction: 'read' },
	'deprecated': { kind: 'fixparam', scripts: ALL, deprecated: true },
	'add-on parameters': { kind: 'fixparam', scripts: ALL, direction: 'addon' },
};

/** Splits `TEXT ! trailing note` while respecting a leading quoted string. */
function splitComment(line) {
	if (line.startsWith('"')) {
		const end = line.indexOf('"', 1);
		if (end !== -1) {
			return [line.slice(0, end + 1), line.slice(end + 1).replace(/^\s*!\s*/, '').trim()];
		}
	}
	const bang = line.indexOf('!');
	if (bang === -1) return [line.trim(), ''];
	return [line.slice(0, bang).trim(), line.slice(bang + 1).trim()];
}

const entries = new Map(); // name -> record

function add(name, section, meta, note, syntax) {
	if (!name) return;
	const prev = entries.get(name);
	if (prev) {
		// A name can legitimately appear in several sections (e.g. a keyword that
		// is valid in both 2D and 3D lists). Union the script sets rather than
		// letting the last section win.
		for (const s of meta.scripts) if (!prev.scripts.includes(s)) prev.scripts.push(s);
		if (note && !prev.note) prev.note = note;
		return;
	}
	entries.set(name, {
		name,
		kind: meta.kind,
		category: section,
		scripts: [...meta.scripts],
		...(meta.reserved ? { reserved: true } : {}),
		...(meta.deprecated ? { deprecated: true } : {}),
		...(meta.owner ? { owner: meta.owner } : {}),
		...(meta.direction ? { direction: meta.direction } : {}),
		...(note ? { note } : {}),
		...(syntax ? { syntax } : {}),
	});
}

const text = readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '');
let section = null;
let meta = null;

for (const raw of text.split(/\r?\n/)) {
	const line = raw.trim();
	if (!line) continue;

	if (line.startsWith('!')) {
		const header = line.replace(/^!\s*/, '').trim();
		if (Object.prototype.hasOwnProperty.call(SECTIONS, header)) {
			section = header;
			meta = SECTIONS[header];
		}
		// Unknown `!` lines are prose (e.g. the "reserved keywords" explainer)
		// or stray notes — they must not reset the current section.
		continue;
	}
	if (!meta) continue;

	const [body, note] = splitComment(line);
	if (!body) continue;

	if (meta.kind === 'operator') {
		// Operator lines hold several synonyms: `* / mod %`
		for (const op of body.split(/\s+/)) add(op, section, meta, note);
		continue;
	}

	if (meta.syntax) {
		// Control-flow lines are usage examples (`FOR i = 1 TO 6 STEP 8`).
		// Harvest the uppercase keywords, keep the line as a syntax hint.
		const words = body.match(/\b[A-Z][A-Z0-9_]*\b/g) ?? [];
		if (words.length === 0) {
			add(body, section, meta, note); // bare `:` label marker
		} else {
			for (const w of words) add(w, section, meta, note, words.length > 1 ? body : undefined);
		}
		continue;
	}

	if (meta.kind === 'function') {
		add(body.replace(/\(\)$/, ''), section, meta, note);
		continue;
	}

	if (body.startsWith('"')) {
		add(body.replace(/^"|"$/g, ''), section, meta, note);
		continue;
	}

	add(body, section, meta, note);
}

const list = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));

const byKind = list.reduce((acc, e) => ((acc[e.kind] = (acc[e.kind] ?? 0) + 1), acc), {});
const summary = Object.entries(byKind)
	.sort((a, b) => b[1] - a[1])
	.map(([k, n]) => `//   ${k.padEnd(9)} ${n}`)
	.join('\n');

const out = `// AUTO-GENERATED by scripts/gen-keywords.mjs — do not edit by hand.
// Source: data/keywords.gdl (vendored from GRAPHISOFT/vscode-gdl, MIT — see NOTICE.md)
//
// ${list.length} entries:
${summary}

import type { ScriptKind } from '../gdl/scriptKind';

export type KeywordKind =
	| 'statement'
	| 'function'
	| 'operator'
	| 'global'
	| 'fixparam'
	| 'autotext'
	| 'query'
	| 'property';

export interface GdlKeyword {
	/** Canonical spelling. GDL itself is case-insensitive. */
	readonly name: string;
	readonly kind: KeywordKind;
	/** Originating section of the reference keyword list. */
	readonly category: string;
	/** Scripts this name is primarily valid in. */
	readonly scripts: readonly ScriptKind[];
	/** Exists for compatibility / is not publicised. */
	readonly reserved?: boolean;
	readonly deprecated?: boolean;
	/** For 'query': which command consumes this string. */
	readonly owner?: string;
	/** For 'fixparam': whether Archicad writes or reads it. */
	readonly direction?: string;
	/** Trailing note from the source list. */
	readonly note?: string;
	/** Usage skeleton, for control-flow keywords. */
	readonly syntax?: string;
}

export const KEYWORDS: readonly GdlKeyword[] = ${JSON.stringify(list, null, '\t').replace(/\n/g, '\n')} as const;
`;

writeFileSync(OUT, out, 'utf8');
console.log(`wrote ${OUT}`);
console.log(`${list.length} entries:`);
for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
	console.log(`  ${k.padEnd(10)} ${n}`);
}
