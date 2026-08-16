/**
 * Hover tests.
 *
 * Two things are worth pinning down here: that a name arriving from the master
 * script is explained rather than ignored, and that reference documentation is
 * picked up from the GRAPHISOFT extension when it is installed — and quietly
 * skipped when it is not.
 *
 * The reference pages used below are written by this test, in the shape the
 * real ones have. The guide's own text is never copied into this repo; it is
 * read at run time from the user's own installation.
 */

import { test, after } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { URI } from 'vscode-uri';
import { analyze } from '../gdl/analyzer';
import { tokenize } from '../gdl/lexer';
import { provideHover } from '../providers/hover';
import { setReferenceRoot } from '../gdl/referenceDocs';

const OBJECT_ROOT = join(__dirname, '..', '..', '..', 'TestObject', 'TestObject');
const scriptPath = (name: string) => join(OBJECT_ROOT, 'scripts', name);
const scriptUri = (name: string) => URI.file(scriptPath(name)).toString();

/** Nothing is open in an editor during these tests, so always fall to disk. */
const noOpenDocs = () => undefined;

/** Hovers the first identifier token spelling `symbol`. */
function hover(script: string, symbol: string, source?: string): string | undefined {
	const uri = scriptUri(script);
	const text = source ?? readFileSync(scriptPath(script), 'utf8');
	const token = tokenize(text).find((t) => t.type === 'identifier' && t.lower === symbol.toLowerCase());
	assert.ok(token, `source should use ${symbol} as an identifier`);

	const td = TextDocument.create(uri, 'gdl-hsf', 1, text);
	const result = provideHover(analyze(uri, text), td, td.positionAt(token.start + 1), noOpenDocs);
	if (!result) return undefined;
	const contents = result.contents as { value: string };
	return contents.value;
}

// --- master-script variables --------------------------------------------------

test('a variable from the master script is explained where it is used', () => {
	// `gDetailFactor` is defined in 1d.gdl and only read in 3d.gdl.
	const text = hover('3d.gdl', 'gDetailFactor');
	assert.ok(text, 'gDetailFactor should hover in 3d.gdl');
	assert.match(text, /\*\*Master-script variable\*\*/);
	assert.match(text, /1d\.gdl/);
	// The defining line itself, so the value is visible without opening it.
	assert.match(text, /gDetailFactor = 1/);
});

test('a local variable still wins over the master script', () => {
	const text = hover('3d.gdl', 'count');
	assert.match(text ?? '', /\*\*Local variable\*\*/);
});

test('in the master script itself the variable is simply local', () => {
	const text = hover('1d.gdl', 'gDetailFactor');
	assert.match(text ?? '', /\*\*Local variable\*\*/);
});

test('a master-script name marked private by convention says so', () => {
	// `_scratchAngle` is never offered as a completion outside 1d.gdl, so
	// meeting one in another script is exactly when an explanation is needed.
	const text = hover('3d.gdl', '_scratchAngle', 'rotz _scratchAngle\n');
	assert.ok(text, '_scratchAngle should hover in 3d.gdl');
	assert.match(text, /\*\*Master-script variable\*\*/);
	assert.match(text, /private to the master script/);
});

test('an unknown name hovers to nothing', () => {
	assert.equal(hover('3d.gdl', 'nSomethingElse', 'addz nSomethingElse\n'), undefined);
});

// --- reference documentation for globals --------------------------------------

const referenceRoot = mkdtempSync(join(tmpdir(), 'gdl-reference-'));
mkdirSync(referenceRoot, { recursive: true });
after(() => rmSync(referenceRoot, { recursive: true, force: true }));

/**
 * A page in the shape the reference guide uses for globals. `matrix` is the
 * availability row, written the way the guide draws it — labels and tick or
 * cross images. See `referenceDocs.test.ts` for what that row can look like.
 */
function writePage(name: string, summary: string, details: string[] = [], matrix?: string) {
	const paragraphs = details.map((d) => `<p>\n    ${d}\n</p>`).join('\n');
	writeFileSync(
		join(referenceRoot, `${name}.html`),
		`<html><body class="gdlglobal"><table>
			<tr><td style="width:37%"><b>${name}</b></td><td style="width:63%">${summary}</td></tr>
			${matrix ? `<tr colspan="2"><td colspan="2"><div style="display:table-row;">${matrix}</div></div></td></tr>` : ''}
			${details.length ? `<tr><td colspan="2" style="padding-left:1em; font-style: italic">${paragraphs}</td></tr>` : ''}
		</table></body></html>`,
		'utf8',
	);
}

const CHECK = '<img alt="Check" src="Images/GDL_Images/GDL_CheckIcon.png"/>';
const ERROR = '<img alt="Error" src="Images/GDL_Images/GDL_ErrorIcon.png"/>';
const cell = (label: string, mark: string) => `<div>${label}</div><div>${mark}</div>`;

writePage('SYMB_MIRRORED', 'test gloss for a mirrored part', [
	'0-no, 1-yes &amp; nothing else',
	'a second paragraph, to check both are kept',
]);
writePage(
	'GLOB_SCALE',
	'test gloss with an entity: 1&#8217;6"',
	[],
	cell('2D', CHECK) + cell('3D', CHECK) + cell('UI', ERROR) + cell('Parameter', ERROR) + cell('Property', ERROR) + cell('Default', '100'),
);
// A fixed parameter's first column is its type, not a gloss…
writePage('ac_bottomlevel', 'length', ['test explanation of the lowest point of the object']);
// …and a few of the ifc_ pages repeat the name in front of it.
writePage('ifc_MullionThickness', 'ifc_MullionThickness - length', ['test width of the mullion']);

test('a global carries the reference guide description', () => {
	setReferenceRoot(referenceRoot);
	const text = hover('3d.gdl', 'SYMB_MIRRORED', 'if SYMB_MIRRORED then addx 1\n');
	assert.ok(text, 'SYMB_MIRRORED should hover');
	assert.match(text, /\*\*Global variable\*\*/);
	assert.match(text, /test gloss for a mirrored part/);
	// Entities are decoded, and every detail paragraph is kept.
	assert.match(text, /0-no, 1-yes & nothing else/);
	assert.match(text, /a second paragraph/);
});

test('entities in the summary are decoded too', () => {
	setReferenceRoot(referenceRoot);
	assert.match(hover('3d.gdl', 'GLOB_SCALE', 'a = GLOB_SCALE\n') ?? '', /1’6"/);
});

test('the availability matrix narrows what the hover claims', () => {
	setReferenceRoot(referenceRoot);
	// The keyword table credits every global to every script; the guide's matrix
	// crosses out three columns for this one, and the default is worth showing.
	const text = hover('3d.gdl', 'GLOB_SCALE', 'a = GLOB_SCALE\n') ?? '';
	assert.match(text, /_Valid in: Master script, 2D script, 3D script, Forward migration script, Backward migration script_/);
	assert.match(text, /\*\*Default:\*\* `100`/);
	assert.doesNotMatch(text, /⚠️ Not normally valid/);
});

test('a global read in a script the guide rules out is flagged', () => {
	setReferenceRoot(referenceRoot);
	const text = hover('vl.gdl', 'GLOB_SCALE', 'values "x" GLOB_SCALE\n') ?? '';
	assert.match(text, /⚠️ Not normally valid in the \*\*Parameter script\*\*/);
});

test('a global with no page still hovers, without a description', () => {
	setReferenceRoot(referenceRoot);
	const text = hover('3d.gdl', 'SYMB_POS_X', 'a = SYMB_POS_X\n');
	assert.ok(text, 'SYMB_POS_X should still hover from the keyword table');
	assert.match(text, /\*\*Global variable\*\*/);
	assert.match(text, /Valid in:/);
});

test('a fixed parameter shows its type and what it does', () => {
	setReferenceRoot(referenceRoot);
	// Read outside any library part that declares it, so this is the keyword
	// branch — `ifc_` names are add-on parameters an object rarely lists.
	const text = hover('3d.gdl', 'ifc_MullionThickness', 'a = ifc_MullionThickness\n');
	assert.ok(text, 'ifc_MullionThickness should hover');
	assert.match(text, /\*\*Fixed named parameter\*\*/);
	// The name is already the heading, so it is stripped from the type column.
	assert.match(text, /\*\*Type:\*\* length/);
	assert.match(text, /test width of the mullion/);
});

test('a fixed parameter the library part declares keeps its own type', () => {
	setReferenceRoot(referenceRoot);
	// `ac_bottomlevel` is in the fixture's paramlist.xml, so hover answers from
	// there — the XML knows the type and the dialog label — and the guide adds
	// the explanation the XML has no room for.
	const text = hover('3d.gdl', 'ac_bottomlevel', 'a = ac_bottomlevel\n');
	assert.ok(text, 'ac_bottomlevel should hover');
	assert.match(text, /\*\*Length parameter\*\* of `TestObject`/);
	assert.match(text, /Bottom Level/);
	assert.match(text, /test explanation of the lowest point/);
	assert.match(text, /fixed name/);
	// The type came from paramlist.xml, so the guide's type column is redundant.
	assert.doesNotMatch(text, /\*\*Type:\*\*/);
});

test('a parameter of the library part gets no guide prose unless it is fixed', () => {
	setReferenceRoot(referenceRoot);
	const text = hover('3d.gdl', 'bShowFrame', 'if bShowFrame then addx 1\n');
	assert.match(text ?? '', /\*\*Boolean parameter\*\*/);
});

test('without the GRAPHISOFT extension there is simply no description', () => {
	setReferenceRoot(undefined);
	const text = hover('3d.gdl', 'SYMB_MIRRORED', 'if SYMB_MIRRORED then addx 1\n');
	assert.ok(text, 'the keyword hover must survive a missing reference guide');
	assert.doesNotMatch(text, /test gloss/);
});
