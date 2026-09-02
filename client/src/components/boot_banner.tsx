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

/** Rolling download rate → human ETA ("~2 min left"). Samples reset when
 * the total changes (a new artifact started). */
function useEta(status: { loaded?: number; total?: number; unit?: string }): string | null {
  const samples = React.useRef<{ t: number; loaded: number; total: number }[]>([]);
  if (status.unit === "bytes" && status.loaded !== undefined && status.total) {
    const now = performance.now();
    const arr = samples.current;
    if (arr.length && arr[arr.length - 1].total !== status.total) arr.length = 0;
    arr.push({ t: now, loaded: status.loaded, total: status.total });
    while (arr.length > 2 && now - arr[0].t > 6000) arr.shift();
    if (arr.length >= 2) {
      const first = arr[0];
      const rate = (status.loaded - first.loaded) / ((now - first.t) / 1000);
      if (rate > 50000) {
        const secs = (status.total - status.loaded) / rate;
        if (secs >= 90) return `~${Math.round(secs / 60)} min left`;
        if (secs >= 5) return `~${Math.round(secs / 5) * 5} s left`;
        return "almost done";
      }
    }
  } else {
    samples.current.length = 0;
  }
  return null;
}

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

  // Hooks must run unconditionally (calling useEta after the early return
  // crashed with React #310 the moment visibility flipped).
  const eta = useEta(status);

  // Nothing to say before the boot starts or after it finishes.
  if (!visible) return null;

  const progress = formatProgress(status);
  const determinate = status.loaded !== undefined && !!status.total;
  const percent = determinate ? (100 * status.loaded!) / status.total! : 0;
  // Byte-counted progress IS a download (labels vary: "preparing the … environment").
  const downloading = status.unit === "bytes" || /download|unpack|install|preparing the .* environment/i.test(status.label);

  return (
    <div className="lean-boot-banner" role="status">
      <div className="lean-boot-banner-row">
        <span className="lean-boot-banner-label">
          Lean is starting in your browser — {status.label}
          {progress ? ` · ${progress}` : ""}
          {eta ? ` · ${eta}` : ""}
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
