import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  useEffect,
  useRef,
} from "react";
import { initials } from "../lib/format.ts";

// The small component set AuditIQ is built from. Styles follow Atlassian's components:
// neutral-filled default buttons, blue primary, 4px radius, 32px controls.

type ButtonVariant = "default" | "primary" | "subtle" | "selected" | "danger";
const buttonVariants: Record<ButtonVariant, string> = {
  default: "bg-neutral text-ink hover:bg-neutral-hover",
  primary: "bg-brand text-white hover:bg-brand-hover",
  subtle: "bg-transparent text-ink-2 hover:bg-neutral",
  selected: "bg-selected text-brand",
  danger: "bg-danger text-white hover:brightness-95",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; icon?: boolean }
>(function Button({ variant = "default", icon = false, className = "", type = "button", ...props }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded font-medium disabled:cursor-not-allowed disabled:opacity-50 ${icon ? "w-8" : "px-3"} ${buttonVariants[variant]} ${className}`}
      {...props}
    />
  );
});

const lozengeStyles = {
  new: "bg-[#DFE1E6] text-[#42526E]",
  indeterminate: "bg-[#DEEBFF] text-[#0747A6]",
  done: "bg-[#E3FCEF] text-[#006644]",
} as const;

/** A Jira status, colored by Jira's status category so it matches what people see in Jira. */
export function Lozenge({ status, category }: { status: string; category: string | null }) {
  const style = lozengeStyles[(category ?? "new") as keyof typeof lozengeStyles] ?? lozengeStyles.new;
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-[3px] px-1 text-[11px] font-bold uppercase leading-4 ${style}`}
    >
      {status}
    </span>
  );
}

const avatarColors = ["#5E4DB2", "#1F845A", "#C25100", "#0055CC", "#AE2E24", "#206A83"];

export function Avatar({ name, size = "md" }: { name: string | null | undefined; size?: "sm" | "md" }) {
  const dimension = size === "sm" ? "size-5 text-[9px]" : "size-6 text-[10px]";
  if (!name) return <span className={`inline-block shrink-0 rounded-full bg-line ${dimension}`} title="Unassigned" />;
  const color = avatarColors[[...name].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % avatarColors.length];
  return (
    <span
      title={name}
      className={`inline-grid shrink-0 place-items-center rounded-full font-bold text-white ${dimension}`}
      style={{ backgroundColor: color }}
    >
      {initials(name)}
    </span>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      onClick={(event) => event.stopPropagation()}
      className="size-3.5 shrink-0 cursor-pointer accent-brand disabled:cursor-not-allowed"
    />
  );
}

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextField(
  { className = "", ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={`h-9 w-full rounded border border-line-input bg-white px-2.5 text-ink placeholder:text-ink-4 disabled:bg-neutral ${className}`}
      {...props}
    />
  );
});

export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-9 w-full rounded border border-line-input bg-white px-2 text-ink disabled:bg-neutral ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: callers pass the control as children.
    <label className="mt-4 block">
      <span className="mb-1 block text-xs font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-ink-3">{hint}</span>}
    </label>
  );
}

const messageStyles = {
  info: { box: "bg-selected", icon: <Info className="mt-0.5 size-4 shrink-0 text-brand" /> },
  success: { box: "bg-ok-bg", icon: <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" /> },
  warning: { box: "bg-warn-bg", icon: <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" /> },
  error: { box: "bg-danger-bg", icon: <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" /> },
};

export function SectionMessage({
  tone,
  title,
  children,
}: {
  tone: keyof typeof messageStyles;
  title?: string;
  children?: ReactNode;
}) {
  const style = messageStyles[tone];
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`flex gap-3 rounded px-4 py-3 ${style.box}`}>
      {style.icon}
      <div className="min-w-0">
        {title && <div className="font-semibold">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/** A modal built on <dialog>, so focus trapping and Escape come from the browser. */
export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-[480px] max-w-[calc(100vw-32px)] rounded-md p-0 text-ink shadow-[0_8px_12px_rgba(30,31,33,0.15),0_0_1px_rgba(30,31,33,0.31)] backdrop:bg-[#0515244d]"
    >
      <div className="flex items-center gap-2 px-6 pb-2 pt-5">
        <h2 className="grow text-lg font-semibold">{title}</h2>
        <Button variant="subtle" icon aria-label="Close" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div className="px-6 py-2">{children}</div>
      <div className="flex justify-end gap-2 px-6 pb-5 pt-4">{footer}</div>
    </dialog>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-sm px-6 py-16 text-center">
      <div className="font-semibold">{title}</div>
      {children && <div className="mt-1 text-ink-2">{children}</div>}
    </div>
  );
}
