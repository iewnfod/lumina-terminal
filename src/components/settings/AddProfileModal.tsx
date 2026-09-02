import {Button, Card, Modal} from "@heroui/react";
import { Monitor, Cloud } from "lucide-react";
import { TerminalProfile } from "../../types/terminal.ts";
import { useI18n } from "../../hooks/i18n.tsx";
import { useSshConfig } from "../../hooks/useSshConfig.ts";
import { formatSshEntry } from "../../lib/ssh.ts";

interface Props {
    isOpen: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (profile: TerminalProfile) => void;
    borderColor: string;
}

export default function AddProfileModal({ isOpen, onOpenChange, onCreate, borderColor }: Props) {
    const t = useI18n();
    const sshEntries = useSshConfig();

    return (
        <Modal.Backdrop
            isOpen={isOpen}
            onOpenChange={onOpenChange}
            isDismissable
            variant="blur"
        >
            <Modal.Container placement="center">
                <Modal.Dialog className="min-w-[360px]">
                    <Modal.Header>
                        <h3 className="text-lg font-semibold select-none">{t["Add Profile"]}</h3>
                    </Modal.Header>
                    <Modal.Body className="overflow-hidden mt-3">
                        <div className="flex flex-col gap-4">
                            <div className="flex flex-row gap-4">
                                <Button
                                    variant="outline"
                                    onPress={() => {
                                        onCreate({
                                            name: t["Untitled Profile"],
                                            exePath: "",
                                            type: "local",
                                        });
                                    }}
                                >
                                    <Monitor size={18} />
                                    {t["New Local Profile"]}
                                </Button>
                                <Button
                                    variant="outline"
                                    onPress={() => {
                                        onCreate({
                                            name: t["Untitled Profile"],
                                            exePath: "",
                                            type: "remote",
                                            ssh: { host: "", port: 22 },
                                        });
                                    }}
                                >
                                    <Cloud size={18} />
                                    {t["New Remote Profile"]}
                                </Button>
                            </div>
                            {sshEntries.length > 0 && (
                                <div className="flex flex-col gap-3">
                                    <div className="flex items-center gap-2">
                                        <div className="flex-1" style={{ borderTop: `1px solid ${borderColor}` }} />
                                        <span className="text-xs text-muted select-none">{t["Import from SSH Config"]}</span>
                                        <div className="flex-1" style={{ borderTop: `1px solid ${borderColor}` }} />
                                    </div>
                                    <div className="grid grid-cols-1 gap-3 max-h-64 overflow-y-auto p-1">
                                        {sshEntries.map((entry) => (
                                            <Card
                                                key={entry.host}
                                                className="lum-ssh-card flex flex-row items-center gap-3 py-3 px-4 cursor-pointer rounded-[var(--radius-md)] hover:bg-default/10 transition-colors duration-[var(--duration-base)] ease-[var(--ease-glass)]"
                                                onClick={() => {
                                                    onCreate({
                                                        name: entry.host,
                                                        exePath: "",
                                                        type: "remote",
                                                        ssh: entry.config,
                                                    });
                                                }}
                                            >
                                                <Cloud size={18} className="shrink-0 text-muted" />
                                                <div className="flex flex-col min-w-0">
                                                    <span className="font-semibold">{entry.host}</span>
                                                    <span className="text-xs text-muted truncate">
                                                        {formatSshEntry(entry)}
                                                    </span>
                                                </div>
                                            </Card>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>
                    </Modal.Body>
                    <Modal.Footer>
                        <Button variant="outline" onPress={() => onOpenChange(false)}>
                            {t["Cancel"]}
                        </Button>
                    </Modal.Footer>
                </Modal.Dialog>
            </Modal.Container>
        </Modal.Backdrop>
    );
}
