import { formatBytes } from "./format";

export type FileStatus = "waiting" | "uploading" | "retrying" | "done" | "failed" | "paused";

export interface FileProgress {
  name: string;
  size: number;
  sent: number;
  status: FileStatus;
}

export const STATUS_LABEL: Record<FileStatus, string> = {
  waiting: "Waiting",
  uploading: "Uploading",
  retrying: "Retrying…",
  done: "Done",
  failed: "Failed",
  paused: "Paused",
};

/** How far one file has got, 0 to 1. */
export function fileFraction(file: FileProgress): number {
  return file.size ? file.sent / file.size : file.status === "done" ? 1 : 0;
}

/** "Uploading · 50%", or just "Done". */
export function fileStatusText(file: FileProgress): string {
  const percent = file.status !== "done" && file.size > 0 ? ` · ${Math.floor(fileFraction(file) * 100)}%` : "";
  return STATUS_LABEL[file.status] + percent;
}

/*
 * The dial is a large circle, mostly off the left edge, with one dot per file
 * in upload order. Each file owns the stretch of arc that ends at its dot.
 * The arc fills up to a fixed marker at three o'clock, and the files turn
 * past it as their bytes arrive: finished files above, waiting files below.
 */
const WIDTH = 200;
const HEIGHT = 288;
const RADIUS = 250;
const CX = 150 - RADIUS;
const CY = HEIGHT / 2;
const STEP = 17;
/** Dots further than this from the marker are off the visible arc. */
const VISIBLE = 44;

function point(degrees: number, radius = RADIUS): [number, number] {
  const a = (degrees * Math.PI) / 180;
  return [CX + radius * Math.cos(a), CY + radius * Math.sin(a)];
}

function arc(from: number, to: number): string {
  const [x1, y1] = point(from);
  const [x2, y2] = point(to);
  return `M ${x1} ${y1} A ${RADIUS} ${RADIUS} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}

/** The file to describe: one that's moving, else one that stopped, else the next or the last. */
function currentFile(progress: FileProgress[]): FileProgress | undefined {
  return (
    progress.find((file) => file.status === "uploading" || file.status === "retrying") ??
    progress.find((file) => file.status === "failed") ??
    progress.find((file) => file.status !== "done") ??
    progress.at(-1)
  );
}

export function UploadDial({ progress, stopped }: { progress: FileProgress[]; stopped: boolean }) {
  const total = progress.reduce((sum, file) => sum + file.size, 0);
  const sent = progress.reduce((sum, file) => sum + file.sent, 0);
  const fraction = total ? sent / total : progress.every((file) => file.status === "done") ? 1 : 0;
  const percent = Math.floor(fraction * 100);
  // Files' worth uploaded, so the dial turns at the pace of the queue.
  const position = progress.reduce((sum, file) => sum + fileFraction(file), 0);
  const angleOf = (i: number) => (i + 1 - position) * STEP;
  const fillFrom = Math.max(-position * STEP, -VISIBLE - STEP);
  const current = currentFile(progress);
  const currentFraction = current ? fileFraction(current) : 0;
  const ring = 2 * Math.PI * 15;

  return (
    <div className="sheet-section dial" data-stopped={stopped || undefined}>
      <h2 className="visually-hidden">{stopped ? "Upload stopped" : "Uploading"}</h2>
      <svg
        className="dial-arc"
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="progressbar"
        aria-label="Overall progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <circle className="dial-track" cx={CX} cy={CY} r={RADIUS} />
        {fillFrom < 0 && <path className="dial-fill" d={arc(fillFrom, 0)} />}
        {progress.map((file, i) => {
          const angle = angleOf(i);
          if (Math.abs(angle) > VISIBLE) return null;
          const [x, y] = point(angle);
          const [nx, ny] = point(angle, RADIUS + 30);
          return (
            <g key={i} data-status={file.status}>
              <circle className="dial-dot" cx={x} cy={y} r={file.status === "done" ? 3 : 2.5} />
              {Math.abs(angle) > STEP * 0.6 && (
                <text
                  className="dial-number"
                  x={nx}
                  y={ny}
                  transform={`rotate(${angle} ${nx} ${ny})`}
                  style={{ opacity: Math.max(0.12, 0.55 - Math.abs(angle) / 90) }}
                >
                  {String(i + 1).padStart(2, "0")}
                </text>
              )}
            </g>
          );
        })}
        <circle className="dial-marker" cx={CX + RADIUS} cy={CY} r={4.5} />
      </svg>

      <div className="dial-readout">
        <div className="dial-overall">
          <span className="dial-percent">
            {percent}
            <span className="dial-percent-sign">%</span>
          </span>
          <span className="dial-bytes">
            {formatBytes(sent)} of {formatBytes(total)}
          </span>
        </div>
        {current && (
          <div className="dial-current" data-status={current.status}>
            <svg className="dial-ring" viewBox="0 0 36 36" aria-hidden="true">
              <circle className="dial-ring-track" cx="18" cy="18" r="15" />
              <circle
                className="dial-ring-fill"
                cx="18"
                cy="18"
                r="15"
                strokeDasharray={ring}
                strokeDashoffset={ring * (1 - currentFraction)}
              />
            </svg>
            <div className="dial-current-text">
              <strong>{current.name}</strong>
              <span>
                {fileStatusText(current)}
                {progress.length > 1 && `, file ${progress.indexOf(current) + 1} of ${progress.length}`}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
