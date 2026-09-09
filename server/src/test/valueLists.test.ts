/**
 * The values a name may take, from the reference guide and from the object's
 * own parameter script.
 *
 * Every guide shape here was taken from a real page — the pages themselves are
 * not vendored, so they are rebuilt in a temp folder the way `hover.test.ts`
 * does — and every `VALUES` shape from the corpus. The counts quoted in the
 * comments are what the sweep measured; see CLAUDE.md.
 */

import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { URI } from 'vscode-uri';
import { analyze } from '../gdl/analyzer';
import { setReferenceRoot } from '../gdl/referenceDocs';
import { documentedValues, declaredValues, valuesFor, valueNameAt } from '../gdl/valueLists';

const OBJECT_ROOT = join(__dirname, '..', '..', '..', 'TestObject', 'TestObject');
const scriptUri = (name: string) => URI.file(join(OBJECT_ROOT, 'scripts', name)).toString();

/** Nothing open in an editor, so sibling scripts are read from disk. */
const noOpenDocs = () => undefined;

function doc(script: string, text?: string) {
	const uri = scriptUri(script);
	return analyze(uri, text ?? readFileSync(URI.parse(uri).fsPath, 'utf8'));
}

// --- the reference guide ------------------------------------------------------

const referenceRoot = mkdtempSync(join(tmpdir(), 'gdl-values-'));
mkdirSync(referenceRoot, { recursive: true });
after(() => rmSync(referenceRoot, { recursive: true, force: true }));

function writePage(name: string, details: string[]) {
	const paragraphs = details.map((d) => `<p>\n    ${d}\n</p>`).join('\n');
	writeFileSync(
		join(referenceRoot, `${name}.html`),
		`<html><body class="gdlglobal"><table>
			<tr><td><b>${name}</b></td><td>test gloss</td></tr>
			<tr><td colspan="2" style="padding-left:1em; font-style: italic">${paragraphs}</td></tr>
		</table></body></html>`,
		'utf8',
	);
}

// GLOB_VIEW_TYPE — one value per paragraph, then a closing piece of advice.
writePage('GLOB_VIEW_TYPE', [
	'2 - 2D (Floor Plan)',
	'3 - 3D',
	'4 - Section',
	'Use the exact needed values. Using ranges are not recommended.',
]);
// GLOB_CONTEXT — the whole list in one paragraph, with prose behind it.
writePage('GLOB_CONTEXT', [
	'1 - library part editor, 2 - floor plan, 3 - 3D view. See the section called “GDL execution contexts” for more.',
]);
// AC_EDGE_LOWER_TYPE — a lead-in sentence runs straight into the list.
writePage('AC_EDGE_LOWER_TYPE', ['Cut type of the lower edge: 0 - Vertical, 1 - Perpendicular, 2 - Horizontal']);
// SYMB_MIRRORED — the dash is not always spaced.
writePage('SYMB_MIRRORED', ['0-no, 1-yes']);
// GLOB_SCRIPT_TYPE — a description may itself open with a digit.
writePage('GLOB_SCRIPT_TYPE', ['1 - properties script', '2 - 2D script', '3 - 3D script']);
// CWFRAME_POSITION — today's meanings, then what they used to be.
writePage('CWFRAME_POSITION', [
	'0 - vertical, 1 - horizontal',
	'Compatibility: up to Archicad 21 … 0 - primary gridline, 1 - secondary gridline',
]);
// AC_CON_WALL_DIRECTION_TYPE — the same history, written as an aside.
writePage('AC_CON_WALL_DIRECTION_TYPE', ['0 - not flipped, 1 - flipped. (old meaning: 0 - Right, 1 - Left)']);
// WALL_SKINS_PARAMS — an array's columns, one of which has values of its own.
writePage('WALL_SKINS_PARAMS', ['[6] core status', 'core status: 0 - not part, 1 - part, 3 - last core skin.']);
// A page with nothing to enumerate, and one with a single value.
writePage('GLOB_SCALE', ['view dependent, do not use in parameter scripts']);
writePage('SOME_SINGLE', ['0 - only one of these']);

const insertsOf = (name: string) => documentedValues(name).map((v) => v.insert);
const pairsOf = (name: string) => documentedValues(name).map((v) => `${v.insert}=${v.meaning}`);

test('a value per paragraph, the guide’s closing advice left out', () => {
	setReferenceRoot(referenceRoot);
	assert.deepEqual(pairsOf('GLOB_VIEW_TYPE'), ['2=2D (Floor Plan)', '3=3D', '4=Section']);
});

test('a whole list in one paragraph, with the prose behind it trimmed', () => {
	setReferenceRoot(referenceRoot);
	assert.deepEqual(pairsOf('GLOB_CONTEXT'), ['1=library part editor', '2=floor plan', '3=3D view']);
});

test('a lead-in sentence runs into the list', () => {
	setReferenceRoot(referenceRoot);
	assert.deepEqual(pairsOf('AC_EDGE_LOWER_TYPE'), ['0=Vertical', '1=Perpendicular', '2=Horizontal']);
});

test('the dash need not be spaced, and a description may open with a digit', () => {
	setReferenceRoot(referenceRoot);
	assert.deepEqual(pairsOf('SYMB_MIRRORED'), ['0=no', '1=yes']);
	// `2 - 2D script` would be thrown out by any rule that made the description
	// start with a letter.
	assert.deepEqual(pairsOf('GLOB_SCRIPT_TYPE'), ['1=properties script', '2=2D script', '3=3D script']);
});

test('the version history is not offered as current values', () => {
	setReferenceRoot(referenceRoot);
	// A `Compatibility:` paragraph ends the page…
	assert.deepEqual(pairsOf('CWFRAME_POSITION'), ['0=vertical', '1=horizontal']);
	// …and a repeated value ends the list wherever it is written.
	assert.deepEqual(pairsOf('AC_CON_WALL_DIRECTION_TYPE'), ['0=not flipped', '1=flipped']);
});

test('a page describing an array’s columns offers nothing', () => {
	setReferenceRoot(referenceRoot);
	// The values belong to one column, not to the name — offering them would
	// claim `WALL_SKINS_PARAMS` itself is 0, 1 or 3.
	assert.deepEqual(insertsOf('WALL_SKINS_PARAMS'), []);
});

test('a page with nothing to enumerate, or only one value, offers nothing', () => {
	setReferenceRoot(referenceRoot);
	assert.deepEqual(insertsOf('GLOB_SCALE'), []);
	assert.deepEqual(insertsOf('SOME_SINGLE'), []);
	assert.deepEqual(insertsOf('NO_SUCH_PAGE'), []);
});

// --- the object's own VALUES ---------------------------------------------------

const declared = (script: string, text: string, parameter: string) =>
	declaredValues(parameter, doc(script, text), noOpenDocs).map(
		(v) => v.insert + (v.meaning === undefined ? '' : ` (${v.meaning})`),
	);

test('a plain VALUES lists its values, with no meanings to give', () => {
	assert.deepEqual(declared('vl.gdl', 'values "iDetailLevel" 1, 2, 3', 'iDetailLevel'), ['1', '2', '3']);
	// The comma after the name is optional; both spellings are real.
	assert.deepEqual(declared('vl.gdl', 'values "iDetailLevel", 1, 2, 3', 'iDetailLevel'), ['1', '2', '3']);
});

test('VALUES{2} pairs each value with its caption', () => {
	assert.deepEqual(
		declared('vl.gdl', 'values{2} "iDetailLevel" 0, "off", 1, `on`', 'iDetailLevel'),
		['0 (off)', '1 (on)'],
	);
});

test('a string parameter keeps its quotes, which is what must be written', () => {
	assert.deepEqual(declared('vl.gdl', 'values "matBody" "brick", "timber"', 'matBody'), ['"brick"', '"timber"']);
});

test('RANGE and CUSTOM are not values', () => {
	assert.deepEqual(declared('vl.gdl', 'values "iDetailLevel" range[1, 10)', 'iDetailLevel'), []);
	assert.deepEqual(declared('vl.gdl', 'values "iDetailLevel" 1, 2, CUSTOM', 'iDetailLevel'), ['1', '2']);
});

test('only the first argument of VALUES names the parameter', () => {
	// `"brick"` and `"timber"` are values of matBody, not parameters of their own.
	assert.deepEqual(declared('vl.gdl', 'values "matBody" "brick", "timber"', 'brick'), []);
});

// --- the poor man's enum -------------------------------------------------------

/**
 * The shape this feature exists for: the value is a named constant, the caption
 * a slot of a table, and neither says anything without the other.
 */
const ENUM_SOURCE = [
	'DIR_PERPEND = 1',
	'DIR_ALIGNED = 2',
	'stDir[DIR_PERPEND] = "Perpendicular"',
	'stDir[DIR_ALIGNED] = "Aligned"',
	'values{2} "iMarkerDir" DIR_PERPEND, stDir[DIR_PERPEND], DIR_ALIGNED, stDir[DIR_ALIGNED]',
].join('\n');

test('a named value resolves to the caption its table holds', () => {
	assert.deepEqual(declared('vl.gdl', ENUM_SOURCE, 'iMarkerDir'), [
		'DIR_PERPEND (Perpendicular)',
		'DIR_ALIGNED (Aligned)',
	]);
});

test('the constant is what gets written, not the number behind it', () => {
	const values = declaredValues('iMarkerDir', doc('vl.gdl', ENUM_SOURCE), noOpenDocs);
	assert.equal(values[0].insert, 'DIR_PERPEND');
	// The number is still known — it answers the question a reader of the old
	// code will have — but it is not what belongs in the script.
	assert.equal(values[0].numeric, 1);
});

test('the constants may live in the master script', () => {
	// 1d.gdl defines DIR_* and fills stMarkerDir; vl.gdl holds the VALUES{2}.
	// Both reach a 3D script, which is where the comparison usually gets typed.
	assert.deepEqual(
		valuesFor('iMarkerDir', doc('3d.gdl'), noOpenDocs)?.values.map((v) => `${v.insert}=${v.meaning}`),
		[
			'DIR_PERPENDICULAR=Perpendicular to the marker axis',
			'DIR_ALIGNED=Aligned with the marker axis',
			'DIR_HORIZONTAL=Horizontal',
			'DIR_VERTICAL=Vertical',
		],
	);
});

test('a caption that cannot be resolved costs the meaning, never the value', () => {
	// `+` is GDL's string concatenation, so this caption is built at run time —
	// 221 of the corpus's 2615 paired values are written this way.
	assert.deepEqual(
		declared('vl.gdl', ['DIR_A = 1', 'stDir[1] = "x" + suffix', 'values{2} "iMarkerDir" DIR_A, stDir[1]'].join('\n'), 'iMarkerDir'),
		['DIR_A'],
	);
	// An unknown name resolves to nothing at all, and still offers the value.
	assert.deepEqual(
		declared('vl.gdl', 'values{2} "iMarkerDir" DIR_UNKNOWN, stNowhere[3]', 'iMarkerDir'),
		['DIR_UNKNOWN'],
	);
});

test('a name written twice is a variable, not a constant', () => {
	// `i` is a counter, so `stDir[i]` names no particular slot and the table is
	// not indexable through it.
	const source = ['i = 1', 'i = i + 1', 'stDir[i] = "Perpendicular"', 'values{2} "iMarkerDir" 1, stDir[i]'].join('\n');
	assert.deepEqual(declared('vl.gdl', source, 'iMarkerDir'), ['1']);
});

test('a table written through an unknown index is not read at any slot', () => {
	// The loop write could have landed on slot 1, so slot 1 is not trustworthy
	// even though it was also written directly.
	const source = [
		'stDir[1] = "Perpendicular"',
		'for k = 1 to 4',
		'stDir[k] = "Something else"',
		'next k',
		'values{2} "iMarkerDir" 1, stDir[1]',
	].join('\n');
	assert.deepEqual(declared('vl.gdl', source, 'iMarkerDir'), ['1']);
});

test('an equality test is not an assignment', () => {
	// `=` is both operators, as everywhere in GDL: this asks a question and
	// defines nothing, so there is no caption to find.
	const source = [
		'if stDir[1] = "Perpendicular" then addx 1',
		'DIR_A = 1',
		'values{2} "iMarkerDir" DIR_A, stDir[1]',
	].join('\n');
	assert.deepEqual(declared('vl.gdl', source, 'iMarkerDir'), ['DIR_A']);
});

test('two whole tables filled in step are paired positionally', () => {
	// The subscript is a running counter, so nothing here folds — the pairing
	// comes from the tables agreeing, which is what `aMidGeometry, sMidGeometry`
	// relies on in real code.
	const source = [
		'aDir[i] = GEOM_A : sDir[i] = "First" : i = i + 1',
		'aDir[i] = GEOM_B : sDir[i] = "Second" : i = i + 1',
		'values{2} "iMarkerDir" aDir, sDir',
	].join('\n');
	assert.deepEqual(declared('vl.gdl', source, 'iMarkerDir'), ['GEOM_A (First)', 'GEOM_B (Second)']);
});

test('tables that were not filled in step offer nothing at all', () => {
	// Offering something here would put a table's own name where a value goes.
	const source = [
		'aDir[i] = GEOM_A : i = i + 1',
		'sDir[j] = "First" : sDir[j] = sDir[j] + " (more)" : j = j + 1',
		'values{2} "iMarkerDir" aDir, sDir',
	].join('\n');
	assert.deepEqual(declared('vl.gdl', source, 'iMarkerDir'), []);
});

test('a single table supplies the values of a plain VALUES', () => {
	const source = ['stShow[1] = "Roof"', 'stShow[2] = "Wall"', 'values "matBody" stShow'].join('\n');
	assert.deepEqual(declared('vl.gdl', source, 'matBody'), ['"Roof"', '"Wall"']);
});

// --- which source answers ------------------------------------------------------

test('the object’s own list outranks the guide', () => {
	setReferenceRoot(referenceRoot);
	// ac_bottomlevel is in this part's paramlist.xml, so a VALUES for it wins.
	const source = 'values{2} "ac_bottomlevel" 0, "Ground", 1, "First"';
	const set = valuesFor('ac_bottomlevel', doc('vl.gdl', source), noOpenDocs);
	assert.equal(set?.source, 'values');
	assert.deepEqual(set?.values.map((v) => v.insert), ['0', '1']);
});

test('a global falls to the guide, having no parameter list to consult', () => {
	setReferenceRoot(referenceRoot);
	const set = valuesFor('GLOB_VIEW_TYPE', doc('3d.gdl', 'if GLOB_VIEW_TYPE = 2 then addx 1'), noOpenDocs);
	assert.equal(set?.source, 'guide');
	assert.deepEqual(set?.values.map((v) => v.insert), ['2', '3', '4']);
});

// --- where the cursor has to be ------------------------------------------------

/**
 * `\u2038` marks the cursor and is removed before the text is analysed.
 *
 * Not `|`, which is GDL's boolean OR and appears in the continued-line case
 * below — the first version of this helper found the operator instead.
 */
const CURSOR = '\u2038';

function nameAt(text: string): string | undefined {
	const offset = text.indexOf(CURSOR);
	assert.notEqual(offset, -1, 'the test text must carry a cursor');
	const source = text.slice(0, offset) + text.slice(offset + CURSOR.length);
	return valueNameAt(doc('3d.gdl', source), offset);
}

test('the name being compared is found', () => {
	assert.equal(nameAt('if GLOB_VIEW_TYPE = \u2038'), 'GLOB_VIEW_TYPE');
	assert.equal(nameAt('if GLOB_VIEW_TYPE =\u2038'), 'GLOB_VIEW_TYPE');
	assert.equal(nameAt('count = \u2038'), 'count');
	// The word already being typed is not yet an operand.
	assert.equal(nameAt('if iMarkerDir = DIR_\u2038'), 'iMarkerDir');
	// Later in a chain, and after the other two equality operators.
	assert.equal(nameAt('if a = 1 & GLOB_VIEW_TYPE = \u2038'), 'GLOB_VIEW_TYPE');
	assert.equal(nameAt('if GLOB_VIEW_TYPE <> \u2038'), 'GLOB_VIEW_TYPE');
	assert.equal(nameAt('if GLOB_VIEW_TYPE # \u2038'), 'GLOB_VIEW_TYPE');
	// An array parameter is compared one element at a time.
	assert.equal(nameAt('if pen[1] = \u2038'), 'pen');
	// A continued line is still the same statement.
	assert.equal(nameAt('if a = 1 | \\\n\tGLOB_VIEW_TYPE = \u2038'), 'GLOB_VIEW_TYPE');
});

test('a position that is not a value is left alone', () => {
	// Ordering comparisons are not offered: the guide asks for exact values.
	assert.equal(nameAt('if GLOB_VIEW_TYPE > \u2038'), undefined);
	assert.equal(nameAt('if GLOB_VIEW_TYPE = 2 then \u2038'), undefined);
	assert.equal(nameAt('addx \u2038'), undefined);
	assert.equal(nameAt('\u2038'), undefined);
	// A line break ends it — the `=` above belongs to a statement that is done.
	assert.equal(nameAt('count = 1\n\u2038'), undefined);
	// Nothing stands to the left of the operator.
	assert.equal(nameAt('if then = \u2038'), undefined);
});
