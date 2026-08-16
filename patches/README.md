# Vendored dependency patches

## `@xterm__xterm@6.0.0.patch`

Backports two upstream xterm.js IME fixes onto the stable `@xterm/xterm@6.0.0`
bundle. Required by the WebKitGTK duplicate-IME-input fix
(`src/lib/imeCompositionGuard.ts`); see the PR that added this patch for the
full analysis.

Only `lib/xterm.mjs` (the ESM entry Vite bundles) is patched. `lib/xterm.js`
(CJS) is left untouched — nothing in this repo resolves the `main` entry.

The patch file is large (~320 KB) because the published bundle is minified
onto a handful of very long lines, so a one-line change embeds the whole line.
The semantic diff is small and shown below. `pnpm install` verifies the patch
applies cleanly and fails otherwise, so a drifted patch cannot slip through
CI silently.

### What it backports

| Upstream | First released in | What it fixes |
|---|---|---|
| [xterm.js #5439](https://github.com/xtermjs/xterm.js/pull/5439) | 6.1.0-beta.40 | `_handleAnyTextareaChanges` schedules one fallback timer per keydown-229; rapid IME commits fire stale timers and double-send input. Adds `_textareaChangeTimer` dedupe. |
| [xterm.js #5698](https://github.com/xtermjs/xterm.js/pull/5698) | 6.1.0-beta.190 | Matched compositions on a textarea with trailing text re-send that trailing text. `compositionstart` now records the selection range plus `_compositionSuffix`, and `_finalizeComposition` trims it. |

Neither fix will ship in a 6.0.x release (no patch line exists; both are
milestoned for the next major), which is why they are vendored here instead of
waiting for a stable version.

Source-level diff being applied (upstream TypeScript, for review — the actual
patch targets the minified `lib/xterm.mjs`):

```ts
 // CompositionHelper constructor
 this._compositionPosition = { start: 0, end: 0 };
+this._compositionSuffix = '';
 this._dataAlreadySent = '';
+this._textareaChangeTimer = undefined;

 // compositionstart()
 this._isComposing = true;
-this._compositionPosition.start = this._textarea.value.length;
+const start = this._textarea.selectionStart ?? this._textarea.value.length;
+const end = this._textarea.selectionEnd ?? start;
+this._compositionPosition.start = Math.min(start, end);
+this._compositionPosition.end = Math.max(start, end);
+this._compositionSuffix = this._textarea.value.substring(this._compositionPosition.end);

 // compositionupdate()
 setTimeout(() => {
-  this._compositionPosition.end = this._textarea.value.length;
+  const end = this._textarea.selectionEnd ?? this._textarea.value.length;
+  this._compositionPosition.end = Math.max(this._compositionPosition.start, end);
 }, 0);

 // _finalizeComposition(true) — capture the suffix snapshot alongside the position snapshot
 const currentCompositionPosition = { start: ..., end: ... };
+const currentCompositionSuffix = this._compositionSuffix;
 ...
 } else {
-  input = this._textarea.value.substring(currentCompositionPosition.start);
+  const value = this._textarea.value;
+  const valueEnd = currentCompositionSuffix.length > 0 && value.endsWith(currentCompositionSuffix)
+    ? value.length - currentCompositionSuffix.length
+    : value.length;
+  input = value.substring(currentCompositionPosition.start, Math.max(currentCompositionPosition.start, valueEnd));
 }

 // _handleAnyTextareaChanges()
 private _handleAnyTextareaChanges(): void {
+  if (this._textareaChangeTimer) {
+    return;
+  }
   const oldValue = this._textarea.value;
-  setTimeout(() => {
+  this._textareaChangeTimer = window.setTimeout(() => {
+    this._textareaChangeTimer = undefined;
     ...
   }, 0);
 }
```

### Maintaining / removing

- To change it: `pnpm patch @xterm/xterm@6.0.0`, edit `lib/xterm.mjs`,
  `pnpm patch-commit <dir>`.
- To remove: delete this file and the `patchedDependencies` entry in
  `pnpm-workspace.yaml`, then `pnpm install` to refresh the lockfile.
- Removal condition: the first **stable** `@xterm/xterm` release that contains
  both #5439 and #5698 (i.e. any stable release after 6.0.0). At that point
  bump the dependency and drop this patch.
