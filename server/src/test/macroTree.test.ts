/**
 * Macro calls and the Called Macros tree.
 *
 * The tree is built over a throwaway library laid out the way a checkout is:
 * HSF folders side by side, one macro present only compiled, one not present
 * at all. Each shape here is one the corpus writes — see `gdl/macros.ts`.
 */

import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { URI } from 'vscode-uri';

import { analyze } from '../gdl/analyzer';
import { macroCallSites } from '../gdl/macros';
import { libraryPartsNamed, macroKey, nearest, setFallbackLibraryRoot, setLibraryRoots } from '../gdl/libraryIndex';
import { provideMacroTree, type MacroTreeNode } from '../providers/macroTree';

const URI_3D = 'file:///lib/Obj/scripts/3d.gdl';
const none = () => false;

function sites(text: string, exists: (name: string) => boolean = none, master?: string) {
	const masterDoc = master === undefined ? undefined : analyze('file:///lib/Obj/scripts/1d.gdl', master);
	return macroCallSites(analyze(URI_3D, text), masterDoc, exists).map((s) => [s.spelling, s.name ?? s.variable]);
}

test('a call is found after THEN and ELSE, not only at the head', () => {
	// `aol_signage` writes eleven of these.
	assert.deepEqual(
		sites('if a then call "Sign_A" parameters all else call "Sign_B" parameters all'),
		[['string', 'Sign_A'], ['string', 'Sign_B']],
	);
});

test('a call through a variable resolves to the literal it is given', () => {
	assert.deepEqual(
		sites('handle_macro = "OGRO_handle_macro"\ncall handle_macro parameters all'),
		[['variable', 'OGRO_handle_macro']],
	);
	// The master script's assignments reach every other script.
	assert.deepEqual(
		sites('call handle_macro parameters all', none, 'handle_macro = "OGRO_handle_macro"'),
		[['variable', 'OGRO_handle_macro']],
	);
	// Several literals, several candidates — but one per name.
	assert.deepEqual(
		sites('if t then m = "Frame.gsm" else m = "Frame.gsm"\nif u then m = "Other"\ncall m'),
		[['variable', 'Frame.gsm'], ['variable', 'Other']],
	);
});

test('a comparison is not an assignment of a macro name', () => {
	assert.deepEqual(sites('if m = "Frame" then call m'), [['computed', 'm']]);
});

test('an unquoted name is a macro only when no variable holds one and the part exists', () => {
	assert.deepEqual(sites('call leg 2, , 5', (n) => n === 'leg'), [['unquoted', 'leg']]);
	assert.deepEqual(sites('call str_callee parameters all'), [['computed', 'str_callee']]);
});

test('the macro name as a command needs the part in the workspace', () => {
	const exists = (n: string) => n.toLowerCase() === 'note2';
	assert.deepEqual(sites('note2 0, 0, "text"', exists), [['command', 'note2']]);
	assert.deepEqual(sites('if a then note2 0, 0, "x"', exists), [['command', 'note2']]);
	assert.deepEqual(sites('note2 0, 0, "text"'), []);
	// A keyword is never one, and neither is the target of an assignment.
	assert.deepEqual(sites('line2 0, 0, 1, 1', () => true), []);
	assert.deepEqual(sites('note2 = ""', exists), []);
});

test('a variable sharing a macro\'s name inside a PARAGRAPH is not a call', () => {
	// Three corpus markers list `note2` on a line of its own in a paragraph
	// body, beside ACLib's `NOTE2` macro in the same checkout.
	const exists = (n: string) => n.toLowerCase() === 'note2';
	assert.deepEqual(sites('paragraph "p" 1, 0, 0, 0, 1\n\tnote2\nendparagraph', exists), []);
	assert.deepEqual(sites('note2 = "x"\nnote2', exists), []);
});

test('a macro name is keyed without case or extension', () => {
	assert.equal(macroKey('Generic_frame_macro.gsm'), 'generic_frame_macro');
	assert.equal(macroKey(' GetDWOplines '), macroKey('GetDWOpLines'));
});

// --- The tree, over a library on disk ---

const lib = mkdtempSync(join(tmpdir(), 'gdl-macros-'));
after(() => rmSync(lib, { recursive: true, force: true }));

function part(path: string, scripts: Record<string, string>) {
	const root = join(lib, path);
	mkdirSync(join(root, 'scripts'), { recursive: true });
	writeFileSync(join(root, 'libpartdata.xml'), '<Symbol/>');
	writeFileSync(join(root, 'paramlist.xml'), '<ParamSection><Parameters></Parameters></ParamSection>');
	for (const [name, text] of Object.entries(scripts)) writeFileSync(join(root, 'scripts', name), text);
	return root;
}

const objRoot = part('objects/Obj', {
	'1d.gdl': 'frame = "MacB.gsm"',
	'3d.gdl': [
		'call "MacA" parameters all',
		'call "maca" parameters all',
		'call "Nowhere"',
		'call frame',
		'call computedName',
	].join('\n'),
});
part('macros/MacA', {
	'1d.gdl': 'call "MacC"',
	'2d.gdl': 'call "Only2D"',
	'3d.gdl': 'call "Obj"',
});
part('macros/MacC', { '1d.gdl': '', '3d.gdl': 'block 1, 1, 1' });
part('macros/Only2D', { '2d.gdl': '' });
writeFileSync(join(lib, 'macros', 'MacB.gsm'), '');
// A second MacC further off; the one beside the caller is meant.
part('backup/old/MacC', { '1d.gdl': 'call "ShouldNotAppear"' });

setLibraryRoots([lib]);

function treeFor(script: string) {
	const path = join(objRoot, 'scripts', script);
	const uri = URI.file(path).toString();
	return provideMacroTree(analyze(uri, readFileSync(path, 'utf8')), () => undefined);
}

const shape = (nodes: readonly MacroTreeNode[]): unknown[] =>
	nodes.map((n) => (n.children.length ? [n.name, n.status, shape(n.children)] : [n.name, n.status]));

test('the tree follows what runs: a macro\'s master and its script of the caller\'s kind', () => {
	const tree = treeFor('3d.gdl');
	assert.equal(tree.name, 'Obj');
	assert.equal(tree.truncated, false);
	assert.deepEqual(shape(tree.children), [
		// MacA's 1d calls MacC; its 3d calls back into Obj, which is marked
		// rather than followed. Its 2d is not run from a 3D script.
		['MacA', 'source', [['MacC', 'source'], ['Obj', 'recursive']]],
		['Nowhere', 'missing'],
		['MacB.gsm', 'binary'],
		['computedName', 'computed'],
	]);
});

test('a macro called twice is one node that counts its calls', () => {
	const macA = treeFor('3d.gdl').children[0];
	assert.deepEqual(macA.callSites.map((site) => site.line), [0, 1]);
});

test('a node opens the macro\'s script of the same kind, and says where it was called', () => {
	const [macA, , macB] = treeFor('3d.gdl').children;
	assert.equal(URI.parse(macA.uri!).fsPath, join(lib, 'macros', 'MacA', 'scripts', '3d.gdl'));
	// MacC has a 3d.gdl but was reached from MacA's master, whose call runs it.
	const macC = macA.children[0];
	assert.equal(macC.from, '1d');
	assert.equal(URI.parse(macC.uri!).fsPath, join(lib, 'macros', 'MacC', 'scripts', '3d.gdl'));
	// A call through a variable names both.
	assert.equal(macB.spelling, 'variable');
	assert.equal(macB.variable, 'frame');
	assert.equal(macB.callSites[0].line, 3);
});

test('of two parts sharing a name, the nearer is taken', () => {
	const macC = treeFor('3d.gdl').children[0].children[0];
	assert.equal(macC.alternatives, 1);
	assert.equal(macC.path, join(lib, 'macros', 'MacC'));
	assert.equal(macC.children.length, 0);

	const parts = libraryPartsNamed('MACC');
	assert.equal(parts.length, 2);
	assert.equal(nearest(parts, join(lib, 'backup', 'old', 'x.gdl'))?.root, join(lib, 'backup', 'old', 'MacC'));
});

test('a source part is preferred to a compiled one of the same name', () => {
	writeFileSync(join(lib, 'objects', 'MacA.gsm'), '');
	setLibraryRoots([lib]);
	try {
		const parts = libraryPartsNamed('MacA');
		assert.equal(parts.length, 2);
		assert.equal(nearest(parts, join(objRoot, 'scripts', '3d.gdl'))?.root, join(lib, 'macros', 'MacA'));
	} finally {
		rmSync(join(lib, 'objects', 'MacA.gsm'));
		setLibraryRoots([lib]);
	}
});

test('with no workspace folder, the folder beside the script\'s part is searched', () => {
	setLibraryRoots([]);
	try {
		// Only what sits beside `Obj` is reachable now; `macros/` is not.
		const [macA] = treeFor('3d.gdl').children;
		assert.equal(macA.status, 'missing');
		setFallbackLibraryRoot(join(lib, 'macros'));
		assert.equal(libraryPartsNamed('MacA').length, 1);
	} finally {
		setLibraryRoots([lib]);
	}
});
