import {useEffect, useState} from "react";
import {ITheme} from "@xterm/xterm";
import {Tooltip} from "@heroui/react";
import {error} from "@tauri-apps/plugin-log";
import {TerminalRenderOptions} from "../types/terminal.ts";
import {parseProfileTheme} from "../lib/term.ts";

export default function ThemePreview({ theme }: { theme: ITheme | null }) {
    if (!theme) return null;
    return (
        <div className="flex flex-col gap-1 shrink-0 pr-3">
            <div className="flex flex-row gap-1">
                {([["black", "Black"], ["red", "Red"], ["green", "Green"], ["yellow", "Yellow"]] as const).map(([key, label]) => (
                    <Tooltip key={key} delay={300} closeDelay={0}>
                        <Tooltip.Trigger>
                            <div
                                className="w-5 h-5 rounded-sm cursor-pointer"
                                style={{ background: theme[key] ?? "#000" }}
                            />
                        </Tooltip.Trigger>
                        <Tooltip.Content>
                            <p className="text-xs">{label} {theme[key]}</p>
                        </Tooltip.Content>
                    </Tooltip>
                ))}
            </div>
            <div className="flex flex-row gap-1">
                {([["blue", "Blue"], ["magenta", "Magenta"], ["cyan", "Cyan"], ["white", "White"]] as const).map(([key, label]) => (
                    <Tooltip key={key} delay={300} closeDelay={0}>
                        <Tooltip.Trigger>
                            <div
                                className="w-5 h-5 rounded-sm cursor-pointer"
                                style={{ background: theme[key] ?? "#000" }}
                            />
                        </Tooltip.Trigger>
                        <Tooltip.Content>
                            <p className="text-xs">{label} {theme[key]}</p>
                        </Tooltip.Content>
                    </Tooltip>
                ))}
            </div>
        </div>
    );
}

/** Resolves the theme an options object's `themePath` (+ inline `theme`)
 *  points to and shows its swatches. Renders nothing until the theme is
 *  loaded; an unreadable path still resolves to the default palette (the same
 *  fallback a running terminal gets), so the preview never blanks. Shared by
 *  the Global Profile form and a profile's theme-path override row. */
export function ThemePathPreview({ options }: { options: TerminalRenderOptions }) {
    const [theme, setTheme] = useState<ITheme | null>(null);

    useEffect(() => {
        parseProfileTheme(options).then(setTheme).catch((e) => {
            error(`Failed to resolve theme for preview: ${e}`).catch(() => {});
        });
        // Only the theme inputs matter — edits to other options must not re-read the file.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [options.themePath, options.theme]);

    return <ThemePreview theme={theme} />;
}
