import {Button, Card, Input, Label, ListBox, Select, Separator} from "@heroui/react";
import {languageNames, useI18n} from "../hooks/i18n.tsx";
import Icon from "../assets/icon.svg"
import {useGlobalConfig} from "../hooks/config.tsx";
import {useCallback, useEffect, useRef, useState} from "react";
import {getCurrentWindow, LogicalSize} from "@tauri-apps/api/window";
import {SSHConfig, TerminalProfile} from "../types/terminal.ts";
import {invoke} from "@tauri-apps/api/core";
import Confetti from "react-confetti-boom";
import { info, debug } from "@tauri-apps/plugin-log";
import ShellSelector from "../components/settings/ShellSelector.tsx";
import SshFields from "../components/settings/SshFields.tsx";
import {useSshConfig} from "../hooks/useSshConfig.ts";
import {formatSshAddress} from "../lib/ssh.ts";

function Step1({onNext} : {
    onNext: () => void;
}) {
    const {config, updateConfig} = useGlobalConfig();
    const t = useI18n();

    return (
        <Card
            data-tauri-drag-region
            className="flex flex-row items-center justify-between gap-5 select-none w-full h-full p-10 rounded-[var(--radius-lg)]"
        >
            <div className="relative h-40 w-40 shrink-0 overflow-hidden rounded-2xl">
                <img
                    alt="Lumina Terminal"
                    className="pointer-events-none absolute inset-0 h-full w-full select-none"
                    loading="lazy"
                    src={Icon}
                />
            </div>

            <Card.Header className="grow">
                <Card.Title className="font-semibold text-lg">{t["Welcome to Lumina Term"]}</Card.Title>
                <Card.Description>
                    {t["Choose some basic settings and create your first profile now!"]}
                </Card.Description>

                <Separator className="my-3"/>

                <Card.Content>
                    <div className="w-full flex flex-row items-center justify-start">
                        <Select
                            value={config.language}
                            variant="secondary"
                            onChange={(value) => {
                                updateConfig({
                                    // @ts-ignore
                                    language: value ?? config.language
                                });
                                info(`Welcome wizard language changed to: ${value}`);
                            }}
                        >
                            <Label>{t["Language"]}</Label>
                            <Select.Trigger>
                                <Select.Value />
                                <Select.Indicator />
                            </Select.Trigger>
                            <Select.Popover>
                                <ListBox>
                                    {[...languageNames.keys()].map((language) => (
                                        <ListBox.Item
                                            id={language}
                                            key={language}
                                            textValue={language}
                                        >
                                            {languageNames.get(language)}
                                        </ListBox.Item>
                                    ))}
                                </ListBox>
                            </Select.Popover>
                        </Select>
                    </div>
                </Card.Content>

                <Card.Footer className="flex justify-end">
                    <Button onClick={onNext}>
                        {t["Next"]}
                    </Button>
                </Card.Footer>
            </Card.Header>
        </Card>
    );
}

function Step2({onNext, onPrev} : {
    onNext: (profile: TerminalProfile) => void;
    onPrev: () => void;
}) {
    const t = useI18n();
    // Render settings (rows/cols/font/…) are deliberately NOT set here: a
    // value written into the profile would silently override the global
    // render options forever after (parseProfile: profile wins), making later
    // global-settings changes look broken. The wizard only captures identity
    // (name/shell/SSH); everything render-related is configured in-app.
    const [profile, setProfile] = useState<TerminalProfile>({
        name: t["Untitled Profile"],
        exePath: "",
        type: "local",
    });
    const [exePathExist, setExePathExist] = useState<boolean>(false);
    const sshConfigEntries = useSshConfig();

    const updateProfile = (updates: Partial<TerminalProfile>) => {
        setProfile(prevState => ({ ...prevState, ...updates }));
    };

    const updateSsh = (updates: Partial<SSHConfig>) => {
        setProfile(prevState => {
            const ssh = { ...prevState.ssh, ...updates } as SSHConfig;
            return { ...prevState, ssh };
        });
    };

    const profileType = profile.type ?? "local";

    const onExePathChange = (value: string) => {
        updateProfile({ exePath: value });
    };

    const onNameChange = (value: string) => {
        updateProfile({ name: value });
    };

    const checkCanNext = useCallback(() => {
        if (!profile.name) return false;
        if (profileType === "remote") {
            return !!(profile.ssh?.host);
        }
        return !!(profile.exePath && exePathExist);
    }, [profile, exePathExist, profileType]);

    const handleNext = useCallback(() => {
        if (checkCanNext()) {
            onNext(profile);
        }
    }, [profile, checkCanNext]);

    useEffect(() => {
        if (profileType === "remote") {
            setExePathExist(true);
            return;
        }
        if (profile.exePath.length === 0) {
            setExePathExist(true);
        } else {
            invoke<boolean>("path_exist", {path: profile.exePath}).then((value) => {
                setExePathExist(value);
            });
        }
    }, [profile.exePath, profileType]);

    return (
        <Card
            data-tauri-drag-region
            className="flex flex-col items-start justify-center gap-5 select-none w-full h-full p-10 rounded-[var(--radius-lg)]"
        >
            <Card.Header>
                <Card.Title className="font-semibold text-lg">{t["New Profile"]}</Card.Title>
            </Card.Header>

            <Card.Content className="w-full">
                <div className="flex flex-col items-start justify-start w-full gap-4">
                    {/* Profile Type — picked first: it decides which of the
                        shell / SSH fields below even apply. */}
                    <div className="flex flex-col gap-1 w-full">
                        <Label>{t["Profile Type"]}</Label>
                        <Select
                            selectedKey={profileType}
                            onSelectionChange={(key) => {
                                const newType = key as "local" | "remote";
                                updateProfile({
                                    type: newType,
                                    ssh: newType === "remote" ? (profile.ssh ?? { host: "", port: 22 }) : undefined,
                                    exePath: newType === "remote" ? "" : profile.exePath,
                                });
                            }}
                        >
                            <Select.Trigger>
                                <Select.Value />
                                <Select.Indicator />
                            </Select.Trigger>
                            <Select.Popover>
                                <ListBox>
                                    <ListBox.Item id="local" key="local" textValue="Local">
                                        {t["Local"]}
                                    </ListBox.Item>
                                    <ListBox.Item id="remote" key="remote" textValue="Remote (SSH)">
                                        {t["Remote (SSH)"]}
                                    </ListBox.Item>
                                </ListBox>
                            </Select.Popover>
                        </Select>
                    </div>

                    <div className="flex flex-col gap-1 w-full">
                        <Label htmlFor="input-name" isRequired>{t["Profile Name"]}</Label>
                        <Input
                            id="input-name" value={profile.name} variant="secondary" required
                            onChange={(e) => onNameChange(e.target.value)}
                        />
                    </div>
                    {profileType === "local" && (
                    <div className="flex flex-col gap-1 w-full">
                        <ShellSelector
                            exePath={profile.exePath}
                            onChange={onExePathChange}
                            idPrefix="input"
                        />
                        <span className="px-1 text-sm text-danger whitespace-pre-wrap">
                            {exePathExist ? " " : t["File not exist"]}
                        </span>
                    </div>
                    )}

                    {/* SSH Config Fields */}
                    {profileType === "remote" && (
                        <div className="flex flex-col gap-3 w-full">
                            {/* Import from .ssh/config */}
                            {sshConfigEntries.length > 0 && (
                                <div className="flex flex-col gap-1">
                                    <Label>{t["Import from SSH Config"]}</Label>
                                    <Select
                                        onSelectionChange={(key) => {
                                            const entry = sshConfigEntries.find(e => e.host === key);
                                            if (entry) {
                                                updateSsh(entry.config);
                                                updateProfile({ name: entry.host });
                                            }
                                        }}
                                    >
                                        <Select.Trigger>
                                            <Select.Value />
                                            <Select.Indicator />
                                        </Select.Trigger>
                                        <Select.Popover>
                                            <ListBox>
                                                {sshConfigEntries.map((entry) => (
                                                    <ListBox.Item
                                                        id={entry.host}
                                                        key={entry.host}
                                                        textValue={entry.host}
                                                    >
                                                        <div className="flex flex-col">
                                                            <span>{entry.host}</span>
                                                            <span className="text-xs text-muted">
                                                                {formatSshAddress(entry.config)}
                                                            </span>
                                                        </div>
                                                    </ListBox.Item>
                                                ))}
                                            </ListBox>
                                        </Select.Popover>
                                    </Select>
                                </div>
                            )}

                            <SshFields
                                ssh={profile.ssh}
                                onChange={updateSsh}
                                idPrefix="wizard"
                            />
                        </div>
                    )}
                </div>
            </Card.Content>
            <Card.Footer className="flex w-full justify-between">
                <Button onClick={onPrev} variant="outline">
                    {t["Previous"]}
                </Button>
                <Button onClick={handleNext} isDisabled={!checkCanNext()}>
                    {t["Next"]}
                </Button>
            </Card.Footer>
        </Card>
    );
}

function FinalStep({onFinish, onPrev, display} : {
    onPrev: () => void;
    onFinish: () => void;
    display: boolean
}) {
    const t = useI18n();

    return (
        <Card
            data-tauri-drag-region
            className="flex flex-col items-center justify-center gap-6 select-none w-full h-full p-10 rounded-[var(--radius-lg)]"
        >
            {display && (
                <Confetti
                    particleCount={200}
                    effectInterval={5000}
                    mode="boom"
                />
            )}

            <Card.Header className="w-full items-center justify-center">
                <Card.Title className="text-xl font-semibold">{t["Lumina Term has prepared"]}</Card.Title>
            </Card.Header>

            <Card.Footer className="flex flex-row items-center justify-center gap-6">
                <Button onClick={onPrev} variant="outline">
                    {t["Previous"]}
                </Button>
                <Button onClick={onFinish}>
                    {t["Start Now"]}
                </Button>
            </Card.Footer>
        </Card>
    );
}

export default function WelcomePage() {
    const containerRef = useRef<HTMLDivElement>(null);
    const totalStep = 3;
    const {newProfile} = useGlobalConfig();
    const [step, setStep] = useState<number>(0);
    const [profile, setProfile] = useState<TerminalProfile | null>(null);

    useEffect(() => {
        const handleResize = () => {
            if (containerRef.current) {
                let width = containerRef.current.clientWidth;
                let height = containerRef.current.clientHeight;
                getCurrentWindow().setResizable(false).then();
                getCurrentWindow().setSize(new LogicalSize(width, height)).then();
            }
        };
        const observer = new ResizeObserver(handleResize);
        if (containerRef.current) {
            observer.observe(containerRef.current);
        }
        return () => {
            observer.disconnect();
        };
    }, []);

    const handleNext = () => {
        const nextStep = Math.min(step + 1, totalStep-1);
        debug(`Welcome wizard: step ${step} -> ${nextStep}`);
        setStep(nextStep);
    }

    const handlePrev = () => {
        const prevStep = Math.max(step - 1, 0);
        debug(`Welcome wizard: step ${step} -> ${prevStep}`);
        setStep(prevStep);
    }

    const handleFinish = useCallback(() => {
        if (profile) {
            info(`Welcome wizard finished with profile: ${profile.name}`);
            const defaultProfile = { ...profile, default: true };
            getCurrentWindow().setResizable(true).then(() => {
                newProfile(defaultProfile);
            });
        }
    }, [profile]);

    return (
        <div
            className="w-200 h-100 overflow-hidden bg-transparent select-none relative"
            ref={containerRef}
        >
            <div
                className="h-full flex flex-row transition-transform duration-500"
                style={{ transform: `translateX(-${step*100/totalStep}%)`, width: `${totalStep*100}%` }}
            >
                <div className="h-full flex items-center justify-center" style={{width: `${100/totalStep}%`}}>
                    <Step1 onNext={handleNext}/>
                </div>
                <div className="h-full flex items-center justify-center" style={{width: `${100/totalStep}%`}}>
                    <Step2 onNext={(p) => {
                        setProfile(p);
                        handleNext();
                    }} onPrev={handlePrev}/>
                </div>
                <div className="h-full flex items-center justify-center" style={{width: `${100/totalStep}%`}}>
                    <FinalStep onFinish={handleFinish} onPrev={handlePrev} display={step+1 === totalStep}/>
                </div>
            </div>
        </div>
    );
}
