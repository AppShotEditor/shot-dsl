/**
 * Line breaking by meaning (shot-dsl 0.5.0). The composer never lets Fabric's greedy wrap decide a
 * headline's shape:
 * - an explicit `\n` in the copy is ALWAYS a line break — lines the author broke are never merged;
 * - a line (explicit or not) that doesn't fit the box is broken into the SAME number of lines the
 *   greedy wrap would use, but balanced — minimal raggedness, no single short word stranded on the
 *   last line, breaks preferred after punctuation and never right after a short function word.
 * The chosen breaks are emitted as `\n` in the Textbox text, so the editor shows exactly these lines
 * (each fits the box by the conservative width model, so Fabric never re-wraps them).
 *
 * CJK (and other scripts written without spaces) may break between any two of their characters:
 * such characters are tokens of their own, joined without a space.
 */

/** Width of one line (canvas units) for the font model in use. */
export type LineWidth = (line: string) => number;

/** Words that read badly at the END of a line ("Hear the / word"). */
const WEAK_ENDINGS = new Set([
	'a',
	'an',
	'the',
	'to',
	'of',
	'and',
	'or',
	'for',
	'in',
	'on',
	'at',
	'by',
	'with',
	'your',
	'my',
	'our',
	'their',
	'is',
	'it’s',
	"it's",
	'&'
]);

const PUNCT_END = /[.,:;!?—–)。，、！？]$/;

/**
 * Beyond this many tokens a line is broken greedily (linear) instead of balanced (the balancing DP is
 * O(tokens² · lines)). Real headlines are ≤ ~12 words; this only keeps absurd copy fast — it fails
 * the copy-length rules anyway.
 */
export const MAX_BALANCED_TOKENS = 40;

/** Ideographs, kana, Hangul, fullwidth forms: break anywhere between them; about 1 em wide. */
export function isWideChar(ch: string): boolean {
	const c = ch.codePointAt(0) ?? 0;
	return (
		(c >= 0x1100 && c <= 0x115f) || // Hangul Jamo
		(c >= 0x2e80 && c <= 0x303e) || // CJK radicals, punctuation
		(c >= 0x3041 && c <= 0x33ff) || // kana, CJK symbols
		(c >= 0x3400 && c <= 0x4dbf) || // CJK ext A
		(c >= 0x4e00 && c <= 0x9fff) || // CJK unified
		(c >= 0xa960 && c <= 0xa97f) ||
		(c >= 0xac00 && c <= 0xd7a3) || // Hangul syllables
		(c >= 0xf900 && c <= 0xfaff) ||
		(c >= 0xfe30 && c <= 0xfe4f) ||
		(c >= 0xff00 && c <= 0xff60) || // fullwidth forms
		(c >= 0xffe0 && c <= 0xffe6) ||
		(c >= 0x20000 && c <= 0x3fffd)
	);
}

interface Token {
	text: string;
	/** A space precedes this token when it follows another on the same line. */
	space: boolean;
}

/** Words split at spaces; runs of wide characters split per character (no space between them). */
function tokenize(line: string): Token[] {
	const tokens: Token[] = [];
	for (const word of line.split(/\s+/).filter(Boolean)) {
		let buf = '';
		let first = true;
		const flush = () => {
			if (!buf) return;
			tokens.push({ text: buf, space: first });
			first = false;
			buf = '';
		};
		for (const ch of word) {
			if (isWideChar(ch)) {
				flush();
				tokens.push({ text: ch, space: first });
				first = false;
			} else buf += ch;
		}
		flush();
	}
	return tokens;
}

const join = (tokens: Token[], i: number, j: number) => tokens.slice(i, j).reduce((s, t, k) => s + (k > 0 && t.space ? ' ' : '') + t.text, '');

/** Greedy wrap at token boundaries — the line COUNT to balance to (and the fallback breaking). */
function greedy(tokens: Token[], maxWidth: number, width: LineWidth): Array<[number, number]> {
	const lines: Array<[number, number]> = [];
	let start = 0;
	for (let j = 1; j < tokens.length; j++) {
		if (width(join(tokens, start, j + 1)) > maxWidth) {
			lines.push([start, j]);
			start = j;
		}
	}
	if (tokens.length) lines.push([start, tokens.length]);
	return lines;
}

/**
 * Balanced break of one line into its greedy line count (greedy past MAX_BALANCED_TOKENS). A single
 * token wider than the box stays on its own line (the caller reports it — see `overlongWords`).
 */
function balanceLine(line: string, maxWidth: number, width: LineWidth): string[] {
	const tokens = tokenize(line);
	if (tokens.length === 0) return [''];
	if (width(join(tokens, 0, tokens.length)) <= maxWidth) return [join(tokens, 0, tokens.length)];
	const g = greedy(tokens, maxWidth, width);
	const n = g.length;
	const T = tokens.length;
	if (n === 1 || T > MAX_BALANCED_TOKENS || tokens.some((t) => width(t.text) > maxWidth)) return g.map(([i, j]) => join(tokens, i, j));

	const cost = (i: number, j: number, last: boolean): number => {
		const w = width(join(tokens, i, j));
		if (w > maxWidth) return Infinity;
		const slack = (maxWidth - w) / maxWidth;
		let c = slack * slack;
		const lastWord = tokens[j - 1].text;
		const words = j - i;
		if (!last) {
			if (PUNCT_END.test(lastWord)) c -= 0.12;
			if (WEAK_ENDINGS.has(lastWord.toLowerCase())) c += 0.35;
			// A lone word on an inner line ("See / their progress") reads as stranded too.
			if (words === 1 && T > 2) c += 0.6;
		} else if (words === 1 && T > 1) {
			// A single word alone on the last line (an orphan) — heavily penalised.
			c += 1.2;
		}
		return c;
	};
	// DP over break positions: best[k][j] = min cost of tokens[0..j) in k lines.
	const best: number[][] = Array.from({ length: n + 1 }, () => new Array(T + 1).fill(Infinity));
	const from: number[][] = Array.from({ length: n + 1 }, () => new Array(T + 1).fill(-1));
	best[0][0] = 0;
	for (let k = 1; k <= n; k++) {
		for (let j = k; j <= T; j++) {
			for (let i = k - 1; i < j; i++) {
				if (best[k - 1][i] === Infinity) continue;
				const c = best[k - 1][i] + cost(i, j, k === n && j === T);
				if (c < best[k][j]) {
					best[k][j] = c;
					from[k][j] = i;
				}
			}
		}
	}
	if (best[n][T] === Infinity) return g.map(([i, j]) => join(tokens, i, j));
	const lines: string[] = [];
	for (let k = n, j = T; k > 0; k--) {
		const i = from[k][j];
		lines.unshift(join(tokens, i, j));
		j = i;
	}
	return lines;
}

/**
 * The lines `text` is set in: every explicit `\n` line is kept as written, and only a line that
 * doesn't fit the box is broken (balanced) — never merged with its neighbours.
 */
export function breakLines(text: string, maxWidth: number, width: LineWidth): string[] {
	return text
		.replace(/\r/g, '')
		.split('\n')
		.flatMap((line) => balanceLine(line.trim().replace(/\s+/g, ' '), maxWidth, width));
}

/**
 * Tokens (words, or single wide characters) wider than the box. Fabric's Textbox never breaks inside
 * a word — it widens the box to the longest word, which would overflow the side margin — so the
 * composer rejects such copy with a clear error.
 */
export function overlongWords(text: string, maxWidth: number, width: LineWidth): string[] {
	return tokenize(text.replace(/\n/g, ' ')).filter((t) => width(t.text) > maxWidth).map((t) => t.text);
}

/** True when the LAST line of `lines` is one short word while the block has more than one line. */
export function hasOrphan(lines: string[]): boolean {
	if (lines.length < 2) return false;
	const last = lines[lines.length - 1].trim().split(/\s+/).filter(Boolean);
	const prev = lines[lines.length - 2].trim().split(/\s+/).filter(Boolean);
	return last.length === 1 && [...last[0]].length > 0 && !isWideChar([...last[0]][0]) && prev.length > 1;
}
