import assert from "node:assert/strict";
import test from "node:test";

import {
	parseCompletionPayload,
	insertionBytes,
	candidateLabel,
	completionKind,
	filterCandidates,
	shouldRetrigger,
	isPlainTypingKey,
} from "../src/lib/completions.ts";
import {CurrentCommandParser} from "../src/lib/currentCommand.ts";

const RS = "\x1e";
const US = "\x1f";

test("parseCompletionPayload splits ctx/word and candidate records", () => {
	const payload = ["git" + US + "ch", "checkout" + US + US + "Switch branches", "cherry" + US + US].join(RS);
	const {ctx, word, candidates} = parseCompletionPayload(payload);
	assert.equal(ctx, "git");
	assert.equal(word, "ch");
	assert.equal(candidates.length, 2);
	assert.deepEqual(candidates[0], {
		insert: "checkout",
		label: "",
		description: "Switch branches",
	});
	assert.deepEqual(candidates[1], {insert: "cherry", label: "", description: ""});
});

test("parseCompletionPayload: empty context at command position", () => {
	const payload = [US + "ech", "echo" + US + US].join(RS);
	const {ctx, word, candidates} = parseCompletionPayload(payload);
	assert.equal(ctx, "");
	assert.equal(word, "ech");
	assert.equal(candidates.length, 1);
});

test("parseCompletionPayload keeps zsh label distinct from insert", () => {
	const payload = [US + "--v", "verbose" + US + "--verbose" + US + "Be verbose"].join(RS);
	const {candidates} = parseCompletionPayload(payload);
	assert.equal(candidates[0].insert, "verbose");
	assert.equal(candidates[0].label, "--verbose");
	assert.equal(candidates[0].description, "Be verbose");
});

test("parseCompletionPayload rejoins stray separators inside descriptions", () => {
	// A description that itself contained RS/US is re-joined into the desc
	// field rather than corrupting the record structure.
	const payload = [US + "w", "cand" + US + US + "desc" + US + "tail"].join(RS);
	const {candidates} = parseCompletionPayload(payload);
	assert.equal(candidates[0].description, "desc" + US + "tail");
});

test("parseCompletionPayload drops empty records", () => {
	const payload = [US + "w", "cand" + US + US, "", "other" + US + US].join(RS);
	const {candidates} = parseCompletionPayload(payload);
	assert.deepEqual(candidates.map((c) => c.insert), ["cand", "other"]);
});

test("parseCompletionPayload handles empty payload", () => {
	const {ctx, word, candidates} = parseCompletionPayload("");
	assert.equal(ctx, "");
	assert.equal(word, "");
	assert.equal(candidates.length, 0);
});

test("insertionBytes erases one DEL per code point, not per UTF-16 unit", () => {
	// ASCII: 3 chars → 3 DELs.
	assert.equal(insertionBytes("ech", {insert: "echo", label: "", description: ""}), "\x7f\x7f\x7fecho");
	// CJK: 2 characters (2 code points, 4 UTF-16 units) → 2 DELs.
	assert.equal(insertionBytes("你好", {insert: "你好世界", label: "", description: ""}), "\x7f\x7f你好世界");
	// Emoji with surrogate pair: 1 code point → 1 DEL.
	assert.equal(insertionBytes("🚀", {insert: "🚀🚀", label: "", description: ""}), "\x7f🚀🚀");
	// Empty word (completing at a space): no DELs, insert only.
	assert.equal(insertionBytes("", {insert: "file.txt", label: "", description: ""}), "file.txt");
});

test("candidateLabel falls back to insert when label empty", () => {
	assert.equal(candidateLabel({insert: "git", label: "", description: ""}), "git");
	assert.equal(candidateLabel({insert: "verbose", label: "--verbose", description: ""}), "--verbose");
});

test("completionKind classifies by shape", () => {
	assert.equal(completionKind({insert: "src/", label: "", description: ""}), "folder");
	assert.equal(completionKind({insert: "--verbose", label: "", description: ""}), "option");
	assert.equal(completionKind({insert: "git", label: "", description: "stupid content tracker"}), "command");
	assert.equal(completionKind({insert: "notes.txt", label: "", description: ""}), "file");
});

test("filterCandidates narrows by exact prefix on the insert text", () => {
	const cands = [
		{insert: "vi", label: "", description: ""},
		{insert: "vim", label: "", description: "Vi IMproved"},
		{insert: "vimdiff", label: "", description: ""},
		{insert: "view", label: "", description: ""},
	];
	assert.deepEqual(filterCandidates(cands, "v").map((c) => c.insert), ["vi", "vim", "vimdiff", "view"]);
	assert.deepEqual(filterCandidates(cands, "vi").map((c) => c.insert), ["vi", "vim", "vimdiff", "view"]);
	assert.deepEqual(filterCandidates(cands, "vim").map((c) => c.insert), ["vim", "vimdiff"]);
	assert.deepEqual(filterCandidates(cands, "vimd").map((c) => c.insert), ["vimdiff"]);
	assert.deepEqual(filterCandidates(cands, "vimx"), []);
	// Case-sensitive, like the shells' default file matching.
	assert.deepEqual(filterCandidates(cands, "V"), []);
	// The word itself may already be a full candidate — it still matches.
	assert.deepEqual(filterCandidates(cands, "view").map((c) => c.insert), ["view"]);
});

test("shouldRetrigger only for directory insertions", () => {
	assert.equal(shouldRetrigger({insert: "Documents/", label: "", description: ""}), true);
	assert.equal(shouldRetrigger({insert: "src/nested/", label: "", description: ""}), true);
	assert.equal(shouldRetrigger({insert: "vim", label: "", description: "Vi IMproved"}), false);
	assert.equal(shouldRetrigger({insert: "notes.txt", label: "", description: ""}), false);
});

test("isPlainTypingKey accepts single printable chars without modifiers", () => {
	const plain = {ctrlKey: false, metaKey: false, altKey: false};
	assert.equal(isPlainTypingKey({key: "v", ...plain}), true);
	assert.equal(isPlainTypingKey({key: "I", ...plain}), true);
	assert.equal(isPlainTypingKey({key: ".", ...plain}), true);
	assert.equal(isPlainTypingKey({key: " ", ...plain}), true);
	assert.equal(isPlainTypingKey({key: "Backspace", ...plain}), false);
	assert.equal(isPlainTypingKey({key: "Tab", ...plain}), false);
	assert.equal(isPlainTypingKey({key: "ArrowLeft", ...plain}), false);
	assert.equal(isPlainTypingKey({key: "Process", ...plain}), false); // IME
	assert.equal(isPlainTypingKey({key: "v", ctrlKey: true, metaKey: false, altKey: false}), false);
	assert.equal(isPlainTypingKey({key: "v", ctrlKey: false, metaKey: true, altKey: false}), false);
	assert.equal(isPlainTypingKey({key: "v", ctrlKey: false, metaKey: false, altKey: true}), false);
});

test("CurrentCommandParser emits completions events with RS/US payload intact", () => {
	const parser = new CurrentCommandParser();
	const payload = [US + "gi", "git" + US + US + "tracker"].join(RS);
	const events = parser.feed(`noise\x1b]1337;Completions=${payload}\x07after`);
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "completions");
	assert.equal(events[0].payload, payload);
});

test("CurrentCommandParser accepts ESC-backslash terminator for completions", () => {
	const parser = new CurrentCommandParser();
	const events = parser.feed("\x1b]1337;Completions=\x1fw\x1eab\x1f\x1f\x1b\\");
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "completions");
	assert.equal(events[0].payload, "\x1fw\x1eab\x1f\x1f");
});

test("CurrentCommandParser reassembles a completion split across chunks", () => {
	const parser = new CurrentCommandParser();
	const full = "\x1b]1337;Completions=" + US + "wo" + RS + "word" + US + US + "d\x07";
	const mid = Math.floor(full.length / 2);
	assert.deepEqual(parser.feed(full.slice(0, mid)), []);
	const events = parser.feed(full.slice(mid));
	assert.equal(events.length, 1);
	assert.equal(events[0].type, "completions");
	assert.equal(events[0].payload, US + "wo" + RS + "word" + US + US + "d");
});

test("CurrentCommandParser orders mixed events and keeps current-command parsing intact", () => {
	const parser = new CurrentCommandParser();
	const events = parser.feed(
		"\x1b]1337;CurrentCommand=ls\x07" +
		"\x1b]1337;CurrentCommandExit=0\x07" +
		"\x1b]1337;Completions=" + US + "lu" + RS + "ls" + US + US + "\x07",
	);
	assert.deepEqual(events, [
		{type: "command", value: "ls"},
		{type: "exit", code: 0},
		{type: "completions", payload: US + "lu" + RS + "ls" + US + US},
	]);
});

test("CurrentCommandParser picks the earliest prefix when several are pending", () => {
	const parser = new CurrentCommandParser();
	const events = parser.feed(
		"\x1b]1337;Completions=" + US + "a" + RS + "x" + US + US + "\x07" +
		"\x1b]1337;CurrentCommandExit=1\x07",
	);
	assert.equal(events[0].type, "completions");
	assert.equal(events[1].type, "exit");
	assert.equal(events[1].code, 1);
});
