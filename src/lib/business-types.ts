/**
 * What kind of business this is, and the words that come with it.
 *
 * Matlock One is one application, not one per trade. A contractor books a Job
 * for a Client, an agency runs a Project for a Client, a shop writes a Repair
 * Order for a Customer — the records underneath are identical, and only the
 * vocabulary differs. So the trade is a preset that fills in labels at signup,
 * not a fork of the product.
 *
 * A preset is a starting point and nothing more. The labels it writes are
 * ordinary columns on the organization, editable afterwards under Settings,
 * and the app only ever reads those columns. Changing type later re-fills them;
 * it never migrates data, because there is no data shaped by the choice.
 *
 * Two deliberate omissions:
 *
 * Invoices and payments keep their names everywhere. "Invoice" is what the tax
 * authority, the bank and the customer's bookkeeper all call it, and renaming
 * it would buy a little familiarity at the cost of the one word in the app
 * that has to mean exactly what it says.
 *
 * There is no "size of business" or "industry" beyond this list. Anything that
 * does not fit picks General, which is the vocabulary the product shipped with.
 */

export type VocabularyLabels = {
  jobSingular: string;
  jobPlural: string;
  clientSingular: string;
  clientPlural: string;
  estimateSingular: string;
  estimatePlural: string;
  leadSingular: string;
  leadPlural: string;
};

export type BusinessType = {
  /** Stored on the organization. Never shown. */
  id: string;
  /** How the choice is offered at signup. */
  name: string;
  /** One line of "is this me?", in the trade's own words. */
  description: string;
  labels: VocabularyLabels;
};

/**
 * Ordered as it is offered. General sits last: it is the fallback for a
 * business that does not see itself above, and reads oddly as the first thing
 * on the list.
 */
export const BUSINESS_TYPES: BusinessType[] = [
  {
    id: "CONTRACTOR",
    name: "Contractor / trades",
    description: "Building, remodeling, electrical, plumbing, HVAC, roofing.",
    labels: {
      jobSingular: "Job",
      jobPlural: "Jobs",
      clientSingular: "Client",
      clientPlural: "Clients",
      estimateSingular: "Estimate",
      estimatePlural: "Estimates",
      leadSingular: "Lead",
      leadPlural: "Leads",
    },
  },
  {
    id: "HOME_SERVICES",
    name: "Home & field services",
    description: "Cleaning, landscaping, pest control, pool, appliance repair.",
    labels: {
      jobSingular: "Work order",
      jobPlural: "Work orders",
      clientSingular: "Customer",
      clientPlural: "Customers",
      estimateSingular: "Quote",
      estimatePlural: "Quotes",
      leadSingular: "Enquiry",
      leadPlural: "Enquiries",
    },
  },
  {
    id: "AUTOMOTIVE",
    name: "Automotive & repair",
    description: "Auto shops, mobile mechanics, equipment and machine repair.",
    labels: {
      jobSingular: "Repair order",
      jobPlural: "Repair orders",
      clientSingular: "Customer",
      clientPlural: "Customers",
      estimateSingular: "Estimate",
      estimatePlural: "Estimates",
      leadSingular: "Enquiry",
      leadPlural: "Enquiries",
    },
  },
  {
    id: "AGENCY",
    name: "Agency & creative",
    description: "Marketing, design, web, video, photography.",
    labels: {
      jobSingular: "Project",
      jobPlural: "Projects",
      clientSingular: "Client",
      clientPlural: "Clients",
      estimateSingular: "Proposal",
      estimatePlural: "Proposals",
      leadSingular: "Opportunity",
      leadPlural: "Opportunities",
    },
  },
  {
    id: "PROFESSIONAL_SERVICES",
    name: "Professional services",
    description: "Consulting, accounting, legal, IT, coaching.",
    labels: {
      jobSingular: "Engagement",
      jobPlural: "Engagements",
      clientSingular: "Client",
      clientPlural: "Clients",
      estimateSingular: "Proposal",
      estimatePlural: "Proposals",
      leadSingular: "Opportunity",
      leadPlural: "Opportunities",
    },
  },
  {
    id: "FREELANCER",
    name: "Freelance / solo",
    description: "One person billing their own time and work.",
    labels: {
      jobSingular: "Project",
      jobPlural: "Projects",
      clientSingular: "Client",
      clientPlural: "Clients",
      estimateSingular: "Quote",
      estimatePlural: "Quotes",
      leadSingular: "Lead",
      leadPlural: "Leads",
    },
  },
  {
    id: "GENERAL",
    name: "Something else",
    description: "The standard vocabulary. Rename anything later in Settings.",
    labels: {
      jobSingular: "Job",
      jobPlural: "Jobs",
      clientSingular: "Client",
      clientPlural: "Clients",
      estimateSingular: "Estimate",
      estimatePlural: "Estimates",
      leadSingular: "Lead",
      leadPlural: "Leads",
    },
  },
];

/**
 * What an unrecognized id falls back to, and the default for a new
 * organization. Its labels match the column defaults in the schema, so an
 * organization created before this existed already sits on it.
 */
export const DEFAULT_BUSINESS_TYPE = "GENERAL";

export function businessType(id: string | null | undefined): BusinessType {
  const found = BUSINESS_TYPES.find((type) => type.id === id);
  if (found) return found;

  // A stored id can outlive the preset that wrote it — a type dropped from
  // this list, or a row written by a newer version and read by an older one.
  // Falling back keeps the page rendering; the labels are on the row anyway.
  return BUSINESS_TYPES.find((type) => type.id === DEFAULT_BUSINESS_TYPE)!;
}

export function isBusinessType(id: string): boolean {
  return BUSINESS_TYPES.some((type) => type.id === id);
}

/**
 * How a preset's words differ from the standard ones, as "projects rather
 * than jobs" pairs.
 *
 * For the line under the picker at signup, which has to say what choosing this
 * will do. Only the differences: a preset that keeps "clients" produced
 * "clients rather than clients", which reads as a bug in the sentence.
 *
 * Plurals only, and the general preset yields nothing at all — it is the
 * baseline being compared against.
 */
export function vocabularyChanges(id: string): { from: string; to: string }[] {
  const chosen = businessType(id).labels;
  const standard = businessType(DEFAULT_BUSINESS_TYPE).labels;
  const plurals = ["jobPlural", "clientPlural", "estimatePlural", "leadPlural"] as const;

  return plurals
    .filter((key) => chosen[key].toLowerCase() !== standard[key].toLowerCase())
    .map((key) => ({
      from: standard[key].toLowerCase(),
      to: chosen[key].toLowerCase(),
    }));
}

/**
 * The preset's labels under the column names they are stored as.
 *
 * Signup writes this straight into the organization row, and the settings form
 * uses it to fill the inputs when somebody switches type.
 */
export function vocabularyColumns(id: string) {
  const { labels } = businessType(id);

  return {
    labelJobSingular: labels.jobSingular,
    labelJobPlural: labels.jobPlural,
    labelClientSingular: labels.clientSingular,
    labelClientPlural: labels.clientPlural,
    labelEstimateSingular: labels.estimateSingular,
    labelEstimatePlural: labels.estimatePlural,
    labelLeadSingular: labels.leadSingular,
    labelLeadPlural: labels.leadPlural,
  };
}
