import {useI18n} from "../../hooks/i18n.tsx";
import {useEffect, useState} from "react";
import {getConfigFilePath} from "../../lib/configFile.ts";
import {openInFileManager} from "../../lib/fileManagerApi.ts";
import {invoke} from "@tauri-apps/api/core";
import {Button, Input, Label, ListBox, Select, Switch} from "@heroui/react";
import {Bug, Clipboard, FolderOpen} from "lucide-react";
import {info, warn, error} from "@tauri-apps/plugin-log";
import {useGlobalConfig} from "../../hooks/config.tsx";
import {useMcpStatus} from "../../hooks/useMcpServer.ts";
import {invalidateInstallSourceCache, MOCK_INSTALL_SOURCE_KEY} from "../../hooks/useInstallSource.ts";
import {MOCK_UPDATE_KEY} from "../../lib/updater.ts";
import {MCP_DEFAULT_PORT} from "../../constants.ts";
import SettingsShell from "../ui/SettingsShell.tsx";
import SettingRow from "../ui/SettingRow.tsx";
import SectionTitle from "../ui/SectionTitle.tsx";

// Mock value shapes ("" = no mock). The localStorage KEYS live next to their
// readers (lib/updater.ts + hooks/useInstallSource.ts) so they can never
// drift apart.
type MockValue = "available" | "upToDate" | "error" | "";
type MockInstallValue = "pacman" | "dpkg" | "rpm" | "";

/** Action row showing a path (truncated, full value on hover) with an
 *  open-in-file-manager button — the config file + log directory rows. */
function RevealRow({label, path}: {label: string; path: string}) {
    const t = useI18n();
    return (
        <SettingRow
            variant="action"
            label={<Label>{label}</Label>}
            description={<span className="truncate block" title={path}>{path || "—"}</span>}
        >
            <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onPress={() => {
                    if (path) {
                        openInFileManager(path).catch(() => {
                            // logged in the wrapper
                        });
                    }
                }}
            >
                <FolderOpen size={15} />
                {t["Open"]}
            </Button>
        </SettingRow>
    );
}

/** Action row with a small "simulate a dev mock" picker — the mock update
 *  state + mock install source rows share everything but the options. */
function MockSelectRow({label, description, selected, options, onApply}: {
    label: string;
    description: string;
    selected: string;
    options: {id: string; text: string}[];
    onApply: (id: string) => void;
}) {
    return (
        <SettingRow
            variant="action"
            label={<Label>{label}</Label>}
            description={description}
        >
            <div className="w-40 shrink-0">
                <Select
                    selectedKey={selected || "none"}
                    onSelectionChange={(key) => {
                        if (key) onApply(key === "none" ? "" : String(key));
                    }}
                >
                    <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                        <ListBox>
                            {options.map((opt) => (
                                <ListBox.Item id={opt.id} key={opt.id} textValue={opt.id}>
                                    {opt.text}
                                </ListBox.Item>
                            ))}
                        </ListBox>
                    </Select.Popover>
                </Select>
            </div>
        </SettingRow>
    );
}

export default function DeveloperSettings() {
    const t = useI18n();
    const {config, updateConfig} = useGlobalConfig();
    const mcpStatus = useMcpStatus();
    const mcpEnabled = config.enableMcp ?? false;
    const mcpPort = config.mcpPort ?? MCP_DEFAULT_PORT;
    const [copied, setCopied] = useState(false);
    const [configPath, setConfigPath] = useState("");
    const [logDir, setLogDir] = useState("");
    const [isDebug, setIsDebug] = useState(false);
    // Mock update state — read right from localStorage, no real data involved.
    const [mockUpdate, setMockUpdate] = useState<MockValue>("");
    // Mock install source — same localStorage-driven pattern as mockUpdate.
    const [mockInstallSource, setMockInstallSource] = useState<MockInstallValue>("");

    useEffect(() => {
        getConfigFilePath().then(setConfigPath).catch((e) => {
            error(`Failed to resolve config file path: ${e}`).catch(() => {});
            setConfigPath("");
        });
        invoke<string>("get_log_dir").then(setLogDir).catch((e) => {
            error(`Failed to resolve log directory: ${e}`).catch(() => {});
            setLogDir("");
        });
        invoke<boolean>("is_debug").then(setIsDebug).catch((e) => {
            error(`Failed to check debug mode: ${e}`).catch(() => {});
            setIsDebug(false);
        });
        setMockUpdate((localStorage.getItem(MOCK_UPDATE_KEY) ?? "") as MockValue);
        setMockInstallSource((localStorage.getItem(MOCK_INSTALL_SOURCE_KEY) ?? "") as MockInstallValue);
    }, []);

    const applyMock = (value: MockValue) => {
        setMockUpdate(value);
        if (value === "") {
            localStorage.removeItem(MOCK_UPDATE_KEY);
        } else {
            localStorage.setItem(MOCK_UPDATE_KEY, value);
        }
    };

    const applyMockInstallSource = (value: MockInstallValue) => {
        setMockInstallSource(value);
        if (value === "") {
            localStorage.removeItem(MOCK_INSTALL_SOURCE_KEY);
        } else {
            localStorage.setItem(MOCK_INSTALL_SOURCE_KEY, value);
        }
        // Re-run detection now (mock included) so the picker applies live —
        // the source is otherwise cached for the whole session.
        invalidateInstallSourceCache();
    };

    const copyMcpUrl = () => {
        if (!mcpStatus.endpoint) return;
        navigator.clipboard.writeText(mcpStatus.endpoint.url).then(() => {
            setCopied(true);
            info("MCP connection URL copied to clipboard").catch(() => {});
            setTimeout(() => setCopied(false), 1500);
        }).catch((e) => {
            warn(`Failed to copy MCP URL: ${e}`).catch(() => {});
        });
    };

    return (
        <SettingsShell>
            <SectionTitle>{t["Developer"]}</SectionTitle>

            <div className="flex flex-col gap-5">
                {/* Config File Path */}
                <RevealRow label={t["Config File Path"]} path={configPath} />

                {/* Log Directory */}
                <RevealRow label={t["Log Directory"]} path={logDir} />

                {/* DevTools */}
                <SettingRow
                    variant="action"
                    label={<Label>{t["DevTools"]}</Label>}
                    description={t["Open the webview developer tools"]}
                >
                    <Button
                        variant="outline"
                        size="sm"
                        isDisabled={!isDebug}
                        onPress={() => invoke("open_devtools").catch(() => {
                            warn("DevTools command not available, use Ctrl+Shift+I").catch(() => {});
                        })}
                    >
                        <Bug size={15} />
                        {t["Open"]}
                    </Button>
                </SettingRow>

                {/* MCP Server — expose the terminal state to local AI clients
                    over a read-only loopback endpoint. Off by default. The
                    server lifecycle is managed at the app root
                    (useMcpServerLifecycle), not here, so it keeps running when
                    settings is closed. */}
                <SettingRow
                    variant="toggle"
                    label={<Label className="cursor-pointer">{t["MCP Server"]}</Label>}
                    description={t["Let local AI clients read your terminal state over a loopback connection (read-only)"]}
                    onClick={() => updateConfig({enableMcp: !mcpEnabled})}
                >
                    <Switch
                        isSelected={mcpEnabled}
                        onChange={(v) => updateConfig({enableMcp: v})}
                    >
                        <Switch.Control>
                            <Switch.Thumb />
                        </Switch.Control>
                    </Switch>
                </SettingRow>

                {/* MCP port. Changing it does not restart the running server —
                    toggle off/on to apply a new port (avoids flapping while
                    typing into the field). */}
                <SettingRow
                    label={<Label>{t["Port"]}</Label>}
                    description={t["Loopback port for the MCP server. Apply with a new port by toggling off/on."]}
                >
                    <Input
                        type="number"
                        value={String(mcpPort)}
                        className="w-28"
                        onChange={(e) => {
                            const n = parseInt(e.target.value, 10);
                            if (!Number.isNaN(n) && n > 0 && n < 65536) {
                                updateConfig({mcpPort: n});
                            }
                        }}
                    />
                </SettingRow>

                {/* Connection status — shown whenever MCP is enabled, so a start
                    problem is never silent. Reflects the three states: the URL
                    (running, with a copy button), an error (start failed), or a
                    "starting" hint while the request is in flight. Copy the URL
                    into an MCP client (ZCode, Claude Desktop, Cursor, …) to let
                    the AI read this terminal's state. */}
                {mcpEnabled && (
                    <SettingRow
                        variant="action"
                        label={<Label>{mcpStatus.error ? t["Error"] : t["Connection URL"]}</Label>}
                        description={
                            mcpStatus.error ? (
                                <span className="truncate block text-danger" title={mcpStatus.error}>{mcpStatus.error}</span>
                            ) : mcpStatus.endpoint ? (
                                <span className="truncate block" title={mcpStatus.endpoint.url}>{mcpStatus.endpoint.url}</span>
                            ) : (
                                <span className="text-muted">{t["Starting the MCP server…"]}</span>
                            )
                        }
                    >
                        {mcpStatus.endpoint && (
                            <Button
                                variant="outline"
                                size="sm"
                                className="shrink-0"
                                onPress={copyMcpUrl}
                            >
                                <Clipboard size={15} />
                                {copied ? t["Copied"] : t["Copy"]}
                            </Button>
                        )}
                    </SettingRow>
                )}

                {/* Mock Update State — dev-only, drives the updater mock purely
                    via localStorage (see lib/updater.ts DEV MOCK). */}
                {import.meta.env.DEV && (
                    <MockSelectRow
                        label={t["Mock Update State"]}
                        description={t["Simulate an update-check result for testing the update UI"]}
                        selected={mockUpdate}
                        options={[
                            {id: "none", text: t["None"]},
                            {id: "available", text: t["Available"]},
                            {id: "upToDate", text: t["Up to Date"]},
                            {id: "error", text: t["Error"]},
                        ]}
                        onApply={(id) => applyMock(id as MockValue)}
                    />
                )}

                {/* Mock Install Source — dev-only, drives the install-source
                    mock purely via localStorage (see hooks/useInstallSource.ts
                    DEV MOCK) and invalidates the cached result so it applies
                    immediately. */}
                {import.meta.env.DEV && (
                    <MockSelectRow
                        label={t["Mock Install Source"]}
                        description={t["Force a package-managed install for testing the update hint"]}
                        selected={mockInstallSource}
                        options={[
                            {id: "none", text: t["None"]},
                            {id: "pacman", text: "pacman"},
                            {id: "dpkg", text: "dpkg"},
                            {id: "rpm", text: "rpm"},
                        ]}
                        onApply={(id) => applyMockInstallSource(id as MockInstallValue)}
                    />
                )}
            </div>
        </SettingsShell>
    );
}
