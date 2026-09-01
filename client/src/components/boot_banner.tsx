/**
 * Slim persistent banner showing the in-tab Lean runtime's boot progress.
 *
 * The wasm build has real, measurable work between page load and a usable
 * checker (first visit: a ~600 MB kernel+environment download; afterwards a
 * ~10 s cached boot). The server-backed original needs no such affordance —
 * without this the page silently "does nothing" for the whole stretch, which
 * reads as hung. Auto-hides once the checker is ready.
 */
import * as React from "react";
import { useAtom } from "jotai";
import { LinearProgress } from "@mui/material";
import { bootStatusAtom, formatProgress } from "../store/boot-atoms";
import "../css/boot_banner.css";

export function BootBanner() {
  const [status] = useAtom(bootStatusAtom);
  const [everBusy, setEverBusy] = React.useState(false);

  React.useEffect(() => {
    if (status.state === "busy") setEverBusy(true);
  }, [status.state]);

  const visible = status.state === "busy" && everBusy;
  // Reserve layout space while shown: a fixed overlay must not hide page
  // content (it covered the landing footer's Impressum/Privacy links —
  // caught by the cypress suite).
  React.useEffect(() => {
    document.body.classList.toggle("lean-boot-banner-visible", visible);
    return () => document.body.classList.remove("lean-boot-banner-visible");
  }, [visible]);

  // Nothing to say before the boot starts or after it finishes.
  if (!visible) return null;

  const progress = formatProgress(status);
  const determinate = status.loaded !== undefined && !!status.total;
  const percent = determinate ? (100 * status.loaded!) / status.total! : 0;
  const downloading = /download|unpack|install/i.test(status.label);

  return (
    <div className="lean-boot-banner" role="status">
      <div className="lean-boot-banner-row">
        <span className="lean-boot-banner-label">
          Lean is starting in your browser — {status.label}
          {progress ? ` · ${progress}` : ""}
        </span>
        {downloading && (
          <span className="lean-boot-banner-hint">
            first visit downloads once, then it&apos;s cached
          </span>
        )}
      </div>
      <LinearProgress
        variant={determinate ? "determinate" : "indeterminate"}
        value={percent}
      />
    </div>
  );
}
