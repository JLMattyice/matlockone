/**
 * Moves one business out of a desktop install's SQLite file and into a
 * business on the hosted database. The command-line wrapper is
 * scripts/import-desktop.ts; everything here is free of I/O except through the
 * reader and the Prisma client it is handed, so the whole path can be tested
 * against two SQLite files.
 *
 * Why this exists: an install that held a business before 0.3.0 stays local
 * forever (see launchMode in electron/runtime.js), so its owner can end up
 * with the real business on one PC and an empty online account everywhere
 * else, both on the same email.
 *
 * What it does, in order:
 *
 * - Row ids are kept. They are cuids, so they cannot collide with anything
 *   online, and keeping them keeps every reference between records intact —
 *   including the ones held in plain text, like an audit entry's entityId.
 * - The business id and people's ids are remapped: records land in the online
 *   business, and anything a person made is credited to the online account
 *   with the same email. A teammate with no online account yet is created with
 *   their existing password, unless that email already signs in elsewhere.
 * - The table list and every link between tables come from prisma/schema.prisma,
 *   so a model added later is copied without anyone remembering to add it
 *   here. Only the deliberate exclusions below are named.
 */

/** What can be said about one field, read off the Prisma schema. */
export type FieldInfo = {
  name: string;
  type: string;
  optional: boolean;
  list: boolean;
  /** For a relation: the scalar fields on this side that hold the link. */
  relationFields?: string[];
};

export type ModelInfo = {
  name: string;
  fields: Map<string, FieldInfo>;
};

export type Schema = Map<string, ModelInfo>;

/**
 * Tables that are never copied, and what to tell the person about each.
 *
 * Organization and User are handled on their own. The rest either belong to
 * the machine (sessions, rate limits), would act on their own if copied
 * (queued emails would send, an auto-pay record would charge), or hold secrets
 * encrypted with the desktop install's own key, which the website cannot read.
 */
export const EXCLUDED: Record<string, string> = {
  Organization: "the business itself is the online one; its profile is copied separately",
  User: "people are matched by email",
  Session: "sign-ins belong to the computer",
  RateLimit: "belongs to the computer",
  Purchase: "licence sales are not part of a business",
  OutboxMessage: "email history; anything still waiting to send on the PC is not sent",
  Integration:
    "saved mail and payment settings are encrypted with the PC's own key; enter them again under Settings",
  AutopaySubscription: "auto-pay has to be set up again online",
  Notification: "old alerts",
  WorkflowRun: "automation history",
  Attachment: "the files themselves are on the PC; upload them again",
  MessageAttachment: "the files themselves are on the PC; upload them again",
};

/**
 * The business's own settings, copied onto the online business.
 *
 * Not the slug (the online one keeps its own), not the licence (online pays by
 * subscription), and none of the billing fields — the online business keeps
 * whatever it already pays with.
 */
export const PROFILE_FIELDS = [
  "name",
  "legalName",
  "email",
  "phone",
  "website",
  "addressLine1",
  "addressLine2",
  "city",
  "state",
  "postalCode",
  "country",
  "logoUrl",
  "primaryColor",
  "accentColor",
  "currency",
  "locale",
  "timeZone",
  "businessType",
  "labelJobSingular",
  "labelJobPlural",
  "labelClientSingular",
  "labelClientPlural",
  "labelEstimateSingular",
  "labelEstimatePlural",
  "labelLeadSingular",
  "labelLeadPlural",
  "defaultTaxRateBp",
  "invoicePrefix",
  "invoiceNextNumber",
  "estimatePrefix",
  "estimateNextNumber",
  "jobPrefix",
  "jobNextNumber",
  "defaultPaymentTermsDays",
  "defaultEstimateValidDays",
  "invoiceFooter",
  "estimateFooter",
] as const;

/** Counters, where the online value wins if it is already further along. */
const NEXT_NUMBER_FIELDS = new Set(["invoiceNextNumber", "estimateNextNumber", "jobNextNumber"]);

/**
 * Reads models, their fields and their relations out of a Prisma schema.
 *
 * The schema is written to be portable between Postgres and SQLite (no enums,
 * no Json, no native types), so a line reader is enough: one field per line,
 * `name Type[]? attributes`.
 */
export function parseSchema(text: string): Schema {
  const blocks = [...text.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const modelNames = new Set(blocks.map((b) => b[1]));
  const schema: Schema = new Map();

  for (const [, name, body] of blocks) {
    const fields = new Map<string, FieldInfo>();
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const match = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/);
      if (!match) continue;
      const [, fieldName, type, list, optional, rest] = match;
      const field: FieldInfo = { name: fieldName, type, optional: !!optional, list: !!list };
      if (modelNames.has(type)) {
        const links = rest.match(/fields:\s*\[([^\]]*)\]/);
        if (links) field.relationFields = links[1].split(",").map((s) => s.trim());
      }
      fields.set(fieldName, field);
    }
    schema.set(name, { name, fields });
  }
  return schema;
}

export function isScalar(schema: Schema, field: FieldInfo) {
  return !schema.has(field.type);
}

/** Every link from `model` to another table: scalar field -> target model. */
export function foreignKeys(schema: Schema, model: string): Map<string, { target: string; optional: boolean }> {
  const out = new Map<string, { target: string; optional: boolean }>();
  for (const field of schema.get(model)!.fields.values()) {
    if (!field.relationFields) continue;
    if (field.relationFields.length !== 1) {
      throw new Error(`${model}.${field.name} links through several fields; the importer does not handle that.`);
    }
    out.set(field.relationFields[0], { target: field.type, optional: field.optional });
  }
  return out;
}

/**
 * The order to insert tables in, so each row's links already exist.
 *
 * People and the business are remapped rather than inserted, and a table's
 * link to itself is filled in afterwards, so neither counts. If two tables
 * still point at each other, an optional link is picked to fill in afterwards
 * instead; both are returned.
 */
export function insertOrder(schema: Schema, models: string[]) {
  const included = new Set(models);
  const deferred = new Set<string>(); // "Model.field"
  const edges = new Map<string, Map<string, { target: string; optional: boolean }>>();

  for (const model of models) {
    const deps = new Map<string, { target: string; optional: boolean }>();
    for (const [fk, link] of foreignKeys(schema, model)) {
      if (link.target === model) {
        deferred.add(`${model}.${fk}`);
        continue;
      }
      if (included.has(link.target)) deps.set(fk, link);
    }
    edges.set(model, deps);
  }

  const order: string[] = [];
  const remaining = new Set(models);
  while (remaining.size) {
    const ready = [...remaining].filter((m) =>
      [...edges.get(m)!.values()].every((l) => !remaining.has(l.target)),
    );
    if (ready.length) {
      for (const m of ready.sort()) {
        order.push(m);
        remaining.delete(m);
      }
      continue;
    }
    // A cycle. Break it at an optional link and fill that link in later.
    let broken = false;
    for (const m of [...remaining].sort()) {
      for (const [fk, link] of edges.get(m)!) {
        if (link.optional && remaining.has(link.target)) {
          edges.get(m)!.delete(fk);
          deferred.add(`${m}.${fk}`);
          broken = true;
          break;
        }
      }
      if (broken) break;
    }
    if (!broken) throw new Error(`These tables require each other: ${[...remaining].join(", ")}`);
  }
  return { order, deferred };
}

/**
 * One stored SQLite value as the online database expects it.
 *
 * Only the types the portable schema allows. Prisma's SQLite adapter writes
 * dates as ISO text, but a number is read as epoch milliseconds in case an
 * older build stored one.
 */
export function convertValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "DateTime": {
      if (typeof value === "number" || typeof value === "bigint") return new Date(Number(value));
      if (typeof value === "string" && /^\d+$/.test(value)) return new Date(Number(value));
      const date = new Date(String(value));
      if (Number.isNaN(date.getTime())) throw new Error(`Not a date: ${String(value)}`);
      return date;
    }
    case "Boolean":
      return value === 1 || value === "1" || value === true || value === "true";
    case "Int":
      return Number(value);
    case "Float":
      return Number(value);
    default:
      return typeof value === "string" ? value : String(value);
  }
}

export type Row = Record<string, unknown>;

/** Read access to the desktop file. */
export type SourceReader = {
  /** Column names, or null when the table does not exist in this file. */
  columns(table: string): string[] | null;
  rows(table: string, where?: { column: string; value: string }): Row[];
};

export type UserDecision =
  | { sourceId: string; email: string; action: "match"; targetId: string }
  | { sourceId: string; email: string; action: "create"; row: Row }
  | { sourceId: string; email: string; action: "drop"; reason: string };

/**
 * What happens to each person in the desktop business.
 *
 * Emails are compared lowercased; sign-up and every email field store them
 * that way. `takenElsewhere` is the set of emails that already sign in to some
 * other online business: those people cannot be created (one email, one
 * account), so whatever they made is kept but credited to nobody.
 */
export function decideUsers(
  sourceUsers: Row[],
  targetUsers: { id: string; email: string }[],
  takenElsewhere: Set<string>,
): UserDecision[] {
  const online = new Map(targetUsers.map((u) => [u.email.toLowerCase(), u.id]));
  return sourceUsers.map((user) => {
    const sourceId = String(user.id);
    const email = String(user.email).trim().toLowerCase();
    const targetId = online.get(email);
    if (targetId) return { sourceId, email, action: "match", targetId };
    if (takenElsewhere.has(email)) {
      return { sourceId, email, action: "drop", reason: "that email already signs in to another online business" };
    }
    return { sourceId, email, action: "create", row: user };
  });
}

export type Batch = { model: string; rows: Row[] };
export type Deferred = { model: string; id: string; field: string; value: string };

export type Plan = {
  batches: Batch[];
  deferred: Deferred[];
  profile: Row;
  /** Tables left out on purpose, with how many rows each held. */
  excluded: { model: string; count: number; reason: string }[];
  /** Links that pointed at something not being copied, so were emptied. */
  cleared: { model: string; field: string; count: number }[];
  /** Rows that could not be copied because a link they need is missing. */
  dropped: { model: string; count: number; reason: string }[];
};

/**
 * Works out every row to write, without writing anything.
 *
 * The same plan is what the dry run prints and what applyPlan() writes, so
 * what the person approves is exactly what happens.
 */
export function buildPlan(options: {
  schema: Schema;
  source: SourceReader;
  sourceOrgId: string;
  targetOrgId: string;
  users: UserDecision[];
  targetProfile: Row;
}): Plan {
  const { schema, source, sourceOrgId, targetOrgId, users, targetProfile } = options;

  const userMap = new Map<string, string>();
  for (const u of users) {
    if (u.action === "match") userMap.set(u.sourceId, u.targetId);
    if (u.action === "create") userMap.set(u.sourceId, u.sourceId);
  }

  const plan: Plan = { batches: [], deferred: [], profile: {}, excluded: [], cleared: [], dropped: [] };

  // People first: rows elsewhere may credit them.
  const newUsers = users.filter((u): u is Extract<UserDecision, { action: "create" }> => u.action === "create");
  if (newUsers.length) {
    plan.batches.push({
      model: "User",
      rows: newUsers.map((u) => ({ ...scalarData(schema, "User", source.columns("User") ?? [], u.row), organizationId: targetOrgId })),
    });
  }

  for (const [model, reason] of Object.entries(EXCLUDED)) {
    if (model === "Organization" || model === "User") continue;
    // Only tables that say which business a row is for can be counted.
    const cols = source.columns(model);
    if (!cols?.includes("organizationId")) continue;
    const count = source.rows(model, { column: "organizationId", value: sourceOrgId }).length;
    if (count) plan.excluded.push({ model, count, reason });
  }

  const candidates = [...schema.keys()].filter((m) => !(m in EXCLUDED));
  const { order, deferred } = insertOrder(schema, candidates);
  const copied = new Map<string, Set<string>>();

  for (const model of order) {
    const cols = source.columns(model);
    if (!cols) continue; // An older desktop file that predates this table.

    const fks = foreignKeys(schema, model);
    const hasOrg = cols.includes("organizationId") && fks.get("organizationId")?.target === "Organization";

    let rows: Row[];
    if (hasOrg) {
      rows = source.rows(model, { column: "organizationId", value: sourceOrgId });
    } else {
      // A child table (invoice lines, job assignments…): its rows belong to the
      // business through a required link to something already copied.
      const parents = [...fks].filter(([, l]) => !l.optional && copied.has(l.target));
      if (!parents.length) continue;
      rows = source
        .rows(model)
        .filter((r) => parents.some(([fk, l]) => copied.get(l.target)!.has(String(r[fk]))));
    }
    if (!rows.length) continue;

    const ids = new Set<string>();
    const out: Row[] = [];
    const cleared = new Map<string, number>();
    const dropped = new Map<string, number>();

    for (const row of rows) {
      const data = scalarData(schema, model, cols, row);
      let keep = true;

      for (const [fk, link] of fks) {
        if (!(fk in data)) continue;
        const value = data[fk];
        if (link.target === "Organization") {
          data[fk] = targetOrgId;
          continue;
        }
        if (value === null) continue;
        const id = String(value);

        if (link.target === "User") {
          const mapped = userMap.get(id);
          if (mapped) data[fk] = mapped;
          else if (link.optional) {
            data[fk] = null;
            cleared.set(fk, (cleared.get(fk) ?? 0) + 1);
          } else {
            keep = false;
            const why = `needs a person (${fk}) who is not moving`;
            dropped.set(why, (dropped.get(why) ?? 0) + 1);
          }
          continue;
        }

        if (deferred.has(`${model}.${fk}`)) {
          // Filled in once every row exists; checked against what was copied then.
          data[fk] = null;
          plan.deferred.push({ model, id: String(row.id), field: fk, value: id });
          continue;
        }

        if (copied.get(link.target)?.has(id)) continue;
        if (link.optional) {
          data[fk] = null;
          cleared.set(fk, (cleared.get(fk) ?? 0) + 1);
        } else {
          keep = false;
          const why = `links to a ${link.target} that is not being copied`;
          dropped.set(why, (dropped.get(why) ?? 0) + 1);
        }
      }

      if (!keep) continue;
      out.push(data);
      ids.add(String(row.id));
    }

    copied.set(model, ids);
    if (out.length) plan.batches.push({ model, rows: out });
    for (const [field, count] of cleared) plan.cleared.push({ model, field, count });
    for (const [reason, count] of dropped) plan.dropped.push({ model, count, reason });
  }

  // Deferred links survive only if what they point at was copied.
  plan.deferred = plan.deferred.filter((d) => {
    const target = foreignKeys(schema, d.model).get(d.field)!.target;
    const ok = copied.get(target)?.has(d.value) ?? false;
    if (!ok) plan.cleared.push({ model: d.model, field: d.field, count: 1 });
    return ok;
  });
  // A deferred row that was itself dropped has nothing to update.
  plan.deferred = plan.deferred.filter((d) => copied.get(d.model)?.has(d.id));

  plan.profile = profileUpdate(schema, source, sourceOrgId, targetProfile);
  return plan;
}

/** The scalar columns of a row that the online schema also has, converted. */
function scalarData(schema: Schema, model: string, columns: string[], row: Row): Row {
  const info = schema.get(model)!;
  const data: Row = {};
  for (const column of columns) {
    const field = info.fields.get(column);
    if (!field || !isScalar(schema, field) || field.list) continue;
    const value = convertValue(field.type, row[column]);
    // Leave a missing required value to the online default rather than
    // writing a null the column refuses.
    if (value === null && !field.optional) continue;
    data[column] = value;
  }
  return data;
}

function profileUpdate(schema: Schema, source: SourceReader, sourceOrgId: string, target: Row): Row {
  const cols = source.columns("Organization") ?? [];
  const [org] = source.rows("Organization", { column: "id", value: sourceOrgId });
  const data = scalarData(schema, "Organization", cols, org);
  const update: Row = {};
  for (const field of PROFILE_FIELDS) {
    if (!(field in data)) continue;
    let value = data[field];
    // A logo saved on the PC is a path the website cannot serve.
    if (field === "logoUrl" && value !== null && !/^https?:\/\//i.test(String(value))) continue;
    if (NEXT_NUMBER_FIELDS.has(field)) value = Math.max(Number(value), Number(target[field] ?? 0));
    if (value !== target[field]) update[field] = value;
  }
  return update;
}

/** The subset of a Prisma client the importer writes through. */
export type Writer = Record<string, unknown>;

function delegate(tx: Writer, model: string) {
  const d = tx[model[0].toLowerCase() + model.slice(1)] as {
    createMany(args: { data: Row[] }): Promise<{ count: number }>;
    update(args: { where: { id: string }; data: Row }): Promise<unknown>;
  };
  if (!d) throw new Error(`No Prisma model called ${model}`);
  return d;
}

/**
 * Writes a plan. Call inside one transaction so a failure part-way leaves the
 * online business exactly as it was.
 */
export async function applyPlan(tx: Writer, plan: Plan, targetOrgId: string) {
  const written: Record<string, number> = {};
  for (const batch of plan.batches) {
    const { count } = await delegate(tx, batch.model).createMany({ data: batch.rows });
    written[batch.model] = count;
  }
  for (const d of plan.deferred) {
    await delegate(tx, d.model).update({ where: { id: d.id }, data: { [d.field]: d.value } });
  }
  if (Object.keys(plan.profile).length) {
    await delegate(tx, "Organization").update({ where: { id: targetOrgId }, data: plan.profile });
  }
  return written;
}
