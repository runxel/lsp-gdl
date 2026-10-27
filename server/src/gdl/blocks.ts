/**
 * Which statements open and close GDL's blocks.
 *
 * One account of it, read by the unbalanced-block diagnostic and by folding.
 * A rule that changes here changes in both, which is the point: a block the
 * diagnostic thinks is closed and folding thinks is open would be two answers
 * to one question.
 */

import type { Statement } from './analyzer';

/**
 * Block labels, with the statement that terminates each.
 *
 * GDL has two distinct loop forms that both spell `WHILE`:
 *
 *     WHILE condition DO ... ENDWHILE     pre-tested
 *     DO ... WHILE condition              post-tested
 *
 * so `WHILE` opens a block when it ends in `DO` and closes one otherwise.
 */
export const BLOCK_CLOSERS: Readonly<Record<string, string>> = {
	IF: 'ENDIF',
	FOR: 'NEXT',
	WHILE: 'ENDWHILE',
	DO: 'WHILE',
	REPEAT: 'UNTIL',
	GROUP: 'ENDGROUP',
	PARAGRAPH: 'ENDPARAGRAPH',
};

/** Which block, if any, a statement closes. */
const CLOSES: Readonly<Record<string, string>> = {
	endif: 'IF',
	next: 'FOR',
	endwhile: 'WHILE',
	until: 'REPEAT',
	endgroup: 'GROUP',
	endparagraph: 'PARAGRAPH',
};

function lastToken(stmt: Statement) {
	return stmt.tokens[stmt.tokens.length - 1];
}

/** The block this statement opens, or undefined. */
export function opensBlock(stmt: Statement): string | undefined {
	switch (stmt.head) {
		// `IF cond THEN stmt` is complete and needs no ENDIF. A block opens
		// when the line ends on `THEN` — or on `ELSE`, which is how the
		// chained form is written:
		//     IF a THEN x = 1 ELSE
		//         IF b THEN y = 2 ELSE
		//             z = 3
		//         ENDIF
		//     ENDIF
		//
		// A `THEN` heading its own statement is the second half of an `IF` whose
		// `\` went missing — `checkMissingContinuations` reports that — and
		// counts as the opener here, so its `ENDIF` is not blamed as well.
		case 'if':
		case 'then': {
			const last = lastToken(stmt)?.lower;
			return last === 'then' || last === 'else' ? 'IF' : undefined;
		}
		// `WHILE cond DO` opens; a bare `WHILE cond` closes a DO.
		case 'while':
			return lastToken(stmt)?.lower === 'do' ? 'WHILE' : undefined;
		// `DO` stands alone on its line.
		case 'do':
			return stmt.tokens.length === 1 ? 'DO' : undefined;
		case 'for':
			return 'FOR';
		case 'repeat':
			return 'REPEAT';
		case 'group':
			return 'GROUP';
		case 'paragraph':
			return 'PARAGRAPH';
		default:
			return undefined;
	}
}

/** The block this statement closes, or undefined. */
export function closesBlock(stmt: Statement): string | undefined {
	if (stmt.head === 'while') {
		return lastToken(stmt)?.lower === 'do' ? undefined : 'DO';
	}
	return CLOSES[stmt.head ?? ''];
}
