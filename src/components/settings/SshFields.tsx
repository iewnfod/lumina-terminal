import {Button, Input, Label} from "@heroui/react";
import {useI18n} from "../../hooks/i18n.tsx";
import {SSHConfig} from "../../types/terminal.ts";
import {open} from "@tauri-apps/plugin-dialog";
import {warn} from "@tauri-apps/plugin-log";

interface SshFieldsProps {
    ssh: SSHConfig | undefined;
    onChange: (updates: Partial<SSHConfig>) => void;
    idPrefix?: string;
}

/**
 * SSH connection fields: Host, Port, User, Identity File. Shared by
 * ProfileSettings and the Welcome wizard so the two stay in sync.
 */
export default function SshFields({ssh, onChange, idPrefix = "ssh"}: SshFieldsProps) {
    const t = useI18n();

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${idPrefix}-host`} isRequired>{t["Host"]}</Label>
                <Input
                    id={`${idPrefix}-host`}
                    value={ssh?.host ?? ""}
                    onChange={(e) => onChange({host: e.target.value})}
                    className="max-w-sm"
                    placeholder="e.g. 192.168.1.100 or example.com"
                />
            </div>
            <div className="flex flex-row gap-4">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${idPrefix}-port`}>{t["Port"]}</Label>
                    <Input
                        id={`${idPrefix}-port`}
                        type="number"
                        min={1}
                        max={65535}
                        value={String(ssh?.port ?? 22)}
                        onChange={(e) => onChange({port: e.target.value ? Math.max(1, +e.target.value || 22) : undefined})}
                        className="w-28"
                    />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={`${idPrefix}-user`}>{t["User"]}</Label>
                    <Input
                        id={`${idPrefix}-user`}
                        value={ssh?.user ?? ""}
                        onChange={(e) => onChange({user: e.target.value || undefined})}
                        className="w-48"
                        placeholder="e.g. root"
                    />
                </div>
            </div>
            <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${idPrefix}-identity-file`}>{t["Identity File"]}</Label>
                <div className="flex flex-row gap-2">
                    <Input
                        id={`${idPrefix}-identity-file`}
                        value={ssh?.identityFile ?? ""}
                        onChange={(e) => onChange({identityFile: e.target.value || undefined})}
                        className="flex-1 max-w-sm"
                        placeholder="e.g. ~/.ssh/id_ed25519"
                    />
                    <Button
                        variant="outline"
                        size="sm"
                        onPress={async () => {
                            try {
                                const file = await open({
                                    multiple: false,
                                    directory: false,
                                    filters: [{name: "All Files", extensions: ["*"]}],
                                });
                                if (file) onChange({identityFile: file});
                            } catch (e) {
                                warn(`File picker failed: ${e}`).catch(() => {});
                            }
                        }}
                    >
                        {t["Select"]}
                    </Button>
                </div>
            </div>
        </div>
    );
}
