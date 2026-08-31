import {useCallback, useState} from "react";
import {Button} from "@heroui/react";
import {ImagePlus, Sparkles} from "lucide-react";
import {open} from "@tauri-apps/plugin-dialog";
import {warn} from "@tauri-apps/plugin-log";
import {useI18n} from "../../hooks/i18n.tsx";
import {customIconId} from "../../lib/appIcon.ts";
import {importCommandIcon} from "../../lib/commandIconApi.ts";
import {APP_ICON_IDS} from "../../assets/app-icons/index.ts";
import AppIcon from "../AppIcon.tsx";

/** A single selectable icon thumbnail in the picker grid. */
function IconChoice({
    icon,
    dark,
    selected,
    title,
    onPick,
}: {
    icon: string;
    dark: boolean;
    selected: boolean;
    title: string;
    onPick: () => void;
}) {
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            aria-pressed={selected}
            onClick={onPick}
            className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-choice-hover)]"
            style={{
                border: selected ? "1px solid rgba(128,128,128,0.4)" : "1px solid transparent",
                ["--lum-choice-hover" as string]: "rgba(128,128,128,0.15)",
            }}
        >
            <AppIcon app={icon} dark={dark} size={22} />
        </button>
    );
}

/**
 * The icon picker grid: every built-in app icon, every stored custom icon,
 * and an import button. Shared by the command-icon rules and the profile
 * "wrap as app" launcher section so both pick from the same library.
 *
 * Visibility is the parent's concern (the command-icon rows collapse it
 * behind a button; the launcher section shows it inline). An optional
 * leading "auto" choice (picked as `""`) lets a consumer express "derive
 * the icon automatically" instead of forcing a manual choice.
 */
export default function IconPicker({
    selected,
    onPick,
    dark,
    customIconIds,
    onImported,
    autoLabel,
}: {
    /** Currently selected icon id; `""` selects the auto option (if shown). */
    selected: string;
    /** Called with the picked icon id, or `""` for the auto option. */
    onPick: (id: string) => void;
    /** Whether the surrounding surface is dark (picks icon variants). */
    dark: boolean;
    /** Every stored custom icon as `custom:` ids — the picker's source of
     *  truth is the disk list (plus whatever onImported reports), so icons
     *  stay selectable after their rule/draft stops referencing them. */
    customIconIds: string[];
    /** Notifies the parent that a new icon file was stored (refresh lists). */
    onImported: (name: string) => void;
    /** Label for a leading "auto" choice that picks `""`. Omit for none. */
    autoLabel?: string;
}) {
    const t = useI18n();
    const [importing, setImporting] = useState(false);

    const handleImport = useCallback(async () => {
        setImporting(true);
        try {
            const picked = await open({
                multiple: false,
                filters: [{name: t["Icon images"], extensions: ["svg", "png"]}],
            });
            if (typeof picked !== "string") return;
            const name = await importCommandIcon(picked);
            onPick(customIconId(name));
            onImported(name);
        } catch (e) {
            warn(`Command icon import cancelled/failed: ${e}`).catch(() => {});
        } finally {
            setImporting(false);
        }
    }, [onPick, onImported, t]);

    return (
        <div className="flex flex-row flex-wrap items-center gap-1.5">
            {autoLabel !== undefined && (
                <button
                    type="button"
                    title={autoLabel}
                    aria-label={autoLabel}
                    aria-pressed={selected === ""}
                    onClick={() => onPick("")}
                    className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-choice-hover)]"
                    style={{
                        border:
                            selected === ""
                                ? "1px solid rgba(128,128,128,0.4)"
                                : "1px solid transparent",
                        ["--lum-choice-hover" as string]: "rgba(128,128,128,0.15)",
                    }}
                >
                    <Sparkles size={16} className="text-muted" />
                </button>
            )}
            {APP_ICON_IDS.map((id) => (
                <IconChoice
                    key={id}
                    icon={id}
                    dark={dark}
                    selected={selected === id}
                    title={id}
                    onPick={() => onPick(id)}
                />
            ))}
            {customIconIds.map((id) => (
                <IconChoice
                    key={id}
                    icon={id}
                    dark={dark}
                    selected={selected === id}
                    title={id}
                    onPick={() => onPick(id)}
                />
            ))}
            <Button variant="outline" size="sm" onPress={handleImport} isDisabled={importing}>
                <ImagePlus size={14} />
                {t["Import image…"]}
            </Button>
        </div>
    );
}
