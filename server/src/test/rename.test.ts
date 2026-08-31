/**
 * Rename tests, run against the real HSF fixture in `TestObject/TestObject`.
 *
 * The cases encode the scoping rules that make GDL renaming unusual: sibling
 * scripts are independent namespaces, while the master and parameter scripts
 * reach across the whole library part — groups, which scope the other way
 * again, never leave the one script, and jump labels take a third scope, their
 * own script plus the master that runs ahead of it.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { analyze } from '../gdl/analyzer';
import { tokenize } from '../gdl/lexer';
import { provideRename, RenameError, type TextResolver } from '../providers/rename';
import { invalidateMasterScriptCache } from '../gdl/masterScript';

const OBJECT_ROOT = join(__dirname, '..', '..', '..', 'TestObject', 'TestObject');
const scriptPath = (name: string) => join(OBJECT_ROOT, 'scripts', name);
const scriptUri = (name: string) => URI.file(scriptPath(name)).toString();

/** Nothing is open in an editor during these tests, so always fall to disk. */
const noOpenDocs = () => undefined;

function renameAt(script: string, symbol: string, newName: string) {
	const uri = scriptUri(script);
	const text = readFileSync(scriptPath(script), 'utf8');

	// Find the symbol as a real identifier token — a plain indexOf would land
	// inside the explanatory comments the fixture is full of.
	const token = tokenize(text).find((t) => t.type === 'identifier' && t.lower === symbol.toLowerCase());
	assert.ok(token, `fixture ${script} should use ${symbol} as an identifier`);

	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideRename(analyze(uri, text), td, td.positionAt(token.start), newName, noOpenDocs);
}

/** As `renameAt`, but landing the cursor on a string literal instead. */
function renameStringAt(script: string, literal: string, newName: string) {
	const uri = scriptUri(script);
	const text = readFileSync(scriptPath(script), 'utf8');

	const token = tokenize(text).find(
		(t) => t.type === 'string' && t.text.slice(1, -1).toLowerCase() === literal.toLowerCase(),
	);
	assert.ok(token, `fixture ${script} should hold the string ${literal}`);

	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideRename(analyze(uri, text), td, td.positionAt(token.start + 1), newName, noOpenDocs);
}

/**
 * A rename over a script written out here rather than the fixture. Group scope
 * stops at the file, so nothing on disk is needed — and the shapes worth
 * pinning down, a group name spelt again as prose among them, do not belong in
 * a demo object whose geometry someone actually looks at.
 */
const SCRATCH_URI = 'file:///scratch/3d.gdl';

function renameInText(text: string, cursorAt: string, newName: string) {
	const offset = text.indexOf(cursorAt);
	assert.ok(offset >= 0, `the script should contain ${cursorAt}`);
	const td = TextDocument.create(SCRATCH_URI, 'gdl-hsf', 1, text);
	return provideRename(analyze(SCRATCH_URI, text), td, td.positionAt(offset + 1), newName, noOpenDocs);
}

const touched = (edit: { changes?: Record<string, unknown> }) =>
	Object.keys(edit.changes ?? {})
		.map((uri) => URI.parse(uri).fsPath.split('/').slice(-1)[0])
		.sort();

test('a script-local variable renames in that script only', () => {
	// `count` exists in both 2d.gdl and 3d.gdl as unrelated variables.
	const edit = renameAt('3d.gdl', 'count', 'segments');
	assert.deepEqual(touched(edit), ['3d.gdl']);
	// `count = 4`, `to count`, `A / count`, `del count`
	assert.equal(edit.changes![scriptUri('3d.gdl')].length, 4);
});

test('a master-script variable renames across the whole library part', () => {
	// gDetailFactor is defined in 1d.gdl and used in 3d.gdl.
	const edit = renameAt('3d.gdl', 'gDetailFactor', 'gLodFactor');
	assert.deepEqual(touched(edit), ['1d.gdl', '3d.gdl']);
});

test('a parameter renames across scripts, its strings, and paramlist.xml', () => {
	const edit = renameAt('2d.gdl', 'bShowFrame', 'bDrawFrame');
	assert.deepEqual(touched(edit), ['2d.gdl', '3d.gdl', 'paramlist.xml', 'ui.gdl', 'vl.gdl']);

	// vl.gdl mentions it as a bare identifier three times and as `lock "..."`.
	const vl = edit.changes![scriptUri('vl.gdl')];
	assert.equal(vl.length, 4);
	// ui.gdl names it only as a string, in `ui_infield "bShowFrame"`.
	assert.equal(edit.changes![scriptUri('ui.gdl')].length, 1);
});

// --- parameters named by a string --------------------------------------------

test('a parameter renames from its string spelling in VALUES', () => {
	const edit = renameStringAt('vl.gdl', 'iDetailLevel', 'iLod');
	assert.deepEqual(touched(edit), ['1d.gdl', '3d.gdl', 'paramlist.xml', 'ui.gdl', 'vl.gdl']);
	// The edit lands inside the quotes, so the delimiter the author chose stays.
	assert.ok(edit.changes![scriptUri('vl.gdl')].every((e) => e.newText === 'iLod'));
});

test('a parameter renames from its string spelling in LOCK', () => {
	const edit = renameStringAt('vl.gdl', 'bShowFrame', 'bDrawFrame');
	assert.deepEqual(touched(edit), ['2d.gdl', '3d.gdl', 'paramlist.xml', 'ui.gdl', 'vl.gdl']);
});

test('a parameter renames from its string spelling in a UI control', () => {
	// `UI_INFIELD "name"` and `UI_LISTITEM id, field, "name"` are the two
	// shapes the interface script uses; both reach the whole library part.
	const infield = renameStringAt('ui.gdl', 'iDetailLevel', 'iLod');
	assert.deepEqual(touched(infield), ['1d.gdl', '3d.gdl', 'paramlist.xml', 'ui.gdl', 'vl.gdl']);

	const listitem = renameStringAt('ui.gdl', 'matBody', 'matShell');
	assert.deepEqual(touched(listitem), ['3d.gdl', 'paramlist.xml', 'ui.gdl', 'vl.gdl']);
});

test('a fixed parameter cannot be renamed from its string spelling either', () => {
	assert.throws(() => renameStringAt('ui.gdl', 'A', 'width'), RenameError);
});

test('a name that is not a parameter of the part cannot be renamed', () => {
	// vl.gdl locks `bShowFrmae` — a typo `providers/paramRefs.ts` reports.
	// There is no parameter behind it, so there is nothing to rename.
	assert.throws(() => renameStringAt('vl.gdl', 'bShowFrmae', 'bDrawFrame'), RenameError);
});

test('a parameter named by a string still takes an identifier as its new name', () => {
	// Unlike a group or a label, a parameter is written bare as well, so the
	// new name has to be a name GDL would accept there.
	assert.throws(() => renameStringAt('vl.gdl', 'bShowFrame', 'show frame'), RenameError);
});

test('fixed parameters cannot be renamed', () => {
	// `A` carries <Fix/> — Archicad owns the name.
	assert.throws(() => renameAt('2d.gdl', 'A', 'width'), RenameError);
});

test('keywords and globals cannot be renamed', () => {
	assert.throws(() => renameAt('3d.gdl', 'block', 'brick'), RenameError);
	assert.throws(() => renameAt('3d.gdl', 'material', 'surface'), RenameError);
});

test('the new name must be a valid GDL identifier', () => {
	assert.throws(() => renameAt('3d.gdl', 'count', '2fast'), RenameError);
	assert.throws(() => renameAt('3d.gdl', 'count', 'has space'), RenameError);
});

test('the new name must not collide with a GDL name', () => {
	assert.throws(() => renameAt('3d.gdl', 'count', 'CUTPLANE'), RenameError);
	assert.throws(() => renameAt('3d.gdl', 'count', 'WALL_HEIGHT'), RenameError);
});

// --- groups ------------------------------------------------------------------

test('a string-named group renames every place the script names it', () => {
	// `gr_leg` is defined, fed to `subgroup` and killed — three group positions.
	const edit = renameStringAt('3d.gdl', 'gr_leg', 'gr_post');
	assert.deepEqual(touched(edit), ['3d.gdl']);

	const edits = edit.changes![scriptUri('3d.gdl')];
	assert.equal(edits.length, 3);
	// The edit lands inside the quotes, so the delimiter the author chose stays.
	assert.ok(edits.every((e) => e.newText === 'gr_post'));
});

test('a group named by a variable renames as the variable it is', () => {
	// `grLeg` holds a subgroup result: the assignment and the `placegroup`.
	const edit = renameAt('3d.gdl', 'grLeg', 'grPost');
	assert.deepEqual(touched(edit), ['3d.gdl']);
	assert.equal(edit.changes![scriptUri('3d.gdl')].length, 2);
});

test('a matching string that is not a group is left alone', () => {
	const edit = renameInText(
		[
			'group "gr_leg"',
			'\tblock 0.05, 0.05, 0.4',
			'endgroup',
			'placegroup "gr_leg"',
			'text2 0, 0, "gr_leg"\t\t! prose, not a group',
		].join('\n'),
		'"gr_leg"',
		'gr_post',
	);
	assert.equal(edit.changes![SCRATCH_URI].length, 2);
});

test('a group name may hold spaces, being a string and not an identifier', () => {
	const edit = renameInText(
		'group "gr_leg"\nendgroup\nplacegroup "gr_leg"',
		'"gr_leg"',
		'front left leg',
	);
	const edits = edit.changes![SCRATCH_URI];
	assert.equal(edits.length, 2);
	assert.equal(edits[0].newText, 'front left leg');
});

test('a group name may not close its own literal', () => {
	const script = 'group "gr_leg"\nendgroup\nplacegroup "gr_leg"';
	assert.throws(() => renameInText(script, '"gr_leg"', 'gr"post'), RenameError);
	assert.throws(() => renameInText(script, '"gr_leg"', ''), RenameError);
});

test('a group cannot be renamed onto another group of the same script', () => {
	// The guide requires the names unique per script; merging two silently
	// would place one set of bodies where two were meant.
	const script = [
		'group "gr_leg"',
		'endgroup',
		'group "gr_notch"',
		'endgroup',
		'placegroup subgroup("gr_leg", "gr_notch")',
	].join('\n');
	assert.throws(() => renameInText(script, '"gr_leg"', 'gr_notch'), RenameError);
	// Its own name in another case is not a clash — that is a re-spelling.
	assert.equal(renameInText(script, '"gr_leg"', 'GR_Leg').changes![SCRATCH_URI].length, 2);
});

test('a string that names nothing still cannot be renamed', () => {
	assert.throws(() => renameInText('text2 0, 0, "hello"', '"hello"', 'goodbye'), RenameError);
});

test('a group name tabulated into a variable renames with the group', () => {
	// Real corpus shape: the group name is picked out of a table at run time,
	// so the string naming it sits in an assignment with no group keyword in
	// sight. Missing it would leave `placegroup` pointing at nothing.
	const edit = renameInText(
		[
			'group "gr_leg"',
			'\tblock 0.05, 0.05, 0.4',
			'endgroup',
			'gr_out[1] = "gr_leg"',
			'if bMirror then gr_toplace = "gr_leg"',
			'placegroup gr_out[i]',
			'placegroup gr_toplace',
		].join('\n'),
		'"gr_leg"',
		'gr_post',
	);
	assert.equal(edit.changes![SCRATCH_URI].length, 3);
});

test('a comparison against a group variable is not an assignment', () => {
	const edit = renameInText(
		[
			'group "gr_leg"',
			'endgroup',
			'gr_toplace = "gr_leg"',
			'if gr_toplace = "gr_leg" then addz 1',
			'placegroup gr_toplace',
		].join('\n'),
		'"gr_leg"',
		'gr_post',
	);
	// The `group` line and the assignment — not the `if`, which asks a question.
	assert.equal(edit.changes![SCRATCH_URI].length, 2);
});

test('a string held by a variable that is never a group stays a string', () => {
	const edit = renameInText(
		'group "gr_leg"\nendgroup\nsCaption = "gr_leg"\nplacegroup "gr_leg"',
		'"gr_leg"',
		'gr_post',
	);
	assert.equal(edit.changes![SCRATCH_URI].length, 2);
});

// --- jump labels -------------------------------------------------------------

/**
 * A rename over a script supplied here but URI'd into the fixture, so the
 * library part around it is real — which is what a label rename needs, the
 * master script being half of a jump's scope. Sibling scripts are supplied the
 * way `labels.test.ts` supplies them, through the resolver.
 */
function renameLabelIn(
	script: string,
	text: string,
	literal: string,
	newName: string,
	siblings: Record<string, string> = {},
) {
	invalidateMasterScriptCache();
	const uri = scriptUri(script);
	const resolve: TextResolver = (u) => {
		if (u === uri) return text;
		for (const [name, source] of Object.entries(siblings)) {
			if (u === scriptUri(name)) return source;
		}
		// Nothing else of the fixture takes part: an empty script has no labels.
		return '';
	};
	const offset = text.indexOf(literal);
	assert.ok(offset >= 0, `the script should contain ${literal}`);
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideRename(analyze(uri, text), td, td.positionAt(offset + 1), newName, resolve);
}

const SUBROUTINE = [
	'gosub "draw handle"',
	'if bMirror then gosub "draw handle"',
	'end',
	'"draw handle":',
	'\tblock 0.02, 0.02, 0.1',
	'return',
].join('\n');

test('a subroutine renames from its definition and from a jump alike', () => {
	for (const cursor of ['"draw handle":', '"draw handle"']) {
		const edit = renameLabelIn('3d.gdl', SUBROUTINE, cursor, 'draw lever');
		assert.deepEqual(touched(edit), ['3d.gdl']);
		const edits = edit.changes![scriptUri('3d.gdl')];
		// Two jumps and the definition; the edit stays inside the quotes.
		assert.equal(edits.length, 3);
		assert.ok(edits.every((e) => e.newText === 'draw lever'));
	}
});

test('a label rename leaves prose and computed jumps alone', () => {
	const edit = renameLabelIn(
		'3d.gdl',
		[
			'gosub "draw"',
			'gosub "draw" + str(i, 1, 0)\t! computed — unknowable, and not this label',
			'text2 0, 0, "draw"\t\t\t! prose',
			'end',
			'"draw":',
			'return',
		].join('\n'),
		'"draw":',
		'render',
	);
	assert.equal(edit.changes![scriptUri('3d.gdl')].length, 2);
});

test('a label name handed to a variable renames with the label', () => {
	// `Euro-Palette AOL/3d.gdl`: the routine is picked at run time, so the
	// string naming it sits in an assignment with no jump keyword in sight.
	// Missing it would leave `gosub` pointing at a label that no longer exists.
	const edit = renameLabelIn(
		'3d.gdl',
		[
			'if iType = 1 then _substr = "EndBlock" else _substr = "MidBlock"',
			'if _substr = "EndBlock" then addz 0.1\t! a question, not an assignment',
			'sCaption = "EndBlock"\t\t\t\t\t! never jumped through — a plain string',
			'gosub _substr',
			'end',
			'"EndBlock":',
			'return',
		].join('\n'),
		'"EndBlock":',
		'CornerBlock',
	);
	// The definition and the one assignment that names it.
	assert.equal(edit.changes![scriptUri('3d.gdl')].length, 2);
});

test('a numeric label is refused rather than half renamed', () => {
	// `GOSUB 100 + idx` and `COUNT_OFFSET = 107` both name a numeric label
	// without spelling it, so a rename could not find every site.
	assert.throws(
		() => renameLabelIn('3d.gdl', 'gosub 100\nend\n100:\nreturn', '100:', '200'),
		RenameError,
	);
});

test('a label name is a string, so it may hold spaces but not a quote', () => {
	assert.equal(
		renameLabelIn('3d.gdl', SUBROUTINE, '"draw handle":', 'simple tap style').changes![
			scriptUri('3d.gdl')
		].length,
		3,
	);
	assert.throws(() => renameLabelIn('3d.gdl', SUBROUTINE, '"draw handle":', 'a"b'), RenameError);
	assert.throws(() => renameLabelIn('3d.gdl', SUBROUTINE, '"draw handle":', ''), RenameError);
	// A number would answer jumps meant for a numeric label, which matches by value.
	assert.throws(() => renameLabelIn('3d.gdl', SUBROUTINE, '"draw handle":', '100'), RenameError);
});

test('a subroutine cannot be renamed onto another of the same script', () => {
	const script = ['gosub "a"', 'end', '"a":', 'return', '"b":', 'return'].join('\n');
	assert.throws(() => renameLabelIn('3d.gdl', script, '"a":', 'b'), RenameError);
	// Its own name in another case is a re-spelling, not a clash — which is the
	// rename anyone tidying the spelling of a label would reach for.
	assert.equal(renameLabelIn('3d.gdl', script, '"a":', 'A').changes![scriptUri('3d.gdl')].length, 2);
	// Another label's name in another case is refused all the same. GDL would
	// tell `B` from `b`, but nobody reading the script would — it is the
	// near-miss `providers/labels.ts` warns about, and a rename must not make
	// one.
	assert.throws(() => renameLabelIn('3d.gdl', script, '"a":', 'B'), RenameError);
});

test('a jump in another case is a different label, and is left alone', () => {
	// A named label is compared as a string literal, so `GOSUB "A"` does not
	// name `"a":` — rewriting it would point a live jump somewhere new.
	const script = ['gosub "a"', 'gosub "A"', 'end', '"a":', 'return'].join('\n');
	const edits = renameLabelIn('3d.gdl', script, '"a":', 'draw').changes![scriptUri('3d.gdl')];
	assert.equal(edits.length, 2);
	assert.deepEqual(
		edits.map((e) => e.range.start.line).sort(),
		[0, 3],
	);
});

test('a subroutine in the master script renames across the library part', () => {
	// `1d.gdl` runs ahead of every other script, so its labels are the object's.
	const master = 'gosub "shared init"\nend\n"shared init":\nreturn';
	const edit = renameLabelIn('1d.gdl', master, '"shared init":', 'setup', {
		'3d.gdl': 'gosub "shared init"',
	});
	assert.deepEqual(touched(edit), ['1d.gdl', '3d.gdl']);
	assert.equal(edit.changes![scriptUri('1d.gdl')].length, 2);
	assert.equal(edit.changes![scriptUri('3d.gdl')].length, 1);
});

test('a jump renames the master subroutine it resolves to', () => {
	const edit = renameLabelIn('3d.gdl', 'gosub "shared init"', '"shared init"', 'setup', {
		'1d.gdl': 'gosub "shared init"\nend\n"shared init":\nreturn',
	});
	assert.deepEqual(touched(edit), ['1d.gdl', '3d.gdl']);
});

test('a script with a subroutine of its own by that name is left out', () => {
	// Its jumps resolve to its own label, so they are not the master's to move.
	const edit = renameLabelIn('1d.gdl', '"shared":\nreturn', '"shared":', 'setup', {
		'2d.gdl': 'gosub "shared"\nend\n"shared":\nreturn',
		'3d.gdl': 'gosub "shared"',
	});
	assert.deepEqual(touched(edit), ['1d.gdl', '3d.gdl']);
});

test('a subroutine outside the master never leaves its script', () => {
	// A `"draw handle":` in 2d.gdl is a different subroutine entirely.
	const edit = renameLabelIn('3d.gdl', SUBROUTINE, '"draw handle":', 'draw lever', {
		'2d.gdl': 'gosub "draw handle"\nend\n"draw handle":\nreturn',
	});
	assert.deepEqual(touched(edit), ['3d.gdl']);
});

test('a jump that resolves to nothing renames in its own file', () => {
	// The leftover `providers/labels.ts` reports: there is no definition to
	// follow, so the rename cannot reach further than the jumps themselves.
	const edit = renameLabelIn('3d.gdl', 'gosub "gone"\ngosub "gone"', '"gone"', 'here');
	assert.deepEqual(touched(edit), ['3d.gdl']);
	assert.equal(edit.changes![scriptUri('3d.gdl')].length, 2);
});
