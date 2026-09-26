const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** "Apr 1, 2026" from an ISO date or timestamp. Returns the input unchanged if it isn't a date. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(date.getTime()) ? value : dateFormat.format(date);
}

/** "2 min ago", "Sep 23", for list columns. */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return "";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "Just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return shortDate.format(new Date(value));
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return "not reported";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function initials(name: string | null | undefined): string {
  return (name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");
}
