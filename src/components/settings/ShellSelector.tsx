import {useMemo} from "react";
import {Button, Input, Label, ListBox, Select} from "@heroui/react";
import {useI18n} from "../../hooks/i18n.tsx";
import {useShells} from "../../hooks/useShells.ts";
import {isWindows} from "../../lib/platform.ts";
import {open} from "@tauri-apps/plugin-dialog";
import {info} from "@tauri-apps/plugin-log";

// Sentinel for the "custom exe path" option in the shell dropdown.
const CUSTOM_EXE = "__custom__";

interface ShellSelectorProps {
    exePath: string;
    onChange: (path: string) => void;
    idPrefix?: string;
    className?: string;
}

/**
 * Shell picker: a dropdown of discovered shells plus a "Custom" option that
 * reveals a text input + file browser. Encapsulates the CUSTOM_EXE sentinel,
 * selected-key derivation, and the exe file dialog (with windows .exe filter)
 * so ProfileSettings and WelcomePage share one implementation.
 */
export default function ShellSelector({exePath, onChange, idPrefix = "shell", className}: ShellSelectorProps) {
    const t = useI18n();
    const shells = useShells();
    const isCustom = !!exePath && !shells.includes(exePath);

    const selectedKey = useMemo(() => {
        if (isCustom) return CUSTOM_EXE;
        if (!exePath) return "";
        if (shells.includes(exePath)) return exePath;
        return CUSTOM_EXE;
    }, [exePath, shells, isCustom]);

    const handleSelectionChange = (key: string) => {
        if (key === CUSTOM_EXE) {
            onChange("");
        } else if (key) {
            onChange(key);
        }
    };

    const browse = async () => {
        const exe = await open({
            multiple: false,
            directory: false,
            filters: isWindows()
                ? [{name: "Executable File", extensions: ["exe"]}]
                : [],
        });
        if (exe) {
            info(`Shell exe path selected: ${exe}`);
            onChange(exe);
        }
    };

    const inputId = `${idPrefix}-exe-path`;

    return (
        <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
            <Label htmlFor={inputId} isRequired>{t["Exe Path"]}</Label>
            <Select
                selectedKey={selectedKey}
                onSelectionChange={(key) => handleSelectionChange(key as string)}
                className="max-w-sm"
            >
                <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                    <ListBox>
                        {shells.map((path) => {
                            const name = path.replace(/\\/g, "/").split("/").pop() || path;
                            return (
                                <ListBox.Item id={path} key={path} textValue={name}>
                                    {name}
                                    <span className="text-xs text-muted ml-2">{path}</span>
                                </ListBox.Item>
                            );
                        })}
                        <ListBox.Item id={CUSTOM_EXE} key={CUSTOM_EXE} textValue="Custom">
                            {t["Custom"]}
                        </ListBox.Item>
                    </ListBox>
                </Select.Popover>
            </Select>
            {isCustom && (
                <div className="flex flex-row gap-2 items-center mt-1">
                    <Input
                        id={inputId}
                        value={exePath}
                        onChange={(e) => onChange(e.target.value)}
                        className="flex-1 max-w-sm"
                    />
                    <Button
                        variant="outline"
                        size="sm"
                        onPress={browse}
                    >
                        {t["Select"]}
                    </Button>
                </div>
            )}
        </div>
    );
}
