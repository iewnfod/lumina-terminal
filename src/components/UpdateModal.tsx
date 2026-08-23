import { Modal, Button } from "@heroui/react";
import { Download, LoaderCircle, AlertCircle, Copy, Check, ExternalLink as ExternalLinkIcon } from "lucide-react";
import { ITheme } from "@xterm/xterm";
import { useState } from "react";
import { useI18n } from "../hooks/i18n.tsx";
import { useSurfaceColors } from "../hooks/surfaceColors.ts";
import type { DownloadProgress, UpdateInfo, UpdateStatus } from "../lib/updater.ts";
import type { InstallSource } from "../hooks/useInstallSource.ts";
import Markdown from "./Markdown.tsx";
import ExternalLink from "./ui/ExternalLink.tsx";

interface UpdateModalProps {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
	info: UpdateInfo | null;
	status: UpdateStatus;
	progress: DownloadProgress | null;
	error: string | null;
	onInstall: () => void;
	/**
	 * Detected install source, if this copy is owned by a system package
	 * manager. When set, the in-app download/install is replaced with a
	 * package-manager update hint (Tauri v2's updater only supports AppImage
	 * on Linux, so it cannot update a .deb/pacman-managed install).
	 */
	installSource?: InstallSource | null;
	/** Theme used to derive surface colors (matches the About page treatment). */
	theme: ITheme | null;
}

/**
 * Update-available modal. Surfaced from the sidebar banner and the About page
 * "Install and Restart" action. Shows the new version + release notes and
 * requires an explicit confirm before downloading/installing.
 *
 * Install state (downloading / installing / error) is owned by the shared
 * `useUpdater` instance in App and passed in, so this modal reflects whatever
 * App-level state is current.
 */
/**
 * Derive the package-manager update command for a given install source, or
 * `null` when there is no single canonical command (dpkg/rpm without an apt/dnf
 * repo). pacman → `sudo pacman -Syu <pkg>`; others fall back to a GitHub
 * Releases download hint shown by the caller.
 */
function updateCommandFor(source: InstallSource): string | null {
	switch (source.manager) {
		case "pacman":
			return `sudo pacman -Syu ${source.package}`;
		default:
			// dpkg/rpm: no Lumina apt/dnf repo exists, so there is no one
			// command to give — point the user at GitHub Releases instead.
			return null;
	}
}

export default function UpdateModal({
	isOpen,
	onOpenChange,
	info,
	status,
	progress,
	error,
	onInstall,
	installSource,
	theme,
}: UpdateModalProps) {
	const t = useI18n();
	const bg = theme?.background ?? "#000000";
	const fg = theme?.foreground ?? "#ffffff";
	const colors = useSurfaceColors(bg);

	const installing = status === "downloading" || status === "installing";
	const version = info?.version ?? "";
	// Package-managed installs cannot self-update — show the manager hint and
	// drop the download/install UI entirely.
	const packageManaged = installSource != null;
	const updateCommand = installSource ? updateCommandFor(installSource) : null;
	const [copied, setCopied] = useState(false);

	const copyCommand = (cmd: string) => {
		navigator.clipboard
			.writeText(cmd)
			.then(() => {
				setCopied(true);
				window.setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => {
				// Clipboard can reject (permissions, focused frame, etc.); the
				// command stays selectable so the user can still copy manually.
			});
	};

	return (
		<Modal.Backdrop
			isOpen={isOpen}
			onOpenChange={(open) => {
				// Don't allow closing mid-install (the installer is running).
				if (installing && !open) return;
				onOpenChange(open);
			}}
			isDismissable={!installing}
			variant="blur"
		>
			<Modal.Container placement="center">
				<Modal.Dialog className="sm:max-w-lg w-full">
					<Modal.Header>
						<h2 className="text-lg font-semibold">
							{t["New version available: v{version}"].replace("{version}", version)}
						</h2>
					</Modal.Header>

					<Modal.Body className="max-h-96 overflow-y-auto">
						{info?.body ? (
							<div className="flex flex-col gap-2">
								<span className="text-xs font-medium text-muted uppercase tracking-wider">
									{t["What's New"]}
								</span>
								<div
									className="rounded-[var(--radius-md)] p-3 overflow-y-auto"
									style={{ background: colors.hoverOverlay, color: fg }}
								>
									<Markdown>{info.body}</Markdown>
								</div>
							</div>
						) : (
							<p className="text-sm text-muted">{t["A new version is available"]}</p>
						)}
					</Modal.Body>

					<Modal.Footer className="flex-col items-stretch gap-2">
						{packageManaged ? (
							<>
								{/* Package-manager hint: the in-app updater cannot replace a
									pacman/dpkg/rpm-owned binary, so point the user at the
									correct update command for their manager. */}
								<div
									className="rounded-[var(--radius-md)] p-3 text-xs"
									style={{ background: colors.hoverOverlay, color: fg }}
								>
									<span className="font-medium block mb-1">
										{t["Installed via package manager"].replace(
											"{manager}",
											installSource!.manager,
										)}
									</span>
									<span className="text-muted">
										{t["Package-managed update hint"]}
									</span>
								</div>

								{updateCommand ? (
									<div className="flex flex-col gap-1">
										<span className="text-xs text-muted uppercase tracking-wider">
											{t["Update command"]}
										</span>
										<div
											className="flex items-center gap-2 rounded-[var(--radius-sm)] p-2"
											style={{ background: colors.hoverOverlay }}
										>
											<code
												className="flex-1 text-xs font-mono select-all"
												style={{ color: fg }}
											>
												{updateCommand}
											</code>
											<button
												type="button"
												onClick={() => copyCommand(updateCommand)}
												aria-label={t["Copied"]}
												title={t["Copied"]}
												className="shrink-0 flex items-center justify-center h-7 w-7 rounded transition-colors hover:bg-default/10 text-muted hover:text-current cursor-pointer"
											>
												{copied ? (
													<Check size={14} className="text-success" />
												) : (
													<Copy size={14} />
												)}
											</button>
										</div>
									</div>
								) : (
									<ExternalLink
										href="https://github.com/iewnfod/lumina-terminal/releases/latest"
										className="flex items-center gap-1.5 text-xs hover:underline"
										style={{ color: fg }}
									>
										<ExternalLinkIcon size={14} />
										{t["Download from GitHub Releases"]}
									</ExternalLink>
								)}
							</>
						) : (
							<>
								{/* Download progress bar (shown while downloading/installing) */}
								{installing && (
									<div className="flex flex-col gap-1">
										<span className="text-xs text-muted">
											{status === "installing"
												? t["Installing..."]
												: t["Downloading update..."]}
											{status === "downloading" && progress?.fraction !== undefined
												? ` ${Math.round(progress.fraction * 100)}%`
												: ""}
										</span>
										<div
											className="h-1.5 w-full overflow-hidden rounded-full"
											style={{ background: colors.hoverOverlay }}
										>
											<div
												className="h-full rounded-full transition-[width] duration-150"
												style={{
													width: `${Math.round((progress?.fraction ?? 0) * 100)}%`,
													background: "var(--color-brand-gradient)",
												}}
											/>
										</div>
									</div>
								)}

								{/* Install error */}
									{status === "error" && error && (
										<span
											className="flex items-center gap-1.5 text-xs"
											style={{color: "var(--danger)"}}
										>
											<AlertCircle size={14} />
											{error}
										</span>
									)}
							</>
						)}

						<div className="flex items-center justify-end gap-2">
							<Button
								variant="outline"
								isDisabled={installing}
								onPress={() => onOpenChange(false)}
							>
								{t["Later"]}
							</Button>
							{!packageManaged && (
								<Button
									variant="primary"
									isDisabled={installing || !info}
									onPress={onInstall}
								>
									{installing ? (
										<LoaderCircle size={14} className="animate-spin" />
									) : (
										<Download size={14} />
									)}
									{installing
										? t["Installing..."]
										: t["Update to v{version}"].replace("{version}", version)}
								</Button>
							)}
						</div>
					</Modal.Footer>
				</Modal.Dialog>
			</Modal.Container>
		</Modal.Backdrop>
	);
}
