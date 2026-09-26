import { type AccountingOutput, agents, type ExtractionOutput, type Term } from "@auditiq/shared";
import type { ReactNode } from "react";
import { Button, Checkbox } from "../../../components/ui.tsx";
import { formatDate } from "../../../lib/format.ts";
import { ClauseChips, FindingRow, PaneEmpty } from "../parts.tsx";
import { useWorkspace } from "../state.tsx";

// The analysis for the current step, split into sections. Findings come first because
// they're what reviewers act on; the rest is the evidence behind them.

type Section = { id: string; label: string; count?: number; render: () => ReactNode };

const obligationLabels = { distinct: "Distinct", combined: "Combined", needs_review: "Needs review" } as const;
const kindLabels = {
  fixed: "Fixed",
  variable: "Variable",
  material_right: "Material right",
  financing: "Financing",
  other: "Other",
} as const;
const patternLabels = {
  over_time: "Over time",
  point_in_time: "Point in time",
  as_usage_occurs: "As usage occurs",
  deferred: "Deferred",
  needs_review: "Needs review",
} as const;
const allocationLabels = { complete: "Complete", partial: "Partial", needs_input: "Needs reviewer input" } as const;

function Item({
  title,
  tag,
  anchorIds,
  children,
}: {
  title: string;
  tag?: string;
  anchorIds?: string[];
  children?: ReactNode;
}) {
  return (
    <div className="border-b border-line px-4 py-2.5">
      <div className="flex items-start gap-2">
        <div className="grow font-semibold">{title}</div>
        {tag && <span className="shrink-0 rounded bg-neutral px-1.5 text-xs text-ink-2">{tag}</span>}
      </div>
      {children && <div className="mt-0.5 text-ink">{children}</div>}
      {anchorIds && anchorIds.length > 0 && (
        <div className="mt-1.5">
          <ClauseChips anchorIds={anchorIds} />
        </div>
      )}
    </div>
  );
}

function Terms({ groups }: { groups: Array<[string, Term[]]> }) {
  return (
    <>
      {groups
        .filter(([, terms]) => terms.length)
        .map(([heading, terms]) => (
          <div key={heading}>
            <div className="bg-sunken px-4 py-1.5 text-xs font-semibold text-ink-2">{heading}</div>
            {terms.map((term, index) => (
              <Item key={`${heading}-${index}`} title={term.label} anchorIds={term.anchorIds}>
                {term.value}
              </Item>
            ))}
          </div>
        ))}
    </>
  );
}

function FindingsSection() {
  const { findings, checked, setChecked } = useWorkspace();
  if (!findings.length) return <PaneEmpty>This step raised no findings.</PaneEmpty>;
  const eligible = findings.filter((f) => f.eligible);
  const allChecked = eligible.length > 0 && eligible.every((f) => checked.has(f.id));
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-2">
        <Checkbox
          label="Select all verified findings"
          checked={allChecked}
          onChange={(on) => {
            const next = new Set(checked);
            for (const f of eligible) {
              if (on) next.add(f.id);
              else next.delete(f.id);
            }
            setChecked(next);
          }}
        />
        <span className="grow text-ink-2">
          {findings.length} findings, {findings.filter((f) => f.jira).length} in Jira
          {findings.length > eligible.length ? `, ${findings.length - eligible.length} held back` : ""}
        </span>
      </div>
      {findings.map((finding) => (
        <FindingRow key={finding.id} finding={finding} />
      ))}
    </>
  );
}

function extractionSections(output: ExtractionOutput): Section[] {
  return [
    { id: "findings", label: "Findings", render: () => <FindingsSection /> },
    {
      id: "terms",
      label: "Terms",
      count: output.terms.length + output.scope.length + output.pricing.length,
      render: () => (
        <Terms
          groups={[
            ["Contract terms", output.terms],
            ["Scope", output.scope],
            ["Pricing and billing", output.pricing],
          ]}
        />
      ),
    },
    {
      id: "obligations",
      label: "Obligations",
      count: output.obligations.length,
      render: () =>
        output.obligations.map((o, index) => (
          <Item key={index} title={o.name} anchorIds={o.anchorIds}>
            {o.recognition}
            {o.note && <div className="text-ink-2">{o.note}</div>}
          </Item>
        )),
    },
    {
      id: "gaps",
      label: "Gaps",
      count: output.gaps.length,
      render: () =>
        output.gaps.length ? (
          output.gaps.map((gap, index) => <Item key={index} title={gap} />)
        ) : (
          <PaneEmpty>The contract covers everything this step looked for.</PaneEmpty>
        ),
    },
    {
      id: "summary",
      label: "Summary",
      render: () => (
        <div className="px-4 py-3">
          <p>{output.summary}</p>
          <dl className="mt-4 grid grid-cols-[140px_1fr] gap-x-3 gap-y-2">
            {(
              [
                ["Contract", output.contract.number],
                ["Title", output.contract.title],
                ["Vendor", output.contract.vendor],
                ["Customer", output.contract.customer],
                ["Effective", formatDate(output.contract.effectiveDate)],
                ["Ends", formatDate(output.contract.endDate)],
                ["Value", output.contract.totalValue],
              ] as const
            )
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-ink-2">{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
          </dl>
        </div>
      ),
    },
  ];
}

function accountingSections(output: AccountingOutput): Section[] {
  return [
    { id: "findings", label: "Findings", render: () => <FindingsSection /> },
    {
      id: "obligations",
      label: "Obligations",
      count: output.obligations.length,
      render: () =>
        output.obligations.map((o, index) => (
          <Item key={index} title={o.name} tag={obligationLabels[o.assessment]} anchorIds={o.anchorIds}>
            {o.conclusion}
            <div className="text-ink-2">{o.rationale}</div>
          </Item>
        )),
    },
    {
      id: "price",
      label: "Price",
      count: output.priceComponents.length,
      render: () =>
        output.priceComponents.map((p, index) => (
          <Item key={index} title={p.name} tag={kindLabels[p.kind]} anchorIds={p.anchorIds}>
            {p.treatment}
          </Item>
        )),
    },
    {
      id: "allocation",
      label: "Allocation",
      render: () => (
        <Item title="Allocation" tag={allocationLabels[output.allocation.status]}>
          {output.allocation.summary}
          {output.allocation.reviewerInput && (
            <div className="mt-2">
              <span className="text-xs font-semibold text-ink-2">Reviewer input needed</span>
              <div>{output.allocation.reviewerInput}</div>
            </div>
          )}
        </Item>
      ),
    },
    {
      id: "recognition",
      label: "Recognition",
      count: output.recognition.length,
      render: () =>
        output.recognition.map((r, index) => (
          <Item key={index} title={r.item} tag={patternLabels[r.pattern]} anchorIds={r.anchorIds}>
            {r.conclusion}
            <div className="text-ink-2">{r.rationale}</div>
          </Item>
        )),
    },
    { id: "summary", label: "Summary", render: () => <p className="px-4 py-3">{output.summary}</p> },
  ];
}

export function AnalysisView() {
  const { contract, step, findings, search, setSearch } = useWorkspace();
  const output = contract.runs[step].output;
  if (!output) return <PaneEmpty>{agents[step].label} hasn't run on this contract yet.</PaneEmpty>;

  const sections =
    step === "extraction"
      ? extractionSections(agents.extraction.output.parse(output))
      : accountingSections(agents.accounting.output.parse(output));
  const active = sections.find((s) => s.id === search.section) ?? sections[0];
  if (!active) return null;

  return (
    <div className="flex min-h-0 grow flex-col">
      <div className="flex shrink-0 flex-wrap gap-1 px-4 pb-2 pt-3">
        {sections.map((section) => (
          <Button
            key={section.id}
            variant={section.id === active.id ? "selected" : "subtle"}
            onClick={() => setSearch({ section: section.id })}
          >
            {section.label}
            <span className={section.id === active.id ? "" : "text-ink-3"}>
              {section.id === "findings" ? findings.length : section.count}
            </span>
          </Button>
        ))}
      </div>
      <div className="min-h-0 grow overflow-auto border-t border-line">{active.render()}</div>
    </div>
  );
}
