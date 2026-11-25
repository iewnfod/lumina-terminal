import {useMemo, useState} from "react";
import {Button, Label, ListBox, Select} from "@heroui/react";
import {Plus, RotateCcw} from "lucide-react";
import {TerminalRenderOptions} from "../../types/terminal.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {
    RENDER_FIELDS,
    formatRenderValue,
    inheritedRenderValue,
    initialOverrideValue,
    listRenderOverrides,
    optionLabelKey,
    type RenderField,
    type RenderFieldKey,
    type RenderValue,
} from "../../lib/renderOptions.ts";
import RenderFieldControl from "./RenderFieldControl.tsx";
import {ThemePathPreview} from "../ThemePreview.tsx";
import SectionTitle from "../ui/SectionTitle.tsx";

/** Value of the add-row select while nothing is picked — matches no item,
 *  so the trigger just shows its placeholder (same convention as
 *  BindingsSettings). */
const NO_SELECTION = "__none__";

export interface ProfileRenderOverridesProps {
    /** The profile draft — the render keys it sets are the rows. */
    draft: TerminalRenderOptions;
    /** Replaces one render field; `undefined` removes the override. */
    setRenderValue: (key: RenderFieldKey, value: RenderValue | undefined) => void;
    /** The global profile unlisted settings inherit from — the source of the
     *  "Global: …" hints. */
    globalProfile?: TerminalRenderOptions;
    borderColor: string;
}

/** A profile's render settings as an ADDITIVE list, the way the keyboard
 *  shortcuts page works: the page lists only what this profile overrides,
 *  the user adds a setting when they want it to differ from the global
 *  profile, and every row offers "Use Global Setting" explicitly (selects
 *  also as their first menu item) instead of leaving "inherit" implied by
 *  an empty-looking field. Removing the override returns the setting to the
 *  add menu; nothing is written to config.toml until Save. */
export default function ProfileRenderOverrides({
    draft,
    setRenderValue,
    globalProfile,
    borderColor,
}: ProfileRenderOverridesProps) {
    const t = useI18n();
    const [pending, setPending] = useState<RenderFieldKey | typeof NO_SELECTION>(NO_SELECTION);

    const overridden = useMemo(() => listRenderOverrides(draft), [draft]);
    const overriddenKeys = useMemo(() => new Set(overridden.map((field) => field.key)), [overridden]);
    const available = useMemo(() => RENDER_FIELDS.filter((field) => !overriddenKeys.has(field.key)), [overriddenKeys]);

    const optionLabel = (field: RenderField, option: string) => {
        const key = optionLabelKey(field, option);
        return key === null ? option : t[key];
    };
    const inheritedText = (field: RenderField) =>
        formatRenderValue(inheritedRenderValue(field.key, globalProfile), {
            unset: t["Not set"],
            on: t["On"],
            off: t["Off"],
            option: (option) => optionLabel(field, option),
        });
    const globalHint = (field: RenderField) => t["Global: {v}"].replace("{v}", inheritedText(field));

    const addOverride = () => {
        if (pending === NO_SELECTION) return;
        setRenderValue(pending, initialOverrideValue(pending, globalProfile));
        setPending(NO_SELECTION);
    };

    return (
        <div className="flex flex-col gap-4">
            {/* Title, then straight into the add row — no caption in between. */}
            <SectionTitle variant="subsection" mb="0">
                {t["Render Settings"]}
            </SectionTitle>

            {/* Add row */}
            <div className="flex flex-row items-center gap-3">
                <div className="flex-1 min-w-0 max-w-xs">
                    <Select
                        selectedKey={pending}
                        isDisabled={available.length === 0}
                        onSelectionChange={(key) => {
                            if (key) setPending(key as RenderFieldKey);
                        }}
                    >
                        <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                            <ListBox>
                                {/* The inherited value rides along, so the user
                                    knows what "global" currently means before
                                    deciding to override it. */}
                                {available.map((field) => (
                                    <ListBox.Item id={field.key} key={field.key} textValue={field.key}>
                                        {t[field.labelKey]} · {globalHint(field)}
                                    </ListBox.Item>
                                ))}
                            </ListBox>
                        </Select.Popover>
                    </Select>
                </div>
                <Button variant="outline" isDisabled={pending === NO_SELECTION} onPress={addOverride}>
                    <Plus size={15} />
                    {t["Add Override"]}
                </Button>
            </div>

            {overridden.length === 0 && (
                <p className="text-sm text-muted">
                    {t["No overrides yet — every render setting uses the global configuration."]}
                </p>
            )}

            <div className="flex flex-col gap-2">
                {overridden.map((field) => (
                    <OverrideRow
                        key={field.key}
                        field={field}
                        value={draft[field.key] as RenderValue | undefined}
                        inherited={inheritedText(field)}
                        setRenderValue={setRenderValue}
                        borderColor={borderColor}
                    />
                ))}
            </div>
        </div>
    );
}

function OverrideRow({
    field,
    value,
    inherited,
    setRenderValue,
    borderColor,
}: {
    field: RenderField;
    value: RenderValue | undefined;
    /** The global value, already formatted — what "Use Global Setting" falls back to. */
    inherited: string;
    setRenderValue: ProfileRenderOverridesProps["setRenderValue"];
    borderColor: string;
}) {
    const t = useI18n();
    const description =
        field.kind === "toggle" && field.descriptionKey ? t[field.descriptionKey] : undefined;
    const globalHint = t["Global: {v}"].replace("{v}", inherited);

    // Two lines, not one: the settings content area is as narrow as ~310px
    // (600px window − the 180px section sidebar − padding), where a
    // label + control + button row would not fit.
    return (
        <div
            className="flex flex-col gap-2 px-3 py-2.5 rounded-md"
            style={{border: `1px solid ${borderColor}`}}
        >
            {/* What this row is, and what "global" currently means for it. */}
            <div className="flex flex-row items-start justify-between gap-3">
                <div className="flex flex-col gap-0.5 min-w-0">
                    <Label>{t[field.labelKey]}</Label>
                    {description && <p className="text-xs text-muted">{description}</p>}
                </div>
                <span className="text-xs text-muted shrink-0 max-w-[55%] truncate pt-0.5" title={globalHint}>
                    {globalHint}
                </span>
            </div>

            {/* The control, and the explicit way back to the global setting. */}
            <div className="flex flex-row items-center justify-between gap-3">
                <RenderFieldControl
                    field={field}
                    value={value}
                    onChange={(next) => setRenderValue(field.key, next)}
                    idPrefix="profile"
                    inherit={{label: t["Use Global Setting"], value: inherited}}
                    className="flex-1 min-w-0"
                />
                <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onPress={() => setRenderValue(field.key, undefined)}
                >
                    <RotateCcw size={14} />
                    {t["Use Global Setting"]}
                </Button>
            </div>

            {field.key === "themePath" && (
                <ThemePathPreview options={{themePath: typeof value === "string" ? value : undefined}} />
            )}
        </div>
    );
}
