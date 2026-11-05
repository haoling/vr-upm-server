import type { BuildStatus } from "@vr-upm/shared";

const LABELS: Record<BuildStatus, string> = {
  queued: "待機中",
  building: "ビルド中",
  ready: "ready",
  published: "published",
  failed: "failed",
};

export function StatusBadge({ status }: { status: BuildStatus }) {
  return <span className={`status ${status}`}>{LABELS[status]}</span>;
}
