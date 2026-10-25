export type Contact = {
  id: string;
  external_id: string | null;
  name: string;
  company: string | null;
  title: string | null;
  industry: string | null;
  relationship_strength: number;
  last_interaction_date: string | null;
  introduction_preferences: string | null;
  enrichment: Enrichment | null;
  enriched_at: string | null;
  last_outreach_at: string | null;
  outreach_snoozed_until: string | null;
  outreach_draft: string | null;
  outreach_draft_mode: "keep_warm" | "reconnect" | "ask" | null;
  /** E.164. Private: only used for the user's own WhatsApp/SMS links, never sent to Claude or Tavily. */
  phone: string | null;
  /** Private, like phone. */
  email: string | null;
};

export type SourcedItem = { text: string; source_url: string; date: string | null };

export type AttributeKind = "expertise" | "sector" | "location" | "stage" | "role" | "affiliation" | "interest";

/** A sourced tag about a contact, extracted from the public web. */
export type Attribute = { kind: AttributeKind; label: string; source_url: string };

/**
 * How one contact fits the rest of the network, computed when they are enriched.
 * `intros` rest on recorded needs and are also saved as opportunities; `ideas` rest only on
 * public-web info and are never saved as opportunities.
 */
export type GoalFit = { level: "strong" | "some" | "none"; why: string };

export type NetworkMap = {
  mapped_at: string;
  /** How directly this person relates to the user's goal. Shown on its own; never part of give_value. */
  goal_fit?: GoalFit;
  intros: {
    direction: "gives" | "receives";
    other_contact_id: string;
    other_name: string;
    need: string;
    why: string;
    give_value: number;
    appropriate: boolean;
  }[];
  ideas: { text: string; other_contact_id: string | null; other_name: string | null }[];
  overlaps: { label: string; contact_ids: string[]; names: string[] }[];
};

/** Public-web context from Tavily + Claude. Unverified; never a stated need. */
export type Enrichment =
  | { status: "no_confident_match"; identity_notes: string; network?: NetworkMap }
  | {
      status: "matched";
      identity_confidence: "high" | "medium";
      identity_notes: string;
      summary: string;
      recent_signals: (SourcedItem & { kind: string })[];
      possible_offers: SourcedItem[];
      sources: { title: string; url: string }[];
      attributes?: Attribute[];
      network?: NetworkMap;
    };

export type Interaction = {
  id: string;
  contact_id: string;
  date: string;
  raw_notes: string;
  context: { summary?: string; uncertainties?: string[] } | null;
  extracted_at: string | null;
};

export type Signal = {
  id: string;
  contact_id: string;
  interaction_id: string;
  type: "need" | "offer";
  category: string;
  description: string;
  supporting_text: string;
  quote_verified: boolean;
  is_inferred: boolean;
  time_sensitive: boolean;
  confidence: number;
  status: "active" | "stale" | "resolved";
  relevant_until: string | null;
};

export type OpportunityStatus = "suggested" | "useful" | "deferred" | "dismissed" | "completed";

export type Opportunity = {
  id: string;
  recipient_contact_id: string;
  proposed_contact_id: string;
  matched_need_id: string;
  matched_offer_id: string | null;
  value_proposition: string;
  why_proposed: string;
  why_now: string | null;
  give_value: number;
  timeliness: number;
  match_confidence: number;
  match_basis: "stated_offer" | "profile_inference";
  appropriate: boolean;
  concerns: string | null;
  missing_evidence: string | null;
  consent_status: "not_requested" | "pending" | "approved" | "declined";
  status: OpportunityStatus;
  deferred_until: string | null;
  draft_message: string | null;
  draft_kind: DraftKind | null;
};

export type DraftKind = "ask_recipient" | "ask_proposed" | "intro";
