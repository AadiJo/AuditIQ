import type { Severity } from "@auditiq/shared";

// Jira's own glyphs, so priority and issue type look the same here as in Jira.

const priorityColors: Record<Severity, string> = { high: "#E2483D", medium: "#E09B00", low: "#2F7FE8" };
const priorityPaths: Record<Severity, string> = {
  high: "M3.5 10.25 8 5.75l4.5 4.5",
  medium: "M3.5 6.25h9M3.5 9.75h9",
  low: "M3.5 5.75 8 10.25l4.5-4.5",
};
export const priorityLabels: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };

export function PriorityIcon({ severity, className = "size-4" }: { severity: Severity; className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={`${priorityLabels[severity]} priority`}
    >
      <path
        d={priorityPaths[severity]}
        stroke={priorityColors[severity]}
        strokeWidth="2"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function TaskIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} aria-hidden="true">
      <rect x="1" y="1" width="14" height="14" rx="3" fill="#4BADE8" />
      <path
        d="m4.75 8.25 2.25 2.25 4.25-4.75"
        stroke="#fff"
        strokeWidth="1.75"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ className = "size-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`shrink-0 ${className}`} aria-hidden="true">
      <rect width="24" height="24" rx="5" fill="#1C2B41" />
      <g transform="translate(4 4)">
        <path d="M4.25 2.25h5l2.5 2.5v9h-7.5z" stroke="#fff" strokeWidth="1.3" fill="none" strokeLinejoin="round" />
        <path
          d="m6 9.25 1.4 1.4 2.6-2.9"
          stroke="#57D9A3"
          strokeWidth="1.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
}
