/**
 * The keyword table's taxonomy.
 *
 * The generator follows the vendored list's sections, and the list files
 * value-yielding names under command sections — `GET()` next to `PUT`,
 * `ADDGROUP()` under 3D, `STORED_PAR_VALUE()` under migration. Each case here
 * is a name that some check took for a command until the kind was corrected.
 */

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { lookup, lookupWithVariants } from '../gdl/keywords';

test('a name the list spells with a call is a function, indexed without it', () => {
	// Parameter buffer reads — the shape behind `poly2_b … get(nsp)`.
	assert.equal(lookup('get')?.kind, 'function');
	assert.equal(lookup('get')?.name, 'GET');
	assert.equal(lookup('get()'), undefined);
	// Filed under i/o, communication, migration, memory and 3D respectively.
	assert.equal(lookup('open')?.kind, 'function');
	assert.equal(lookup('request')?.kind, 'function');
	assert.equal(lookupWithVariants('request{2}')?.kind, 'function');
	assert.equal(lookup('stored_par_value')?.kind, 'function');
	assert.equal(lookup('vardim1')?.kind, 'function');
	assert.equal(lookup('addgroup')?.kind, 'function');
	// `IND(MATERIAL, "ez")` and six siblings collapse to one function.
	assert.equal(lookup('ind')?.kind, 'function');
	assert.equal(lookup('ind')?.name, 'IND');
});

test('the section still decides where a function is valid', () => {
	assert.deepEqual([...(lookup('stored_par_value')?.scripts ?? [])].sort(), ['bwm', 'fwm']);
	assert.deepEqual([...(lookup('addgroup')?.scripts ?? [])], ['3d']);
});

test('the bare-spelt values are overridden by name', () => {
	assert.equal(lookup('nsp')?.kind, 'function');
	assert.equal(lookup('use')?.kind, 'function');
	assert.equal(lookup('pi')?.kind, 'function');
	// ...while their neighbours in the same section stay commands.
	assert.equal(lookup('put')?.kind, 'statement');
	assert.equal(lookup('print')?.kind, 'statement');
	assert.equal(lookup('output')?.kind, 'statement');
	assert.equal(lookup('prepareFunction')?.kind, 'statement');
});
