import {useI18n} from "../../hooks/i18n.tsx";
import {useEffect, useState} from "react";
import {getConfigFilePath} from "../../lib/configFile.ts";
import {invoke} from "@tauri-apps/api/core";
import {Button, Input, Label, ListBox, Select, Switch} from "@heroui/react";
import {Bug, Clipboard, FolderOpen} from "lucide-react";
import {info, warn, error} from "@tauri-apps/plugin-log";
import {useGlobalConfig} from "../../hooks/config.tsx";
import {useMcpStatus} from "../../hooks/useMcpServer.ts";
import {invalidateInstallSourceCache} from "../../hooks/useInstallSource.ts";
import {MCP_DEFAULT_PORT} from "../../constants.ts";
import SettingsShell from "../ui/SettingsShell.tsx";
import SettingRow from "../ui/SettingRow.tsx";
import SectionTitle from "../ui/SectionTitle.tsx";

// localStorage key + values kept in sync with the dev mock in lib/updater.ts.
const MOCK_KEY = "LUMINA_MOCK_UPDATE";
type MockValue = "available" | "upToDate" | "error" | "";

// localStorage key + values kept in sync with the dev mock in
// hooks/useInstallSource.ts.
const MOCK_INSTALL_KEY = "LUMINA_MOCK_INSTALL_SOURCE";
type MockInstallValue = "pacman" | "dpkg" | "rpm" | "";

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
        setMockUpdate((localStorage.getItem(MOCK_KEY) ?? "") as MockValue);
        setMockInstallSource((localStorage.getItem(MOCK_INSTALL_KEY) ?? "") as MockInstallValue);
    }, []);

    const applyMock = (value: MockValue) => {
        setMockUpdate(value);
        if (value === "") {
            localStorage.removeItem(MOCK_KEY);
        } else {
            localStorage.setItem(MOCK_KEY, value);
        }
    };

    const applyMockInstallSource = (value: MockInstallValue) => {
        setMockInstallSource(value);
        if (value === "") {
            localStorage.removeItem(MOCK_INSTALL_KEY);
        } else {
            localStorage.setItem(MOCK_INSTALL_KEY, value);
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
                <SettingRow
                    variant="action"
                    label={<Label>{t["Config File Path"]}</Label>}
                    description={<span className="truncate block" title={configPath}>{configPath || "—"}</span>}
                >
                    <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onPress={() => {
                            if (configPath) {
                                invoke("open_in_file_manager", {path: configPath}).catch((e) => {
                                    warn(`Failed to open config file: ${e}`).catch(() => {});
                                });
                            }
                        }}
                    >
                        <FolderOpen size={15} />
                        {t["Open"]}
                    </Button>
                </SettingRow>

                {/* Log Directory */}
                <SettingRow
                    variant="action"
                    label={<Label>{t["Log Directory"]}</Label>}
                    description={<span className="truncate block" title={logDir}>{logDir || "—"}</span>}
                >
                    <Button
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onPress={() => {
                            if (logDir) {
                                invoke("open_in_file_manager", {path: logDir}).catch((e) => {
                                    warn(`Failed to open log directory: ${e}`).catch(() => {});
                                });
                            }
                        }}
                    >
                        <FolderOpen size={15} />
                        {t["Open"]}
                    </Button>
                </SettingRow>

                {/* DevTools */}
                <SettingRow
                    variant="action"
                    label={<Label>{t["DevTools"]}</Label>}
                    description={"Open the webview developer tools"}
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
                    <SettingRow
                        variant="action"
                        label={<Label>{t["Mock Update State"]}</Label>}
                        description={t["Simulate an update-check result for testing the update UI"]}
                    >
                        <div className="w-40 shrink-0">
                            <Select
                                selectedKey={mockUpdate || "none"}
                                onSelectionChange={(key) => {
                                    applyMock((key === "none" ? "" : key) as MockValue);
                                }}
                            >
                                <Select.Trigger>
                                    <Select.Value />
                                    <Select.Indicator />
                                </Select.Trigger>
                                <Select.Popover>
                                    <ListBox>
                                        <ListBox.Item id="none" key="none" textValue="none">
                                            {t["None"]}
                                        </ListBox.Item>
                                        <ListBox.Item id="available" key="available" textValue="available">
                                            {t["Available"]}
                                        </ListBox.Item>
                                        <ListBox.Item id="upToDate" key="upToDate" textValue="upToDate">
                                            {t["Up to Date"]}
                                        </ListBox.Item>
                                        <ListBox.Item id="error" key="error" textValue="error">
                                            {t["Error"]}
                                        </ListBox.Item>
                                    </ListBox>
                                </Select.Popover>
                            </Select>
                        </div>
                    </SettingRow>
                )}

                {/* Mock Install Source — dev-only, drives the install-source
                    mock purely via localStorage (see hooks/useInstallSource.ts
                    DEV MOCK) and invalidates the cached result so it applies
                    immediately. */}
                {import.meta.env.DEV && (
                    <SettingRow
                        variant="action"
                        label={<Label>{t["Mock Install Source"]}</Label>}
                        description={t["Force a package-managed install for testing the update hint"]}
                    >
                        <div className="w-40 shrink-0">
                            <Select
                                selectedKey={mockInstallSource || "none"}
                                onSelectionChange={(key) => {
                                    applyMockInstallSource((key === "none" ? "" : key) as MockInstallValue);
                                }}
                            >
                                <Select.Trigger>
                                    <Select.Value />
                                    <Select.Indicator />
                                </Select.Trigger>
                                <Select.Popover>
                                    <ListBox>
                                        <ListBox.Item id="none" key="none" textValue="none">
                                            {t["None"]}
                                        </ListBox.Item>
                                        <ListBox.Item id="pacman" key="pacman" textValue="pacman">
                                            pacman
                                        </ListBox.Item>
                                        <ListBox.Item id="dpkg" key="dpkg" textValue="dpkg">
                                            dpkg
                                        </ListBox.Item>
                                        <ListBox.Item id="rpm" key="rpm" textValue="rpm">
                                            rpm
                                        </ListBox.Item>
                                    </ListBox>
                                </Select.Popover>
                            </Select>
                        </div>
                    </SettingRow>
                )}
            </div>
        </SettingsShell>
    );
}
