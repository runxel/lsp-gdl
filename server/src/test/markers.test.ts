/**
 * `END` / `EXIT` markers.
 *
 * The client rules a line under each of these, so a false one strikes through
 * working code and a missed one leaves the terminator invisible. Every shape
 * below is one the corpus actually holds — the `IF … THEN END` early-out and
 * the wrapped `END v1, v2,` return list are the two that decide where the rule
 * lands.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { URI } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideScriptEndMarkers } from '../providers/markers';

const uri = URI.file(join(__dirname, '..', '..', '..', 'TestObject', 'TestObject', 'scripts', '3d.gdl')).toString();

/** The 0-based lines each terminating statement *finishes* on. */
function lines(text: string): number[] {
	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	return provideScriptEndMarkers(analyze(uri, text), td).map((r) => r.start.line);
}

test('both spellings are marked, and a script may hold several', () => {
	// The guide gives END and EXIT one page: they are synonyms.
	assert.deepEqual(lines('block 1, 1, 1\nend\naddz 1\nexit\n'), [1, 3]);
});

test('the early-out is found mid-statement', () => {
	// `IF NOT (BITTEST (macro_runtype, 4)) THEN END` — most of the corpus's
	// terminators sit behind a THEN, so reading stmt.head would miss them.
	assert.deepEqual(lines('if noHandle then end\nblock 1, 1, 1\n'), [0]);
	assert.deepEqual(lines('if macro_runtype = 1 then end ui_page_type\n'), [0]);
});

test('a wrapped return list is ruled under its last row', () => {
	// `bim-all-doors/…/Generic_frame_macro/1d.gdl`: the return list wraps on a
	// trailing comma like any other argument list, and the rule closes the
	// statement — so it belongs under the last variable, not under the `END`.
	assert.deepEqual(lines('end var1,\nvar2,\nvar3\n'), [2]);
	assert.deepEqual(
		lines('if macro_runtype = 512 then end offsetFrameSurfaceBGS,\t! nur Umgebung\n\tfacingLintelBS, facingLintelBGS,\n\tframe2wallSurfaceBS\n'),
		[2],
	);
	// A continuation survives a blank line, so the list may hold one.
	assert.deepEqual(lines('end iUiID_Root,\n\n\tiParID_Shape\n'), [2]);
});

test('a statement is ruled once, however many terminators it holds', () => {
	assert.deepEqual(lines('end\n'), [0]);
});

test('a banner comment is not a terminator', () => {
	// `! ===== end ===== end =====` and `!===END==========` are both real.
	assert.deepEqual(lines('block 1, 1, 1\t! ===== end =====\n!===END==========\n'), []);
	assert.deepEqual(lines('text2 0, 0, "end"\n'), []);
});

test('a keyword that merely starts with END is left alone', () => {
	assert.deepEqual(lines('if a then\n\tblock 1, 1, 1\nendif\ngroup "g"\nendgroup\n'), []);
});

test('case is irrelevant, as everywhere in GDL', () => {
	assert.deepEqual(lines('End\n'), [0]);
	assert.deepEqual(lines('EXIT\n'), [0]);
});
