import {useEffect, useState} from "react";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {warn} from "@tauri-apps/plugin-log";

export function useMaximized() {
    const [max, setMax] = useState(false);

    useEffect(() => {
        const resizeHandler = () => {
            getCurrentWindow().isMaximized().then((maximized) => {
                setMax(maximized);
            }).catch((e) => {
                warn(`Failed to read maximize state: ${e}`).catch(() => {});
            });
        };
        resizeHandler();

        window.addEventListener("resize", resizeHandler);

        return () => {
            window.removeEventListener("resize", resizeHandler);
        };
    }, []);

    return max;
}
