import { z } from "zod";

// ASC 606 topics a finding can belong to. The topic is part of a finding's identity, so
// renaming an id here splits existing findings from their Jira issues. Add, don't rename.
export const topicIds = [
  "contract_existence",
  "contract_modification",
  "performance_obligations",
  "material_rights",
  "variable_consideration",
  "significant_financing",
  "consideration_payable",
  "noncash_consideration",
  "allocation",
  "recognition_timing",
  "transfer_of_control",
  "principal_agent",
  "licensing",
  "contract_term",
  "contract_costs",
  "warranties",
  "other",
] as const;

export const Topic = z.enum(topicIds);
export type Topic = z.infer<typeof Topic>;

export const topicLabels: Record<Topic, string> = {
  contract_existence: "Contract existence",
  contract_modification: "Contract combination and modification",
  performance_obligations: "Performance obligations",
  material_rights: "Material rights",
  variable_consideration: "Variable consideration",
  significant_financing: "Significant financing",
  consideration_payable: "Consideration payable to the customer",
  noncash_consideration: "Noncash consideration",
  allocation: "Standalone selling price and allocation",
  recognition_timing: "Timing of recognition",
  transfer_of_control: "Transfer of control and acceptance",
  principal_agent: "Principal versus agent",
  licensing: "Licenses of intellectual property",
  contract_term: "Contract term and termination",
  contract_costs: "Contract costs",
  warranties: "Warranties",
  other: "Other",
};

export const Severity = z.enum(["high", "medium", "low"]);
export type Severity = z.infer<typeof Severity>;

export const severityRank: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
