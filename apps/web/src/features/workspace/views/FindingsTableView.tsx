import { anchorLabel, topicLabels } from "@auditiq/shared";
import { useEffect } from "react";
import { PriorityIcon } from "../../../components/icons.tsx";
import { Checkbox } from "../../../components/ui.tsx";
import { JiraCell, PaneEmpty } from "../parts.tsx";
import { useWorkspace } from "../state.tsx";

/** Jira-style list of this step's findings. j and k move the selection; x toggles the checkbox. */
export function FindingsTableView() {
  const { findings, selectedFinding, selectFinding, checked, setChecked } = useWorkspace();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]") || event.metaKey || event.ctrlKey) return;
      const index = findings.findIndex((f) => f.id === selectedFinding?.id);
      if (event.key === "j" || event.key === "k") {
        const next = findings[Math.max(0, Math.min(findings.length - 1, index + (event.key === "j" ? 1 : -1)))];
        if (next) selectFinding(next);
      } else if (event.key === "x" && selectedFinding?.eligible) {
        const next = new Set(checked);
        if (next.has(selectedFinding.id)) next.delete(selectedFinding.id);
        else next.add(selectedFinding.id);
        setChecked(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [findings, selectedFinding, selectFinding, checked, setChecked]);

  if (!findings.length) return <PaneEmpty>This step raised no findings.</PaneEmpty>;
  return (
    <div className="min-h-0 grow overflow-auto px-4 pt-2">
      <table className="w-full table-fixed border-collapse">
        <thead>
          <tr className="border-b-2 border-line text-left text-xs font-semibold text-ink-2">
            <th className="w-8 px-2 py-2" />
            <th className="w-8 px-1 py-2">P</th>
            <th className="px-2 py-2">Summary</th>
            <th className="w-[150px] px-2 py-2">Topic</th>
            <th className="w-[72px] px-2 py-2">Section</th>
            <th className="w-[230px] px-2 py-2">Jira</th>
          </tr>
        </thead>
        <tbody>
          {findings.map((finding) => {
            const selected = finding.id === selectedFinding?.id;
            return (
              <tr
                key={finding.id}
                onClick={() => selectFinding(finding)}
                className={`h-10 cursor-pointer border-b border-line ${selected ? "bg-selected" : "hover:bg-sunken"}`}
              >
                <td className="px-2">
                  <Checkbox
                    label={`Select ${finding.title}`}
                    checked={checked.has(finding.id)}
                    disabled={!finding.eligible}
                    onChange={(on) => {
                      const next = new Set(checked);
                      if (on) next.add(finding.id);
                      else next.delete(finding.id);
                      setChecked(next);
                    }}
                  />
                </td>
                <td className="px-1">
                  <PriorityIcon severity={finding.severity} />
                </td>
                <td className={`truncate px-2 ${selected ? "font-semibold" : ""}`} title={finding.title}>
                  {finding.title}
                </td>
                <td className="truncate px-2 text-ink-2">{topicLabels[finding.topic]}</td>
                <td className="truncate px-2">
                  {finding.citations[0] ? anchorLabel(finding.citations[0].anchorId) : ""}
                </td>
                <td className="px-2">
                  <JiraCell finding={finding} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="py-3 text-xs text-ink-3">Keyboard: j and k move, x checks the selected finding.</div>
    </div>
  );
}
