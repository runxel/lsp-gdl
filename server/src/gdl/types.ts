/**
 * GDL's type system, as far as a static checker can see it.
 *
 * The reference guide (§ Simple Types) puts it plainly: *"Variables, parameters
 * and expressions can be of two simple types: numeric or string"*, and a
 * numeric expression *"being an integer or a real is determined during the
 * compilation process and depends only on the constants, variables, parameters
 * and the operations used to combine them."* So int/float is statically
 * inferable, which is exactly what we do here.
 *
 * Everything a library part can hold collapses to four things:
 *
 *   int     integers; booleans, pen indices and attribute indices are integers
 *   float   reals
 *   string  text
 *   dict    a dictionary (Archicad 23+), which nests keys and arrays
 *
 * `unknown` is the fifth, essential state: we refuse to guess. Every check in
 * `providers/typecheck.ts` stays silent when either side is unknown, because a
 * false positive in a 3000-line script costs far more than a missed warning.
 */

import type { GdlParameter } from './libpart';

export type GdlType = 'int' | 'float' | 'string' | 'dict' | 'unknown';

export function isNumeric(t: GdlType): boolean {
	return t === 'int' || t === 'float';
}

/** True when the two types differ across the numeric/string divide. */
export function isKindMismatch(a: GdlType, b: GdlType): boolean {
	if (a === 'unknown' || b === 'unknown') return false;
	if (isNumeric(a) && isNumeric(b)) return false;
	return a !== b;
}

export function typeLabel(t: GdlType): string {
	switch (t) {
		case 'int':
			return 'Integer';
		case 'float':
			return 'Floating-point';
		case 'string':
			return 'String';
		case 'dict':
			return 'Dictionary';
		default:
			return 'unknown';
	}
}

/**
 * Maps a parameter's declared type in `paramlist.xml` onto a GDL type.
 *
 * Attribute references (surfaces, fills, line types, profiles) and booleans are
 * all integer indices at runtime, so an Integer-typed parameter must not be
 * handed a real.
 */
export function parameterType(param: GdlParameter): GdlType {
	switch (param.type) {
		case 'Integer':
		case 'Boolean':
		case 'PenColour':
		case 'PenColor':
		case 'LineType':
		case 'FillPattern':
		case 'Material':
		case 'BuildingMaterial':
		case 'Profile':
		case 'LightSwitch':
			return 'int';

		case 'Length':
		case 'Angle':
		case 'RealNum':
		case 'Intensity':
		case 'ColorRGB':
			return 'float';

		case 'String':
			return 'string';

		case 'Dictionary':
			return 'dict';

		// Separator / Title carry no value.
		default:
			return 'unknown';
	}
}

/**
 * Return types of GDL's built-in functions.
 *
 * `'propagate'` means the result takes the type of the arguments — `ABS(-2)` is
 * an integer while `ABS(-2.5)` is a real.
 */
export const FUNCTION_TYPES: Readonly<Record<string, GdlType | 'propagate'>> = {
	// Arithmetical
	abs: 'propagate',
	min: 'propagate',
	max: 'propagate',
	ceil: 'int',
	int: 'int',
	round_int: 'int',
	sgn: 'int',
	fra: 'float',
	sqr: 'float',

	// Circular / transcendental
	acs: 'float',
	asn: 'float',
	atn: 'float',
	cos: 'float',
	sin: 'float',
	tan: 'float',
	exp: 'float',
	lgt: 'float',
	log: 'float',

	// Boolean / statistical / bit
	not: 'int',
	rnd: 'float',
	bittest: 'int',
	bitset: 'int',

	// Special — all report a success/count code
	req: 'int',
	request: 'int',
	application_query: 'int',
	libraryglobal: 'int',
	ind: 'int',
	vardim1: 'int',
	vardim2: 'int',
	haskey: 'int',
	removekey: 'int',

	// String
	str: 'string',
	strsub: 'string',
	strtoupper: 'string',
	strtolower: 'string',
	strlen: 'int',
	strstr: 'int',
	split: 'int',
	stw: 'float',
};

/** Resolves a function name, tolerating `{2}` style variants. */
export function functionReturnType(name: string): GdlType | 'propagate' | undefined {
	const lower = name.toLowerCase();
	return FUNCTION_TYPES[lower] ?? FUNCTION_TYPES[lower.replace(/\{\d+\}$/, '')];
}

/**
 * Classifies a numeric literal.
 *
 * Imperial literals (`2'`, `6"`, `2'-6"`) are reals: Archicad converts them to
 * metres, which is never an integer count.
 */
export function numberLiteralType(text: string): GdlType {
	if (/[.eE'"]/.test(text)) return 'float';
	return 'int';
}
