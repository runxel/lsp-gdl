/**
 * `gdl/macroTree` — the macros a script calls, and the macros those call, as a
 * tree for the client's sidebar.
 *
 * **What runs is what is followed.** A macro called from a 3D script runs its
 * own master script and then its own 3D script — the call carries the caller's
 * context with it — so a node's children are the calls in exactly those two of
 * its scripts, and the tree for a `2d.gdl` shows what drawing the plan symbol
 * reaches rather than everything the parts happen to contain. The root is the
 * one exception: it is the script on screen and nothing else, since that is
 * what was asked about; its own master is a different file.
 *
 * A call from a master script runs in whichever context reached it, so there
 * is no one kind to follow. Its macros are followed through their masters
 * alone — the calls every context shares — rather than through a union that
 * would list 3D-only macros under a label.
 *
 * Four things end a branch, each shown rather than hidden:
 *
 *   - **A part not in the workspace** — 429 corpus calls, mostly into the
 *     GRAPHISOFT library, which a checkout does not carry.
 *   - **A part present only as a `.gsm`**, which exists but cannot be read.
 *   - **A computed name**, a variable nothing in reach assigns a literal.
 *   - **Recursion.** A part already on the path is marked, not re-entered.
 *
 * The tree is built whole rather than as each node is opened, so a `+` means
 * there really is something inside; `MAX_NODES` bounds it, since shared
 * macros make it a DAG laid out as a tree and a deep library could multiply.
 */

import { basename, dirname } from 'node:path';
import { URI } from 'vscode-uri';

import type { GdlDocument } from '../gdl/analyzer';
import { libPartFor, libPartScripts } from '../gdl/libpart';
import { libraryPartsNamed, macroKey, nearest, setFallbackLibraryRoot } from '../gdl/libraryIndex';
import { macroCallSites, type MacroCallSite, type MacroSpelling } from '../gdl/macros';
import { analyzedScript, type TextResolver } from '../gdl/masterScript';
import type { ScriptKind } from '../gdl/scriptKind';

export type MacroNodeStatus = 'source' | 'binary' | 'missing' | 'computed' | 'recursive';

export interface MacroTreeLocation {
	readonly uri: string;
	readonly line: number;
	readonly character: number;
}

export interface MacroTreeNode {
	/** The macro's name as the call spells it, or the variable for a computed one. */
	readonly name: string;
	readonly status: MacroNodeStatus;
	readonly spelling: MacroSpelling;
	/** The variable a `variable` or `computed` call goes through. */
	readonly variable?: string;
	/** The script of the macro that this call runs — what a click opens. */
	readonly uri?: string;
	/** The part's folder, or its `.gsm`. */
	readonly path?: string;
	/** Other parts in the workspace answering to the same name. */
	readonly alternatives: number;
	/** Which script of the caller holds the call. */
	readonly from: ScriptKind | undefined;
	/** The first call; `calls` counts the rest in the same scripts. */
	readonly callSite: MacroTreeLocation;
	readonly calls: number;
	readonly children: MacroTreeNode[];
}

export interface MacroTree {
	readonly uri: string;
	/** The library part's name, or the file's when it is not in one. */
	readonly name: string;
	readonly script: ScriptKind | undefined;
	readonly children: MacroTreeNode[];
	/** True when `MAX_NODES` cut the tree short. */
	readonly truncated: boolean;
}

const MAX_NODES = 5000;
const MAX_DEPTH = 32;

/** Zero-based line and column of `offset` in `text`. */
function locate(doc: GdlDocument, offset: number): MacroTreeLocation {
	let line = 0;
	let lineStart = 0;
	const text = doc.text;
	for (let i = 0; i < offset && i < text.length; i++) {
		const ch = text.charCodeAt(i);
		// CRLF, LF and a lone CR all end a line — see the lexer.
		if (ch === 10 || (ch === 13 && text.charCodeAt(i + 1) !== 10)) {
			line++;
			lineStart = i + 1;
		}
	}
	return { uri: doc.uri, line, character: offset - lineStart };
}

function fsPathOf(uri: string): string | undefined {
	try {
		const parsed = URI.parse(uri);
		return parsed.scheme === 'file' ? parsed.fsPath : undefined;
	} catch {
		return undefined;
	}
}

interface Call {
	readonly site: MacroCallSite;
	readonly doc: GdlDocument;
}

export function provideMacroTree(doc: GdlDocument, resolve: TextResolver): MacroTree {
	const exists = (name: string) => libraryPartsNamed(name).length > 0;
	let budget = MAX_NODES;
	let truncated = false;

	/** The scripts a part runs in `context`, master first. */
	const scriptsRun = (root: string, context: ScriptKind | undefined) => {
		const scripts = libPartScripts(root);
		const master = scripts.find((s) => s.kind === '1d');
		const own = context && context !== '1d' ? scripts.find((s) => s.kind === context) : undefined;
		return { master, own, opens: own ?? master ?? scripts[0] };
	};

	const callsIn = (docs: readonly GdlDocument[], master: GdlDocument | undefined): Call[] =>
		docs.flatMap((d) => macroCallSites(d, master, exists).map((site) => ({ site, doc: d })));

	const nodesFor = (
		calls: readonly Call[],
		context: ScriptKind | undefined,
		path: readonly string[],
		depth: number,
	): MacroTreeNode[] => {
		// One node per macro however often it is called, in order of first call.
		const groups = new Map<string, Call[]>();
		for (const call of calls) {
			const key = call.site.name !== undefined
				? macroKey(call.site.name)
				: `\0${call.site.variable?.toLowerCase()}`;
			const group = groups.get(key);
			if (group) group.push(call);
			else groups.set(key, [call]);
		}

		const nodes: MacroTreeNode[] = [];
		for (const group of groups.values()) {
			if (budget-- <= 0) {
				truncated = true;
				break;
			}
			const { site, doc: caller } = group[0];
			const base = {
				name: site.name ?? site.variable ?? '',
				spelling: site.spelling,
				...(site.variable ? { variable: site.variable } : {}),
				from: caller.script,
				callSite: locate(caller, site.start),
				calls: group.length,
			};

			if (site.name === undefined) {
				nodes.push({ ...base, status: 'computed', alternatives: 0, children: [] });
				continue;
			}

			const parts = libraryPartsNamed(site.name);
			const part = nearest(parts, fsPathOf(caller.uri));
			const alternatives = Math.max(0, parts.length - 1);
			if (!part) {
				nodes.push({ ...base, status: 'missing', alternatives, children: [] });
				continue;
			}
			if (!part.root) {
				nodes.push({ ...base, status: 'binary', path: part.gsm, alternatives, children: [] });
				continue;
			}

			const { master, own, opens } = scriptsRun(part.root, context);
			const located = { path: part.root, alternatives, ...(opens ? { uri: opens.uri } : {}) };
			if (path.includes(part.root)) {
				nodes.push({ ...base, ...located, status: 'recursive', children: [] });
				continue;
			}

			let children: MacroTreeNode[] = [];
			if (depth < MAX_DEPTH) {
				const masterDoc = master ? analyzedScript(master.uri, resolve) : undefined;
				const ownDoc = own ? analyzedScript(own.uri, resolve) : undefined;
				const docs = [masterDoc, ownDoc].filter((d): d is GdlDocument => d !== undefined);
				children = nodesFor(callsIn(docs, masterDoc), context, [...path, part.root], depth + 1);
			} else {
				truncated = true;
			}
			nodes.push({ ...base, ...located, status: 'source', children });
		}
		return nodes;
	};

	const libpart = libPartFor(doc.uri);
	const fsPath = fsPathOf(doc.uri);
	setFallbackLibraryRoot(libpart ? dirname(libpart.root) : undefined);
	const master = libpart && doc.script !== '1d'
		? libPartScripts(libpart.root).find((s) => s.kind === '1d')
		: undefined;
	// The root's own master is not followed, but its assignments still reach
	// this script, so a `CALL handle_macro` may be named there.
	const masterDoc = master ? analyzedScript(master.uri, resolve) : undefined;

	const children = nodesFor(
		callsIn([doc], masterDoc),
		doc.script,
		libpart ? [libpart.root] : [],
		0,
	);
	return {
		uri: doc.uri,
		name: libpart?.name ?? (fsPath ? basename(fsPath) : doc.uri),
		script: doc.script,
		children,
		truncated,
	};
}
