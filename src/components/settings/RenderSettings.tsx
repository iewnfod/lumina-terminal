import {FontStyle, TerminalRenderOptions} from "../../types/terminal.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {useEffect, useState} from "react";
import {type FontWeight, type ITerminalOptions, ITheme} from "@xterm/xterm";
import {parseProfileTheme} from "../../lib/term.ts";
import {Input, Label, ListBox, Select, Switch} from "@heroui/react";
import ThemePreview from "../ThemePreview.tsx";
import SettingRow from "../ui/SettingRow.tsx";
import { ChevronDown } from "lucide-react";

const FONT_WEIGHT_OPTIONS: FontWeight[] = ["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"];
const CURSOR_STYLE_OPTIONS: NonNullable<ITerminalOptions["cursorStyle"]>[] = ["block", "underline", "bar"];

export default function RenderSettings({
    draft,
    updateDraft,
    idPrefix,
    defaultExpanded = true,
}: {
    draft: TerminalRenderOptions;
    updateDraft: (updates: Partial<TerminalRenderOptions>) => void;
    idPrefix: string;
    defaultExpanded?: boolean;
}) {
    const t = useI18n();
    const [themePreview, setThemePreview] = useState<ITheme | null>(null);
    const [expanded, setExpanded] = useState(defaultExpanded);

    useEffect(() => {
        parseProfileTheme(draft).then(setThemePreview);
    }, [draft.themePath, draft.theme]);

    const fields = (
        <div className="flex flex-col gap-4">
            {/* Rows and Columns */}
            <div className="flex flex-row gap-4">
                <SettingRow label={<Label htmlFor="profile-rows">{t["Rows"]}</Label>}>
                    <Input
                        id="profile-rows"
                        type="number"
                        min={1}
                        value={String(draft.rows ?? "")}
                        onChange={(e) => {
                            const v = e.target.value;
                            updateDraft({ rows: v ? Math.max(1, +v || 1) : undefined });
                        }}
                        className="w-24"
                    />
                </SettingRow>
                <SettingRow label={<Label htmlFor="profile-cols">{t["Columns"]}</Label>}>
                    <Input
                        id="profile-cols"
                        type="number"
                        min={1}
                        value={String(draft.cols ?? "")}
                        onChange={(e) => {
                            const v = e.target.value;
                            updateDraft({ cols: v ? Math.max(1, +v || 1) : undefined });
                        }}
                        className="w-24"
                    />
                </SettingRow>
                {/* Padding */}
                <SettingRow label={<Label htmlFor={`${idPrefix}-padding`}>{t["Padding"]}</Label>}>
                    <Input
                        id={`${idPrefix}-padding`}
                        type="number"
                        min={0}
                        value={String(draft.padding ?? "")}
                        onChange={(e) =>
                            updateDraft({ padding: e.target.value ? Math.max(0, +e.target.value || 0) : undefined })
                        }
                        className="w-24"
                    />
                </SettingRow>
                {/* Scrollback */}
                <SettingRow label={<Label htmlFor={`${idPrefix}-scrollback`}>{t["Scrollback"]}</Label>}>
                    <Input
                        id={`${idPrefix}-scrollback`}
                        type="number"
                        min={0}
                        value={String(draft.scrollback ?? "")}
                        onChange={(e) => {
                            const v = e.target.value;
                            updateDraft({ scrollback: v ? Math.max(0, +v || 0) : undefined });
                        }}
                        className="w-24"
                    />
                </SettingRow>
            </div>

            {/* Font Family */}
            <SettingRow label={<Label htmlFor={`${idPrefix}-font-family`}>{t["Font Family"]}</Label>}>
                <Input
                    id={`${idPrefix}-font-family`}
                    value={draft.fontFamily ?? ""}
                    onChange={(e) =>
                        updateDraft({ fontFamily: e.target.value || undefined })
                    }
                    className="max-w-sm"
                    placeholder="e.g. JetBrains Mono"
                />
            </SettingRow>

            {/* Font Size / Weight / Style */}
            <div className="flex flex-row gap-5">
                <SettingRow label={<Label htmlFor={`${idPrefix}-font-size`}>{t["Font Size"]}</Label>}>
                    <Input
                        id={`${idPrefix}-font-size`}
                        type="number"
                        min={1}
                        value={String(draft.fontSize ?? "")}
                        onChange={(e) =>
                            updateDraft({ fontSize: +e.target.value || undefined })
                        }
                        className="w-24"
                    />
                </SettingRow>
                <SettingRow label={<Label>{t["Font Weight"]}</Label>}>
                    <Select
                        selectedKey={String(draft.fontWeight)}
                        onSelectionChange={(key) => {
                            if (key) {
                                updateDraft({ fontWeight: key as FontWeight });
                            }
                        }}
                        className="w-32"
                    >
                        <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                            <ListBox>
                                {FONT_WEIGHT_OPTIONS.map((weight) => (
                                    <ListBox.Item id={String(weight)} key={String(weight)} textValue={String(weight)}>
                                        {String(weight)}
                                    </ListBox.Item>
                                ))}
                            </ListBox>
                        </Select.Popover>
                    </Select>
                </SettingRow>
                <SettingRow label={<Label>{t["Font Style"]}</Label>}>
                    <Select
                        selectedKey={draft.fontStyle}
                        onSelectionChange={(key) => {
                            if (key) {
                                updateDraft({ fontStyle: key as FontStyle });
                            }
                        }}
                        className="w-32"
                    >
                        <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                            <ListBox>
                                <ListBox.Item id="normal" textValue="normal">
                                    {t["Normal"]}
                                </ListBox.Item>
                                <ListBox.Item id="italic" textValue="italic">
                                    {t["Italic"]}
                                </ListBox.Item>
                            </ListBox>
                        </Select.Popover>
                    </Select>
                </SettingRow>
            </div>

            {/* Cursor Style + Blink */}
            <div className="flex flex-row gap-5 items-end">
                <SettingRow label={<Label>{t["Cursor Style"]}</Label>}>
                    <Select
                        selectedKey={draft.cursorStyle ?? "block"}
                        onSelectionChange={(key) => {
                            if (key) {
                                updateDraft({ cursorStyle: key as NonNullable<ITerminalOptions["cursorStyle"]> });
                            }
                        }}
                        className="w-32"
                    >
                        <Select.Trigger>
                            <Select.Value />
                            <Select.Indicator />
                        </Select.Trigger>
                        <Select.Popover>
                            <ListBox>
                                {CURSOR_STYLE_OPTIONS.map((style) => (
                                    <ListBox.Item id={style} key={style} textValue={style}>
                                        {t[`cursor_${style}`]}
                                    </ListBox.Item>
                                ))}
                            </ListBox>
                        </Select.Popover>
                    </Select>
                </SettingRow>
                <SettingRow
                    variant="toggle"
                    className="pb-1.5"
                    label={<Label className="cursor-pointer">{t["Cursor Blink"]}</Label>}
                    onClick={() => updateDraft({ cursorBlink: !(draft.cursorBlink ?? false) })}
                >
                    <Switch
                        isSelected={draft.cursorBlink ?? false}
                        onChange={(v) => updateDraft({ cursorBlink: v })}
                    >
                        <Switch.Control>
                            <Switch.Thumb />
                        </Switch.Control>
                    </Switch>
                </SettingRow>
            </div>

            {/* Theme Path */}
            <SettingRow label={<Label htmlFor={`${idPrefix}-theme`}>{t["Theme Path"]}</Label>}>
                <div className="flex flex-row items-center justify-between gap-4">
                    <Input
                        id={`${idPrefix}-theme`}
                        value={draft.themePath ?? ""}
                        onChange={(e) =>
                            updateDraft({ themePath: e.target.value || undefined })
                        }
                        className="flex-1"
                        placeholder="e.g. themes/my-theme.json"
                    />
                    <ThemePreview theme={themePreview} />
                </div>
            </SettingRow>

            {/* WebGL Renderer */}
            <SettingRow
                variant="toggle"
                label={<Label className="cursor-pointer">{t["WebGL Renderer"]}</Label>}
                description={t["webgl description"]}
                onClick={() => updateDraft({ webgl: !(draft.webgl ?? false) })}
            >
                <Switch
                    isSelected={draft.webgl ?? false}
                    onChange={(v) => updateDraft({ webgl: v })}
                >
                    <Switch.Control>
                        <Switch.Thumb />
                    </Switch.Control>
                </Switch>
            </SettingRow>

            {/* Grapheme Clusters (experimental) */}
            <SettingRow
                variant="toggle"
                label={<Label className="cursor-pointer">{t["Grapheme Clusters"]}</Label>}
                description={t["grapheme clusters description"]}
                onClick={() => updateDraft({ graphemeClusters: !(draft.graphemeClusters ?? false) })}
            >
                <Switch
                    isSelected={draft.graphemeClusters ?? false}
                    onChange={(v) => updateDraft({ graphemeClusters: v })}
                >
                    <Switch.Control>
                        <Switch.Thumb />
                    </Switch.Control>
                </Switch>
            </SettingRow>

            {/* Ligatures */}
            <SettingRow
                variant="toggle"
                label={<Label className="cursor-pointer">{t["Ligatures"]}</Label>}
                description={t["ligatures description"]}
                onClick={() => updateDraft({ ligatures: !(draft.ligatures ?? false) })}
            >
                <Switch
                    isSelected={draft.ligatures ?? false}
                    onChange={(v) => updateDraft({ ligatures: v })}
                >
                    <Switch.Control>
                        <Switch.Thumb />
                    </Switch.Control>
                </Switch>
            </SettingRow>
        </div>
    );

    if (defaultExpanded) {
        return fields;
    }

    return (
        <div className="flex flex-col">
            <button
                className="flex flex-row items-center gap-2 py-2 cursor-pointer select-none hover:opacity-80 transition-opacity"
                onClick={() => setExpanded(!expanded)}
            >
                <ChevronDown
                    size={16}
                    style={{
                        transform: expanded ? "rotate(0deg)" : "rotate(-90deg)",
                        transition: "transform 150ms",
                    }}
                />
                <span className="text-sm font-medium">{t["Render Settings"]}</span>
            </button>
            {expanded && fields}
        </div>
    );
}
