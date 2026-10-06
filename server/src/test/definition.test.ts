/**
 * Go-to-definition tests.
 *
 * Every shape here is one found in real library parts: parenthesised
 * `PLACEGROUP ("name")`, operations nested straight into the placement, group
 * names built at run time, and the one-line `IF … THEN PLACEGROUP`.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { URI as Uri } from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze } from '../gdl/analyzer';
import { provideDefinition } from '../providers/definition';

const URI_3D = 'file:///Obj/scripts/3d.gdl';

/**
 * Clicks the `occurrence`-th appearance of `needle` and reports what the jump
 * landed on — the line, and the text the returned range covers.
 */
function definition(source: string, needle: string, occurrence = 1) {
	let index = -1;
	for (let n = 0; n < occurrence; n++) {
		index = source.indexOf(needle, index + 1);
		assert.ok(index >= 0, `test source should contain ${needle} #${n + 1}`);
	}

	const td = TextDocument.create(URI_3D, 'gdl-hsf', 1, source);
	const location = provideDefinition(analyze(URI_3D, source), td, td.positionAt(index + 1));
	if (!location) return undefined;
	assert.ok(!Array.isArray(location), 'a group has one definition');
	return {
		line: location.range.start.line,
		text: source.slice(td.offsetAt(location.range.start), td.offsetAt(location.range.end)),
	};
}

const PARTS = ['group "gr_leg"', '    brick 0.05, 0.05, 0.4', 'endgroup', ''].join('\n');

test('PLACEGROUP finds the GROUP that built the bodies', () => {
	assert.deepEqual(definition(PARTS + 'placegroup "gr_leg"', '"gr_leg"', 2), {
		line: 0,
		text: '"gr_leg"',
	});
});

test('the group name is matched case-insensitively, as GDL is', () => {
	assert.deepEqual(definition(PARTS + 'placegroup "GR_LEG"', '"GR_LEG"'), {
		line: 0,
		text: '"gr_leg"',
	});
});

test('a bracketed argument still names a group', () => {
	// `PLACEGROUP ("group_cylind")` is how much of the corpus writes it.
	assert.deepEqual(definition(PARTS + 'placegroup ("gr_leg")\nkillgroup ("gr_leg")', '"gr_leg"', 3), {
		line: 0,
		text: '"gr_leg"',
	});
});

test('KILLGROUP finds it too', () => {
	assert.deepEqual(definition(PARTS + 'killgroup "gr_leg"', '"gr_leg"', 2), {
		line: 0,
		text: '"gr_leg"',
	});
});

test('a group inside a one-line conditional is still a reference', () => {
	assert.deepEqual(definition(PARTS + 'if i # 1 then placegroup "gr_leg"', '"gr_leg"', 2), {
		line: 0,
		text: '"gr_leg"',
	});
});

test('both operands of a solid operation are group names', () => {
	const source = [
		'group "button4"',
		'endgroup',
		'group "button4_cut"',
		'endgroup',
		'placegroup subgroup("button4","button4_cut")',
	].join('\n');
	assert.deepEqual(definition(source, '"button4"', 2), { line: 0, text: '"button4"' });
	assert.deepEqual(definition(source, '"button4_cut"', 2), { line: 2, text: '"button4_cut"' });
});

test('only the group argument of SWEEPGROUP is a group', () => {
	const source = [
		'group "the_sphere"',
		'endgroup',
		'dz = 3',
		'placegroup sweepgroup{2} ("the_sphere", 2, 0, dz)',
	].join('\n');
	assert.deepEqual(definition(source, '"the_sphere"', 2), { line: 0, text: '"the_sphere"' });
	// `dz` is a distance, so it is not a group and must not resolve as one.
	assert.equal(definition(source, 'dz', 2), undefined);
});

test('a group-typed variable resolves to the operation that produced it', () => {
	const source = [
		'result_1 = subgroup("box", "sphere")',
		'result_2 = isectgroup("semisphere", "brick")',
		'result_3 = addgroup(result_1, result_2)',
		'placegroup result_3',
	].join('\n');
	assert.deepEqual(definition(source, 'result_3', 2), { line: 2, text: 'result_3' });
	// …including where one operation feeds the next.
	assert.deepEqual(definition(source, 'result_1', 2), { line: 0, text: 'result_1' });
});

test('a group named by a variable resolves to its GROUP statement', () => {
	// Idiomatic when groups are built in a loop: the name is computed, so only
	// the variable can be followed.
	const source = [
		'fixingGroup = "fixing" + str(_iEdge, 1, 0)',
		'group fixingGroup',
		'    brick 0.01, 0.01, 0.01',
		'endgroup',
		'placegroup fixingGroup',
		'killgroup fixingGroup',
	].join('\n');
	assert.deepEqual(definition(source, 'fixingGroup', 3), { line: 1, text: 'fixingGroup' });

	// Standing on the GROUP statement itself falls through to the assignment
	// that made the name, rather than resolving to where the cursor already is.
	assert.deepEqual(definition(source, 'fixingGroup', 2), { line: 0, text: 'fixingGroup' });
});

test('a group held in an array resolves, but its index does not', () => {
	// `PLACEGROUP gr_out[meq1_front[i]]` — the array is the group expression,
	// everything inside the brackets is arithmetic.
	const source = [
		'gr_out[1] = subgroup("box", "sphere")',
		'meq1_front[1] = 1',
		'placegroup gr_out[meq1_front[i]]',
	].join('\n');
	assert.deepEqual(definition(source, 'gr_out', 2), { line: 0, text: 'gr_out' });
	assert.equal(definition(source, 'meq1_front', 2), undefined);
});

test('a name that is merely concatenated is not resolved', () => {
	const source = ['suffix = "leg"', 'group "gr_leg"', 'endgroup', 'placegroup ("gr_" + suffix)'].join('\n');
	assert.equal(definition(source, 'suffix', 2), undefined);
	assert.equal(definition(source, '"gr_"'), undefined);
});

test('a string that is not in a group position names no group', () => {
	assert.equal(definition(PARTS + 'text2 0, 0, "gr_leg"', '"gr_leg"', 2), undefined);
	assert.equal(definition(PARTS + 'call "gr_leg"', '"gr_leg"', 2), undefined);
});

test('an unknown group has no definition to jump to', () => {
	assert.equal(definition(PARTS + 'placegroup "gr_arm"', '"gr_arm"'), undefined);
});

// --- Inline attributes ------------------------------------------------------

const FIXTURES = join(__dirname, '..', '..', '..', 'TestObject');
const partUri = (script: string) => Uri.file(join(FIXTURES, 'TestObject', 'scripts', script)).toString();

/**
 * Like `definition`, but in a script of `TestObject` with its master's text
 * supplied, and reporting every location — a style may be defined more than once.
 */
function attributeJump(source: string, needle: string, occurrence = 1, master = '') {
	let index = -1;
	for (let n = 0; n < occurrence; n++) {
		index = source.indexOf(needle, index + 1);
		assert.ok(index >= 0, `test source should contain ${needle} #${n + 1}`);
	}
	const uri = partUri('2d.gdl');
	const masterUri = partUri('1d.gdl');
	const td = TextDocument.create(uri, 'gdl-hsf', 1, source);
	const resolve = (u: string) => (u === masterUri ? master : u === uri ? source : undefined);
	const result = provideDefinition(analyze(uri, source), td, td.positionAt(index + 1), resolve);
	if (!result) return undefined;
	return (Array.isArray(result) ? result : [result]).map((l) => {
		const text = l.uri === masterUri ? master : source;
		const ltd = TextDocument.create(l.uri, 'gdl-hsf', 0, text);
		return {
			script: l.uri.split('/').pop(),
			line: l.range.start.line,
			text: text.slice(ltd.offsetAt(l.range.start), ltd.offsetAt(l.range.end)),
		};
	});
}

test('SET STYLE finds the DEFINE STYLE in the same script', () => {
	const source = ['define style "Label" "Arial", 2, 5, 0', 'set style "Label"', 'text2 0, 0, "x"'].join('\n');
	assert.deepEqual(attributeJump(source, '"Label"', 2), [{ script: '2d.gdl', line: 0, text: '"Label"' }]);
});

test('STYLE without SET, DEFINE STYLE{2}, and case are all followed', () => {
	const source = ['define style{2} "Label" "Arial", 2, 0', 'if a then style "LABEL"'].join('\n');
	assert.deepEqual(attributeJump(source, '"LABEL"'), [{ script: '2d.gdl', line: 0, text: '"Label"' }]);
});

test('a style the master script defines is found there', () => {
	const master = ['x = 1', 'define style "Label" "Arial", 2, 5, 0'].join('\n');
	assert.deepEqual(attributeJump('set style "Label"', '"Label"', 1, master), [
		{ script: '1d.gdl', line: 1, text: '"Label"' },
	]);
});

test("this script's own definition wins over the master's", () => {
	const master = 'define style "Label" "Arial", 2, 5, 0';
	const source = ['define style "Label" "Arial", 3, 5, 0', 'set style "Label"'].join('\n');
	assert.deepEqual(attributeJump(source, '"Label"', 2, master), [{ script: '2d.gdl', line: 0, text: '"Label"' }]);
});

test('a style defined once per branch offers every definition', () => {
	const source = [
		'if gs_detlevel_2D = 1 then',
		'    define style "Label" "Arial", 2, 5, 0',
		'else',
		'    define style "Label" "Arial", 3, 5, 0',
		'endif',
		'set style "Label"',
	].join('\n');
	assert.deepEqual(
		attributeJump(source, '"Label"', 3)?.map((l) => l.line),
		[1, 3],
	);
});

test('a style named by a bare identifier is matched either way', () => {
	const source = ['define style lsg_tStyleName "Arial", 2, 5, 0', 'set style lsg_tStyleName'].join('\n');
	assert.deepEqual(attributeJump(source, 'lsg_tStyleName', 2), [
		{ script: '2d.gdl', line: 0, text: 'lsg_tStyleName' },
	]);
});

test('the other inline attributes are followed the same way', () => {
	const source = [
		'define material "glass" 0, 0.5, 0.6, 0.6',
		'define solid_fill "solid"',
		'define symbol_line "dashes" 1, 1, 1',
		'material "glass"',
		'set fill "solid"',
		'line_type "dashes"',
	].join('\n');
	assert.deepEqual(attributeJump(source, '"glass"', 2)?.[0].line, 0);
	assert.deepEqual(attributeJump(source, '"solid"', 2)?.[0].line, 1);
	assert.deepEqual(attributeJump(source, '"dashes"', 2)?.[0].line, 2);
	// A style of the same name is a different attribute.
	assert.equal(attributeJump(source + '\nstyle "glass"', '"glass"', 3), undefined);
});

test('a computed or undefined style name goes nowhere', () => {
	const source = ['define style "t_1" "Arial", 2, 5, 0', 'style "t_" + n', 'style styles[1]', 'style "Other"'].join(
		'\n',
	);
	assert.equal(attributeJump(source, '"t_"'), undefined);
	assert.equal(attributeJump(source, 'styles'), undefined);
	assert.equal(attributeJump(source, '"Other"'), undefined);
	// …and the definition itself is not a reference.
	assert.equal(attributeJump(source, '"t_1"'), undefined);
});
