/**
 * Parsed command-line launch flags, returned by the backend `get_cli_args`
 * command (parsed once at startup via clap in `src-tauri/src/cli.rs`). The
 * frontend applies these in `useTerminalManager`'s seed effect to shape the
 * main window's initial tab.
 *
 * Serialized as camelCase by the Rust side (`#[serde(rename_all = "camelCase")]`).
 */
export interface CliArgs {
    /** Command + args to run on startup (Alacritty `-e`). Joined with spaces
     *  and passed as the profile `startupCommand`, so it runs through the
     *  configured shell. Empty array = not given. */
    command: string[];
    /** Working directory to start the shell in (`--working-directory`). */
    workingDirectory?: string;
    /** Window title (`-T, --title`). */
    title?: string;
    /** Keep the terminal open, frozen, after the command exits (`--hold`). */
    hold: boolean;
    /** Name of a configured profile to open (`--profile`, Lumina-specific). */
    profile?: string;
    /** One-shot sidebar visibility for this launch (`--sidebar`,
     *  Lumina-specific). Overrides the `showTabBar` setting WITHOUT
     *  persisting — App holds it as local state until the first explicit
     *  toggle. "show" | "hide"; undefined = follow the setting. */
    sidebar?: "show" | "hide";
}
