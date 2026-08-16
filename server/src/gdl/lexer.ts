/**
 * A tolerant tokenizer for GDL.
 *
 * GDL is a BASIC dialect, so the lexical rules differ from C-family languages
 * in ways that matter:
 *
 *   - `!` starts a comment that runs to end of line. There is no block comment.
 *   - Strings come in three flavours: "double quoted", 'single quoted' and
 *     `backtick quoted`. Backticks are used for literals that must survive
 *     localisation; single quotes are the usual way to embed a double quote.
 *     A trailing `\` continues a string onto the next line.
 *   - Numbers may be written in imperial units: `2'`, `6"`, `2'-6"`, `.25"`,
 *     `1'-2 1/2"`. This is why `"` cannot be treated as an unconditional
 *     string delimiter — `ADDZ -.25"` is a number, not an unterminated string.
 *   - A trailing `\` continues a statement on the next line. A trailing `,`
 *     does too — parameter lists routinely span dozens of lines.
 *   - Newlines are significant: they terminate statements.
 *   - Identifiers may be dotted (`DETLEVEL.d3.mvo`) since `DICT` introduced
 *     namespaced constants.
 *   - Keywords are case-insensitive; `IF`, `if` and `If` are the same token.
 *
 * The lexer never throws. Unterminated strings are emitted as tokens flagged
 * `unterminated` so diagnostics can report them precisely.
 */

export type TokenType =
	| 'identifier'
	| 'number'
	| 'string'
	| 'comment'
	| 'operator'
	| 'newline'
	| 'eof';

export interface Token {
	readonly type: TokenType;
	/** Source text exactly as written. */
	readonly text: string;
	/** Lower-cased text, for case-insensitive keyword matching. */
	readonly lower: string;
	readonly start: number;
	readonly end: number;
	/** Set on string tokens that never saw their closing delimiter. */
	readonly unterminated?: boolean;
	/** Quote character for string tokens. */
	readonly quote?: '"' | '`' | "'";
}

const QUOTE_NAMES: Readonly<Record<string, string>> = {
	'"': 'quote',
	'`': 'backtick',
	"'": 'apostrophe',
};

export function quoteName(quote: string | undefined): string {
	return QUOTE_NAMES[quote ?? '"'] ?? 'quote';
}

const OPERATOR_CHARS = new Set('+-*/^=<>()[],:;&|@%#\\');

function isDigit(c: string): boolean {
	return c >= '0' && c <= '9';
}

function isIdentStart(c: string): boolean {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '~';
}

function isIdentPart(c: string): boolean {
	return isIdentStart(c) || isDigit(c);
}

/**
 * If a line terminator starts at `j`, returns the offset just past it;
 * otherwise -1. Handles LF, CRLF and lone CR, so continuation handling works
 * identically in modern and classic-Mac files.
 */
function lineEndAt(text: string, j: number): number {
	if (text[j] === '\n') return j + 1;
	if (text[j] === '\r') return text[j + 1] === '\n' ? j + 2 : j + 1;
	return -1;
}

export function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	const n = text.length;

	const push = (t: Token) => tokens.push(t);

	while (i < n) {
		const c = text[i];

		// Whitespace (but not newline — that is a real token). HSF scripts are
		// written with a UTF-8 BOM, which must not become a token or it would
		// displace the first statement's leading keyword.
		if (c === ' ' || c === '\t' || c === '\uFEFF') {
			i++;
			continue;
		}

		// Line terminators. Older library parts still carry classic-Mac CR-only
		// endings; treating a lone CR as whitespace would collapse the whole
		// file onto one line and make every `!` comment swallow the rest of it.
		if (c === '\n' || c === '\r') {
			const isCrLf = c === '\r' && text[i + 1] === '\n';
			const end = isCrLf ? i + 2 : i + 1;
			push({ type: 'newline', text: text.slice(i, end), lower: '\n', start: i, end });
			i = end;
			continue;
		}

		// Comment: `!` to end of line.
		if (c === '!') {
			const start = i;
			while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
			const raw = text.slice(start, i);
			push({ type: 'comment', text: raw, lower: raw.toLowerCase(), start, end: i });
			continue;
		}

		// Strings. No escape sequences in GDL — a doubled delimiter is the way
		// to embed one. A `'` reaching this point is a delimiter rather than a
		// foot marker, because the number scanner claims imperial `'` first.
		if (c === '"' || c === '`' || c === "'") {
			const quote = c as '"' | '`' | "'";
			const start = i;
			i++;
			let unterminated = false;
			for (;;) {
				if (i >= n || text[i] === '\n' || text[i] === '\r') {
					unterminated = true;
					break;
				}
				// A `\` just before the newline continues the string; long UI
				// labels are routinely wrapped this way.
				if (text[i] === '\\') {
					let j = i + 1;
					while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;
					const afterEol = lineEndAt(text, j);
					if (afterEol !== -1) {
						i = afterEol;
						continue;
					}
				}
				if (text[i] === quote) {
					// Doubled quote is an escaped quote, not a terminator.
					if (text[i + 1] === quote) {
						i += 2;
						continue;
					}
					i++;
					break;
				}
				i++;
			}
			const raw = text.slice(start, i);
			push({
				type: 'string',
				text: raw,
				lower: raw.toLowerCase(),
				start,
				end: i,
				quote,
				...(unterminated ? { unterminated: true } : {}),
			});
			continue;
		}

		// Numbers, including `.5`, exponent forms and imperial units.
		if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
			const start = i;
			const scanDigits = () => {
				while (i < n && isDigit(text[i])) i++;
				if (text[i] === '.') {
					i++;
					while (i < n && isDigit(text[i])) i++;
				}
			};

			scanDigits();

			if (text[i] === 'e' || text[i] === 'E') {
				const save = i;
				i++;
				if (text[i] === '+' || text[i] === '-') i++;
				if (isDigit(text[i])) {
					while (i < n && isDigit(text[i])) i++;
				} else {
					i = save; // Not an exponent after all.
				}
			}

			// Imperial notation. The markers must sit flush against the digits,
			// so `5 "text"` is still a number followed by a string.
			if (text[i] === "'") {
				i++; // feet
				const save = i;
				if (text[i] === '-') i++;
				// Optional inches, optionally as a `1/2` fraction.
				while (text[i] === ' ') i++;
				if (isDigit(text[i])) {
					scanDigits();
					const fracSave = i;
					while (text[i] === ' ') i++;
					if (isDigit(text[i])) {
						scanDigits();
						if (text[i] === '/') {
							i++;
							scanDigits();
						} else {
							i = fracSave;
						}
					} else {
						i = fracSave;
					}
					if (text[i] === '"') i++;
				} else {
					i = save; // Bare feet, e.g. `2'`.
				}
			} else {
				// Inches, with or without a fraction and with no feet part:
				// `6"`, `3/4"`, `24 3/4"`. Only commit when the closing `"` is
				// actually there, so `a = 3/4` stays ordinary division and
				// `text2 5, "hi"` stays a number beside a string.
				const save = i;
				let j = i;

				let k = j;
				while (text[k] === ' ') k++;
				if (isDigit(text[k])) {
					let m = k;
					while (m < n && isDigit(text[m])) m++;
					if (text[m] === '/') {
						m++;
						if (isDigit(text[m])) {
							while (m < n && isDigit(text[m])) m++;
							j = m;
						}
					}
				}

				// A fraction hanging directly off the leading number: `3/4"`.
				if (j === i && text[j] === '/') {
					let m = j + 1;
					if (isDigit(text[m])) {
						while (m < n && isDigit(text[m])) m++;
						j = m;
					}
				}

				if (text[j] === '"') i = j + 1;
				else if (text[i] === '"') i++;
				else i = save;
			}

			const raw = text.slice(start, i);
			push({ type: 'number', text: raw, lower: raw.toLowerCase(), start, end: i });
			continue;
		}

		// Identifiers, possibly dotted, possibly with a `{2}` variant suffix.
		if (isIdentStart(c)) {
			const start = i;
			while (i < n && isIdentPart(text[i])) i++;
			// Dotted continuation: `DETLEVEL.d3.mvo`
			while (text[i] === '.' && isIdentStart(text[i + 1])) {
				i++;
				while (i < n && isIdentPart(text[i])) i++;
			}
			// Variant suffix: `CPRISM_{2}`
			if (text[i] === '{') {
				const save = i;
				i++;
				while (i < n && isDigit(text[i])) i++;
				if (text[i] === '}' && i > save + 1) i++;
				else i = save;
			}
			const raw = text.slice(start, i);
			push({ type: 'identifier', text: raw, lower: raw.toLowerCase(), start, end: i });
			continue;
		}

		// Line continuation: a backslash immediately before the newline joins
		// the lines, so neither it nor the newline become tokens.
		if (c === '\\') {
			let j = i + 1;
			while (j < n && (text[j] === ' ' || text[j] === '\t')) j++;

			// A trailing comment may sit between the `\` and the newline:
			//     if a = 3 |\    ! CHE display standards
			let commentStart = -1;
			if (j < n && text[j] === '!') {
				commentStart = j;
				while (j < n && text[j] !== '\n' && text[j] !== '\r') j++;
			}

			const afterEol = lineEndAt(text, j);
			if (afterEol !== -1) {
				if (commentStart !== -1) {
					const raw = text.slice(commentStart, j);
					push({
						type: 'comment',
						text: raw,
						lower: raw.toLowerCase(),
						start: commentStart,
						end: j,
					});
				}
				i = afterEol;
				// Blank lines after a continuation do not end the statement.
				// Multi-line conditions are routinely written as
				//     if a | \
				//        b  \
				//                    <- blank
				//     then
				// and Archicad accepts it, so we must too.
				//
				// Neither do comment lines. A comment is a no-op to Archicad's
				// parser, which is what makes commenting out one line of a
				// continued expression safe — a very common edit:
				//
				//     bNor = (iThresholdType = TRESHOLD_FLAT   | \
				//             !iThresholdType = TRESHOLD_HEVE  | \
				//             iThresholdType = TRESHOLD_BRANN)
				//
				// The `\` inside that comment is doing nothing; it is the
				// continuation from the line above that survives the line. Note
				// the asymmetry — a comment can never *start* a continuation, or
				// the whole statements that library code comments out line by
				// line would each swallow the next live statement.
				for (;;) {
					let k = i;
					while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;

					let commentAt = -1;
					if (text[k] === '!') {
						commentAt = k;
						while (k < n && text[k] !== '\n' && text[k] !== '\r') k++;
					}

					const next = lineEndAt(text, k);
					if (next === -1) break;
					if (commentAt !== -1) {
						const raw = text.slice(commentAt, k);
						push({
							type: 'comment',
							text: raw,
							lower: raw.toLowerCase(),
							start: commentAt,
							end: k,
						});
					}
					i = next;
				}
				continue;
			}
		}

		if (OPERATOR_CHARS.has(c)) {
			const start = i;
			// Two-character operators.
			const two = text.slice(i, i + 2);
			if (two === '<=' || two === '>=' || two === '<>' || two === '**') i += 2;
			else i += 1;
			const raw = text.slice(start, i);
			push({ type: 'operator', text: raw, lower: raw, start, end: i });
			continue;
		}

		// Anything else: emit as a single-character operator so offsets stay
		// aligned. Diagnostics can flag it if it matters.
		push({ type: 'operator', text: c, lower: c, start: i, end: i + 1 });
		i++;
	}

	push({ type: 'eof', text: '', lower: '', start: n, end: n });
	return tokens;
}

/** Tokens that carry meaning for parsing — comments and blank lines removed. */
export function significant(tokens: readonly Token[]): Token[] {
	return tokens.filter((t) => t.type !== 'comment');
}
