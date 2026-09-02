/**
 * A GDL keyword used as a variable name.
 *
 *     addx = foo + bar        <- `ADDX` is a command; the script will not run
 *     for str = 1 to n
 *     let mod = 4
 *
 * The guide states the rule outright (§ GDL Syntax, Identifiers): *"Identifiers
 * can be GDL keywords, global or local variables or strings (names). Keywords
 * and global variable names are determined by the program you're using GDL in;
 * all other identifiers can be used as variable names."* So the keyword table
 * is exactly the set of names an author may not claim, and this is the mirror
 * of the rename provider refusing a keyword as a new name.
 *
 * Like the doubled operator and the stray bracket, Archicad does not point at
 * the line: the script is refused, and the name reads as a perfectly ordinary
 * assignment until you know that `ADDX` is taken.
 *
 * **Only three of the table's eight kinds are judged** — the set
 * `keywords.ts` keeps as `VARIABLE_NAME_CONFLICTS`. Which ones was decided on
 * the corpus rather than on principle, because the other five are all names
 * real library code assigns to:
 *
 *   - **`statement`, `function` and `operator`** — 459 names, the commands plus
 *     `SIN`/`STR`/`STRSUB`, the word operators `AND`/`OR`/`MOD`/`EXOR`, and the
 *     28 the guide lists under *Reserved Keywords* ("they exist for
 *     compatibility reasons or are not publicized" — `BOX`, `NODE`, `ORIGO`,
 *     `PAUSE`). Not one of the corpus's 151483 assignment targets is any of
 *     them.
 *   - **`global` is not judged**, though it reads like the obvious next kind.
 *     The guide permits it in as many words — *"By using the "=" command, you
 *     can assign a numeric or string value to local and global variables"* —
 *     and `GLOB_USER_1`…`GLOB_USER_20` are documented as "free users' globals",
 *     there to be written. GRAPHISOFT's own ACLib does it for the read-only
 *     ones too: `Simple Door Opening/1d.gdl` swaps `WIDO_LEFT_JAMB` with
 *     `WIDO_RIGHT_JAMB` through a temporary to mirror the reveal. 101 corpus
 *     assignments in all, and none of them a mistake this check could name.
 *   - **`fixparam` is not judged.** Those are the object's own parameters, and
 *     the guide is explicit that *"within a script, the same rules apply to
 *     parameters as to local variables"* — so `A`, `ZZYZX`, `ac_bottomlevel`
 *     and the `ifc_*` outputs are assigned in the ordinary way, 1397 times
 *     across the corpus.
 *   - **`query`, `autotext` and `property` are not identifiers at all**: they
 *     are the string literals `REQUEST` and friends consume, so the name stays
 *     the author's. Real code relies on it — `lightMacro_m` keeps a dictionary
 *     called `story_info`, which is also the question string of
 *     `REQUEST ("STORY_INFO", ...)`, and the two never meet.
 *
 * Where a name may be claimed, and each form was measured:
 *
 *   - **`name = …`**, the shape this exists for, including an indexed or dotted
 *     target (`arr[1] =`, `_d.f[1].gr =`). A dotted name lexes as one token and
 *     only its leading segment is a variable of this script, which is the same
 *     half rename rewrites.
 *   - **`FOR name = 1 TO n`**, which defines the loop variable — 4529 of them.
 *   - **`LET name = …`**, the legacy spelling of an assignment. One in the
 *     corpus (ACLib's `Patch_Template/2d.gdl`), and it costs two lines.
 *   - **Every clause of the statement**, not just its head, so
 *     `IF a THEN addx = 1` is judged. The walk restarts at `THEN`/`ELSE` the
 *     way `groups.ts` and `paramNames.ts` do.
 *
 * `PARAMETERS name = …` is skipped whole: those names address a parameter list
 * — this part's or, after `CALL`, the macro's — and never define a variable.
 * `paramRefs.ts` is what checks them.
 *
 * Reported as a `Warning` rather than an `Error` for the reason
 * `checkScriptContext` gives: `data/keywords.gdl` is an AC27 snapshot, and one
 * spurious entry in it would put a hard error on a legal variable name. Promote
 * both together once the list is trusted.
 *
 * Corpus: 2458 files, 151483 assignment targets, 4529 loop variables, **0
 * reports** and 0 crashes, so — as with `commas.ts`, `operators.ts` and
 * `parens.ts` — `reservedNames.test.ts` carries the entire proof that this
 * still fires. Sweeping the other way accounts for every site left alone:
 * 32839 are the keyword used as the command it is with an `=` further along
 * the clause (`IF a = 1 THEN`, `FOR i = 1 TO n`, `CALL "m" PARAMETERS x = 1`,
 * `addz (a = b) * 0.1`), and 1708 are a target of a kind this does not judge.
 * Nothing else — so there are no misses to explain. Re-run both directions
 * after touching this.
 */

import { Diagnostic, DiagnosticSeverity } from 'vscode-languageserver/node';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { GdlDocument, Statement } from '../gdl/analyzer';
import type { Token } from '../gdl/lexer';
import { keywordKindLabel, reservedForVariables } from '../gdl/keywords';

export const SOURCE = 'gdl';

/**
 * The identifier assigned to at `i`, or undefined when nothing is.
 *
 * The target may carry subscripts and dict members in any order — `gr_out[i]`,
 * `_drods.f[1].gr` — and it is an assignment only when the `=` comes straight
 * after that path. Anything else is a comparison: `=` is both operators in GDL,
 * so `IF pen = 3 THEN` must not read as a claim on `PEN`.
 */
function assignedName(toks: readonly Token[], i: number): Token | undefined {
	const head = toks[i];
	if (head?.type !== 'identifier') return undefined;

	let j = i + 1;
	for (;;) {
		const tok = toks[j];
		if (tok?.type !== 'operator') break;
		if (tok.text === '[') {
			// Skip the whole subscript; it may itself be an indexed expression.
			let depth = 0;
			for (; j < toks.length; j++) {
				const inner = toks[j];
				if (inner.type !== 'operator') continue;
				if (inner.text === '[' || inner.text === '(') depth++;
				else if (inner.text === ']' || inner.text === ')') {
					depth--;
					if (depth === 0) {
						j++;
						break;
					}
				}
			}
			if (depth !== 0) return undefined; // unbalanced — `parens.ts` reports it
			continue;
		}
		// A `.` only ever follows a subscript here; `pt.start` is one token.
		if (tok.text === '.' && toks[j + 1]?.type === 'identifier') {
			j += 2;
			continue;
		}
		break;
	}

	const eq = toks[j];
	return eq?.type === 'operator' && eq.text === '=' ? head : undefined;
}

/** Where each clause of the statement begins: the head, and after every THEN/ELSE. */
function clauseStarts(toks: readonly Token[]): number[] {
	const starts = [0];
	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i];
		if (tok.type !== 'identifier') continue;
		if (tok.lower === 'then' || tok.lower === 'else') starts.push(i + 1);
	}
	return starts;
}

/** Every name this statement claims for a variable. */
function claimedNames(stmt: Statement): Token[] {
	// `PARAMETERS x = 1` addresses a parameter list, not a variable — this
	// part's own, or after `CALL` the macro's. Neither is ours to judge.
	if (stmt.head === 'parameters') return [];

	const toks = stmt.tokens;
	const claimed: Token[] = [];

	for (const start of clauseStarts(toks)) {
		const assigned = assignedName(toks, start);
		if (assigned) {
			claimed.push(assigned);
			continue;
		}
		const word = toks[start];
		if (word?.type !== 'identifier') continue;
		// `FOR i = 1 TO n` defines the loop variable; `LET x = 1` is the legacy
		// spelling of the assignment above.
		if (word.lower === 'for' && toks[start + 1]?.type === 'identifier') {
			claimed.push(toks[start + 1]);
		} else if (word.lower === 'let') {
			const target = assignedName(toks, start + 1);
			if (target) claimed.push(target);
		}
	}

	return claimed;
}

export function provideReservedNameDiagnostics(doc: GdlDocument, td: TextDocument): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const stmt of doc.statements) {
		for (const tok of claimedNames(stmt)) {
			const kw = reservedForVariables(tok.text);
			if (!kw) continue;

			// The guide's own wording for the 28 under *Reserved Keywords*:
			// they are taken without being commands anyone would write.
			const what = kw.reserved ? 'a reserved GDL keyword' : `a GDL ${keywordKindLabel(kw)}`;
			diagnostics.push({
				severity: DiagnosticSeverity.Warning,
				range: { start: td.positionAt(tok.start), end: td.positionAt(tok.end) },
				message: `\`${kw.name}\` is ${what} and cannot be used as a variable name.`,
				source: SOURCE,
			});
		}
	}

	return diagnostics;
}
