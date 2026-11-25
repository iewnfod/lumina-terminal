import type {TerminalPadding, TerminalRenderOptions} from "../types/terminal.ts";
import type EnUsTrans from "../../translations/en-us.json";

/**
 * Render-option field schema + pure helpers — the shared logic under the two
 * settings forms that edit `TerminalRenderOptions`: the Global Profile page's
 * full form (components/settings/RenderSettings.tsx) and each profile's
 * additive override list (components/settings/ProfileRenderOverrides.tsx).
 *
 * Inheritance is already the data model: a render key that is `undefined` on
 * a profile falls through to `globalProfile`, then to the built-in default
 * (lib/term.ts parseProfile). This module makes that explicit for the UI:
 *  - `RENDER_FIELDS` is the one list of render fields the settings expose
 *    (order, kind, labels, options, built-in defaults) — add a field here and
 *    both forms pick it up;
 *  - `listRenderOverrides` / `inheritedRenderValue` / `initialOverrideValue`
 *    drive the profile page's "only what this profile overrides" list;
 *  - `formatRenderValue` renders a value for the "Global: …" hints and
 *    `parseNumberInput` is the number fields' text → value parsing;
 *  - `withRenderValue` is the type-safe single-key update both forms commit
 *    through (`undefined` removes the override).
 *
 * Imports here are TYPE-only (no runtime internal imports), so `node --test`
 * loads this module directly — see tests/renderOptions.test.mjs.
 */

/** Keys of the translation table. en-us is the canonical set (zh-cn is typed
 *  against it by hooks/i18n.tsx), so a schema label that misses a translation
 *  fails the build instead of surfacing as a raw key in the UI. */
export type TranslationKey = keyof typeof EnUsTrans;

/** Any value a render field can hold. */
export type RenderValue = string | number | boolean | TerminalPadding;

export interface NumberRenderField {
    kind: "number";
    key: "rows" | "cols" | "padding" | "scrollback" | "fontSize";
    labelKey: TranslationKey;
    /** `min` of the input; typed values are clamped here. */
    min: number;
    /** Built-in value used when neither the profile nor the global profile
     *  sets the key (xterm.js defaults; rows/cols as in
     *  lib/terminalGeometry.ts). Omitted when the key has no default. */
    fallback?: number;
}

export interface TextRenderField {
    kind: "text";
    key: "fontFamily" | "themePath";
    labelKey: TranslationKey;
    /** Sample text for an empty input (not translated — font/theme syntax). */
    placeholder?: string;
}

export interface SelectRenderField {
    kind: "select";
    key: "fontWeight" | "fontStyle" | "cursorStyle";
    labelKey: TranslationKey;
    /** Option ids, in menu order. */
    options: readonly string[];
    /** Built-in value while the key is unset; also what an unselected
     *  trigger shows. */
    fallback: string;
    /** Translation key per option for the enum-like selects. Options
     *  without an entry are shown as-is (the font weights). */
    optionLabelKeys?: Readonly<Partial<Record<string, TranslationKey>>>;
}

export interface ToggleRenderField {
    kind: "toggle";
    key: "cursorBlink" | "webgl" | "graphemeClusters" | "ligatures";
    labelKey: TranslationKey;
    descriptionKey?: TranslationKey;
    fallback: boolean;
}

export type RenderField = NumberRenderField | TextRenderField | SelectRenderField | ToggleRenderField;

/** The render keys the settings UI exposes. Other xterm.js passthrough
 *  options stay config-file-only (they are preserved on save, never shown). */
export type RenderFieldKey = RenderField["key"];

const FONT_WEIGHT_OPTIONS = ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"] as const;
const CURSOR_STYLE_OPTIONS = ["block", "underline", "bar"] as const;

/** Every render field the settings expose, in display order. */
export const RENDER_FIELDS: readonly RenderField[] = [
    {kind: "number", key: "rows", labelKey: "Rows", min: 1, fallback: 24},
    {kind: "number", key: "cols", labelKey: "Columns", min: 1, fallback: 80},
    // The effective default is 0 before lib/term.ts's content-safe floor.
    {kind: "number", key: "padding", labelKey: "Padding", min: 0, fallback: 0},
    {kind: "number", key: "scrollback", labelKey: "Scrollback", min: 0, fallback: 1000},
    {kind: "text", key: "fontFamily", labelKey: "Font Family", placeholder: "e.g. JetBrains Mono"},
    {kind: "number", key: "fontSize", labelKey: "Font Size", min: 1, fallback: 15},
    {kind: "select", key: "fontWeight", labelKey: "Font Weight", options: FONT_WEIGHT_OPTIONS, fallback: "normal"},
    {
        kind: "select",
        key: "fontStyle",
        labelKey: "Font Style",
        options: ["normal", "italic"],
        fallback: "normal",
        optionLabelKeys: {normal: "Normal", italic: "Italic"},
    },
    {
        kind: "select",
        key: "cursorStyle",
        labelKey: "Cursor Style",
        options: CURSOR_STYLE_OPTIONS,
        fallback: "block",
        optionLabelKeys: {block: "cursor_block", underline: "cursor_underline", bar: "cursor_bar"},
    },
    {kind: "toggle", key: "cursorBlink", labelKey: "Cursor Blink", fallback: false},
    {kind: "text", key: "themePath", labelKey: "Theme Path", placeholder: "e.g. themes/my-theme.json"},
    {kind: "toggle", key: "webgl", labelKey: "WebGL Renderer", descriptionKey: "webgl description", fallback: false},
    {
        kind: "toggle",
        key: "graphemeClusters",
        labelKey: "Grapheme Clusters",
        descriptionKey: "grapheme clusters description",
        fallback: false,
    },
    {kind: "toggle", key: "ligatures", labelKey: "Ligatures", descriptionKey: "ligatures description", fallback: false},
];

const FIELD_BY_KEY = new Map(RENDER_FIELDS.map((field) => [field.key, field] as const));

export function renderField<K extends RenderFieldKey>(key: K): Extract<RenderField, {key: K}> {
    // The key union is derived from RENDER_FIELDS, so a miss is a type error.
    return FIELD_BY_KEY.get(key) as Extract<RenderField, {key: K}>;
}

/** Translation key for a select option, or null when the option is shown as-is. */
export function optionLabelKey(field: RenderField, option: string): TranslationKey | null {
    if (field.kind !== "select") return null;
    return field.optionLabelKeys?.[option] ?? null;
}

/** The fields `options` sets explicitly — the overrides of the global
 *  profile — in display order. `undefined` means inherit and is skipped;
 *  `false` and `""` are values and count. */
export function listRenderOverrides(options: TerminalRenderOptions | undefined): RenderField[] {
    if (!options) return [];
    return RENDER_FIELDS.filter((field) => options[field.key] !== undefined);
}

/** What a profile inherits for a key when it does not override it: the global
 *  profile's own value, else the field's built-in default. `undefined` when
 *  neither is set (font family, theme path). */
export function inheritedRenderValue(key: RenderFieldKey, globalProfile?: TerminalRenderOptions): RenderValue | undefined {
    const global = globalProfile?.[key];
    if (global !== undefined) return global as RenderValue;
    const field = renderField(key);
    return field.kind === "number" || field.kind === "select" || field.kind === "toggle" ? field.fallback : undefined;
}

/** The value a freshly added override row starts from. Numbers, texts and
 *  selects start at the value in effect right now (edit it into what the user
 *  wants); toggles start at the OPPOSITE of it — adding an override means
 *  "differ from global", so one click already gets there. */
export function initialOverrideValue(key: RenderFieldKey, globalProfile?: TerminalRenderOptions): RenderValue {
    const inherited = inheritedRenderValue(key, globalProfile);
    const field = renderField(key);
    switch (field.kind) {
        case "toggle":
            return inherited !== true;
        case "number":
            return typeof inherited === "number" ? inherited : field.fallback ?? field.min;
        case "select":
            return typeof inherited === "string" && field.options.includes(inherited) ? inherited : field.fallback;
        case "text":
            return typeof inherited === "string" ? inherited : "";
    }
}

/** Words `formatRenderValue` needs from the caller (the settings UI passes
 *  the translated strings; the pure module stays i18n-free). */
export interface RenderValueLabels {
    unset: string;
    on: string;
    off: string;
    /** Localizes a select option; omitted → options show as their raw ids. */
    option?: (option: string) => string;
}

type PaddingSides = Exclude<TerminalPadding, number>;
const PADDING_SIDES: readonly (keyof PaddingSides)[] = ["x", "y", "left", "right", "top", "bottom"];

/** The per-side padding form (`padding = {x = 12, y = 8}` in config.toml) as
 *  `x: 12, y: 8` — only the sides that are set, in a fixed order. */
export function formatPaddingObject(padding: PaddingSides): string {
    return PADDING_SIDES
        .filter((side) => padding[side] !== undefined)
        .map((side) => `${side}: ${padding[side]}`)
        .join(", ");
}

/** A render value for the "Global: …" hints. */
export function formatRenderValue(value: RenderValue | undefined, labels: RenderValueLabels): string {
    if (value === undefined) return labels.unset;
    if (typeof value === "boolean") return value ? labels.on : labels.off;
    if (typeof value === "number") return String(value);
    if (typeof value === "string") return labels.option ? labels.option(value) : value;
    return formatPaddingObject(value);
}

/** Number-input text → field value: empty or non-numeric text means "unset"
 *  (inherit); anything else is clamped to the field's `min`. */
export function parseNumberInput(text: string, min: number): number | undefined {
    if (text.trim() === "") return undefined;
    const value = Number(text);
    return Number.isFinite(value) ? Math.max(min, value) : undefined;
}

/** `options` with one render field replaced. `undefined` removes the key's
 *  override, so the profile inherits it again. */
export function withRenderValue<T extends TerminalRenderOptions>(
    options: T,
    key: RenderFieldKey,
    value: RenderValue | undefined,
): T {
    return {...options, [key]: value};
}
