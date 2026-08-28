/**
 * Where a parameter may be named by a *string*.
 *
 * Every case here is a shape from the corpus or from the reference guide's
 * syntax line — the point of the module is telling a name from prose, so the
 * counter-examples carry as much of the proof as the positives do.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { analyze } from '../gdl/analyzer';
import { parameterNameSites } from '../gdl/paramNames';

const names = (text: string) =>
	parameterNameSites(analyze('file:///scratch/ui.gdl', text)).map((site) => site.name);

test('VALUES names only its first argument', () => {
	// The comma before the value list is optional, so the name runs straight
	// into a number — and the values are frequently strings themselves.
	assert.deepEqual(names('values "iDetailLevel" 1, 2, 3'), ['iDetailLevel']);
	assert.deepEqual(names('values "matBody" "brick", "timber"'), ['matBody']);
	assert.deepEqual(names('values{2} "bShowFrame" 0, "off", 1, "on"'), ['bShowFrame']);
});

test('LOCK and HIDEPARAMETER name every argument, ALL included', () => {
	assert.deepEqual(names('lock "bShowFrame", "matBody"'), ['bShowFrame', 'matBody']);
	// `ALL` lists exceptions, which are parameter names just the same.
	assert.deepEqual(names('lock all "A", "B"'), ['A', 'B']);
	assert.deepEqual(names('hideparameter "iDetailLevel"'), ['iDetailLevel']);
});

test('a computed name is not a name we can resolve', () => {
	// The guide calls these arguments string *expressions*.
	assert.deepEqual(names('lock "prefix_" + STR(i, 1, 0)'), []);
	assert.deepEqual(names('values "order_" + n 1, 2'), []);
});

test('a UI control names the parameter it edits and nothing else', () => {
	// The later arguments of an infield are a picture name and the cell texts.
	assert.deepEqual(
		names('ui_infield "gs_fill_pen", 10, 20, 100, 20, 2, "pens.png", 4, 1, 20, 20, 16, 16, 1, "solid"'),
		['gs_fill_pen'],
	);
	assert.deepEqual(names('ui_infield{4} "gs_fill_pen", 10, 20, 100, 20'), ['gs_fill_pen']);
	// A tooltip follows the argument list without a comma; its text is prose.
	assert.deepEqual(names('ui_infield "bShowFrame", 10, 20, 100, 20 ui_tooltip "Show it"'), [
		'bShowFrame',
	]);
	// Three at once.
	assert.deepEqual(names('ui_colorpicker "penR", "penG", "penB", 10, 10'), [
		'penR',
		'penG',
		'penB',
	]);
});

test('a list item names its parameter third, after the row and the field', () => {
	assert.deepEqual(names('ui_listitem itemID, fieldID, "gs_cont_pen"'), ['gs_cont_pen']);
	assert.deepEqual(names('ui_custom_popup_listitem 1, 2, "matBody", 0, "", ""'), ['matBody']);
	// An empty name marks a group row of the listfield — 142 in the corpus.
	assert.deepEqual(names('ui_listitem itemID, fieldID, ""'), []);
});

test('a string that merely matches is prose', () => {
	// A caption, a group, a jump target: none of them names a parameter.
	assert.deepEqual(names('ui_outfield "bShowFrame", 10, 10, 100, 20'), []);
	assert.deepEqual(names('ui_dialog "matBody"'), []);
	assert.deepEqual(names('ui_listfield 1, 10, 70, 210, 60'), []);
});

test('each clause of a statement carries its own argument list', () => {
	// `IF a THEN LOCK "x" ELSE LOCK "y"` is one statement holding two commands.
	assert.deepEqual(names('if bShowFrame then lock "matBody" else lock "iDetailLevel"'), [
		'matBody',
		'iDetailLevel',
	]);
	// The condition of the `IF` is not an argument list at all.
	assert.deepEqual(names('if sMode = "matBody" then hideparameter "iDetailLevel"'), [
		'iDetailLevel',
	]);
});
