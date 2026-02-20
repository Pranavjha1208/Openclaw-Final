import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MongoClient, ObjectId } from "mongodb";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// ---------------------------------------------------------------------------
// Persistent connection (reused across tool calls for the gateway lifetime)
// ---------------------------------------------------------------------------

let cachedClient: MongoClient | null = null;

async function getClient(uri: string): Promise<MongoClient> {
  if (cachedClient) {
    return cachedClient;
  }
  cachedClient = new MongoClient(uri);
  await cachedClient.connect();
  return cachedClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeObjectId(id: string): ObjectId | string {
  try {
    return new ObjectId(id);
  } catch {
    return id;
  }
}

function parseJsonParam(raw: unknown, label: string): Record<string, unknown> {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  throw new Error(`${label} must be a JSON object`);
}

const ISO_DATE_STRING = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** Recursively convert ISO date strings in a filter to Date so MongoDB date comparison works. */
function convertFilterDateStrings(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && ISO_DATE_STRING.test(v)) {
      out[k] = new Date(v);
    } else if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      out[k] = convertFilterDateStrings(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Schema description embedded in tool descriptions so the LLM knows the shape
// ---------------------------------------------------------------------------

const SCHEMA_DESCRIPTION = `
The d_leads collection stores real-estate lead records. Each document has these fields:
- _id: ObjectId (MongoDB auto-generated)
- user_id: string (owner user ID)
- org_id: string (organization ID, e.g. "ORG_5OB7E2DP")
- lead_id: string (unique lead identifier, e.g. "lead_fe4f5b0d-...")
- lead_name: string (lead display name)
- lead_phone_no: string (phone number with country code, e.g. "919204292878")
- lead_status: string (one of: "New", "Contacted", "Qualified", "Converted", "Lost", etc.)
- whatsapp_reachout_status: string ("not_contacted", "contacted", "replied", etc.)
- whatsapp_message_count: number (total WhatsApp messages sent)
- call_reachout_status: string ("not_called", "called", "connected", etc.)
- call_attempt_count: number (total call attempts)
- call_connected_count: number (successful call connections)
- created_at: Date (ISO date when lead was created)
- updated_at: Date (ISO date when lead was last updated)
- lead_data: object with sub-fields:
  - occupation: string|null
  - budget: number|string|null (often stored as number in rupees, e.g. 800000. For "above 8 lakhs" use filter={"budgetMinLakhs":8}; it becomes lead_data.budget >= 800000.)
  - property_type: string|null
  - property_subtype: string|null
  - bhk: string|null
  - location: string|null
  - timeline: string|null
- call_attempt: number
- whatsapp_attempt: number
- campaign_id: string (campaign identifier, e.g. "campaign_5eb87a1b-...")
`.trim();

const CONTEXT_AND_ADVANCED_FILTERS = `
Context and advanced filters (interpret user intent and combine conditions):
- "This year" / "from January" → use created_at with $gte "2026-01-01T00:00:00.000Z" (use current year if different).
- "January 2026" only → $gte "2026-01-01T00:00:00.000Z" and $lt "2026-02-01T00:00:00.000Z".
- Date range: {"created_at":{"$gte":"YYYY-MM-DDT00:00:00.000Z","$lte":"YYYY-MM-DDT23:59:59.999Z"}}.
- Combine conditions with $and: {"$and":[{"lead_status":"New"},{"created_at":{"$gte":"2026-01-01T00:00:00.000Z"}}]}.
- Either/or with $or: {"$or":[{"lead_status":"New"},{"lead_status":"Contacted"}]}.
- Text search (case-insensitive): {"lead_name":{"$regex":"searchterm","$options":"i"}} or in lead_data: {"lead_data.location":{"$regex":"Mumbai","$options":"i"}}.
- Not contacted and from this year: {"$and":[{"whatsapp_reachout_status":"not_contacted"},{"created_at":{"$gte":"2026-01-01T00:00:00.000Z"}}]}.
- Budget range (e.g. "above 8 lakhs"): use budgetMinLakhs and/or budgetMaxLakhs; they are converted to lead_data.budget in rupees (8 lakhs → 800000). Example: filter={"budgetMinLakhs":8} produces lead_data.budget >= 800000.
- All ISO date strings in filters are auto-converted to ISODate; use "YYYY-MM-DDTHH:mm:ss.sssZ" format.
`.trim();

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

// Generic labels in tool descriptions.
const DESC_DATABASE = "the configured database";
const COLLECTION_LIST =
  "d_leads (default), d_org, d_user, d_campaign, d_reachoutflow, f_call_records";

// All collections in the dev database. No delete tool is exposed; dev DB is read/insert/update only.
const ALLOWED_COLLECTIONS = [
  "d_leads",
  "d_org",
  "d_user",
  "d_campaign",
  "d_reachoutflow",
  "f_call_records",
];

function resolveCollection(defaultCol: string, paramCol: unknown): string {
  const col = (paramCol as string)?.trim() || defaultCol;
  if (!ALLOWED_COLLECTIONS.includes(col)) {
    throw new Error(`Invalid collection "${col}". Allowed: ${ALLOWED_COLLECTIONS.join(", ")}.`);
  }
  return col;
}

/** Extract budgetMinLakhs/budgetMaxLakhs from filter and merge as lead_data.budget range in rupees (e.g. 8 lakhs → 800000). Budget is compared as number; use filter={"budgetMinLakhs":8} for "above 8 lakhs". */
function applyBudgetRangeToFilter(filter: Record<string, unknown>): Record<string, unknown> {
  const { budgetMinLakhs, budgetMaxLakhs, ...rest } = filter;
  const minL = budgetMinLakhs != null ? Number(budgetMinLakhs) : null;
  const maxL = budgetMaxLakhs != null ? Number(budgetMaxLakhs) : null;
  const minRupees = minL != null && !Number.isNaN(minL) ? minL * 100_000 : null;
  const maxRupees = maxL != null && !Number.isNaN(maxL) ? maxL * 100_000 : null;
  if (minRupees == null && maxRupees == null) {
    return rest;
  }
  const budgetCond: Record<string, unknown> =
    typeof rest["lead_data.budget"] === "object" &&
    rest["lead_data.budget"] !== null &&
    !Array.isArray(rest["lead_data.budget"])
      ? { ...(rest["lead_data.budget"] as Record<string, unknown>) }
      : {};
  if (minRupees != null) budgetCond.$gte = minRupees;
  if (maxRupees != null) budgetCond.$lte = maxRupees;
  return { ...rest, "lead_data.budget": budgetCond };
}

function createMongoTools(uri: string, dbName: string, defaultCollection: string): AnyAgentTool[] {
  // ------ mongo_find ------
  const findTool: AnyAgentTool = {
    name: "mongo_find",
    label: "MongoDB Find",
    description: `Query documents from a collection in MongoDB database ${DESC_DATABASE}. Collections: ${COLLECTION_LIST}. ${SCHEMA_DESCRIPTION}

Use filter to narrow results (MongoDB query syntax). Use projection to select specific fields. Use sort, skip, limit to paginate.
Common queries:
- All new leads: filter={"lead_status":"New"}
- Leads not contacted on WhatsApp: filter={"whatsapp_reachout_status":"not_contacted"}
- Leads by org: filter={"org_id":"ORG_5OB7E2DP"}
- Leads by phone: filter={"lead_phone_no":"919204292878"}
- Search by name pattern: filter={"lead_name":{"$regex":"john","$options":"i"}}
- Newest leads first: sort={"created_at":-1}
- Leads from January 2026 onward: filter={"created_at":{"$gte":"2026-01-01T00:00:00.000Z"}} (ISO date strings are auto-converted to ISODate)

${CONTEXT_AND_ADVANCED_FILTERS}`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for d_leads.`,
        },
        filter: {
          type: "object",
          description:
            'MongoDB query filter. For created_at/updated_at use ISO strings (auto-converted to ISODate). For "budget above 8 lakhs" use filter={"budgetMinLakhs":8}; for range use budgetMinLakhs and/or budgetMaxLakhs (converted to rupees internally). Do NOT use regex on lead_data.budget. Other examples: {"lead_status":"New"}, {"lead_phone_no":"919204292878"}, {"lead_name":{"$regex":"john","$options":"i"}}',
          additionalProperties: true,
        },
        projection: {
          type: "object",
          description:
            'Fields to include/exclude. Example: {"lead_name":1,"lead_phone_no":1,"lead_status":1,"_id":0}',
          additionalProperties: true,
        },
        sort: {
          type: "object",
          description:
            'Sort order. Example: {"created_at":-1} for newest first, {"updated_at":-1} for recently updated',
          additionalProperties: true,
        },
        limit: {
          type: "number",
          description:
            "Max documents to return (default: 20, max: 500). For exporting ALL leads to CSV, use the mongo_export_csv tool instead.",
        },
        skip: {
          type: "number",
          description: "Number of documents to skip (for pagination)",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const col = resolveCollection(defaultCollection, params.collection);
      const rawFilter = parseJsonParam(params.filter, "filter");
      const filter = convertFilterDateStrings(applyBudgetRangeToFilter(rawFilter));
      const projection = parseJsonParam(params.projection, "projection");
      const sort = parseJsonParam(params.sort, "sort");
      const limit = Math.min(Number(params.limit) || 20, 500);
      const skip = Number(params.skip) || 0;

      const client = await getClient(uri);
      const db = client.db(dbName);
      const docs = await db
        .collection(col)
        .find(filter, { projection })
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .toArray();

      return jsonResult({ count: docs.length, documents: docs });
    },
  };

  // ------ mongo_insert ------
  const insertTool: AnyAgentTool = {
    name: "mongo_insert",
    label: "MongoDB Insert",
    description: `Insert one or more documents into a collection in MongoDB database ${DESC_DATABASE}. Collections: ${COLLECTION_LIST}. ${SCHEMA_DESCRIPTION}

When inserting a new lead, include at minimum: user_id, org_id, lead_id, lead_name, lead_phone_no, lead_status ("New"), whatsapp_reachout_status ("not_contacted"), call_reachout_status ("not_called"), created_at (current ISO date), updated_at (current ISO date). Set numeric counters to 0. Set lead_data sub-fields to null if unknown.`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for d_leads.`,
        },
        document: {
          type: "object",
          description: "A single document to insert",
          additionalProperties: true,
        },
        documents: {
          type: "string",
          description:
            "JSON array of documents to insert (for bulk insert). Use this OR document, not both.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const col = resolveCollection(defaultCollection, params.collection);
      const client = await getClient(uri);
      const db = client.db(dbName);

      if (params.documents) {
        const rawDocs =
          typeof params.documents === "string" ? JSON.parse(params.documents) : params.documents;
        if (!Array.isArray(rawDocs)) {
          throw new Error("documents must be a JSON array");
        }
        const result = await db.collection(col).insertMany(rawDocs);
        return jsonResult({
          inserted: result.insertedCount,
          insertedIds: result.insertedIds,
        });
      }

      const doc = parseJsonParam(params.document, "document");
      if (Object.keys(doc).length === 0) {
        throw new Error("document is required and must not be empty");
      }
      const result = await db.collection(col).insertOne(doc);
      return jsonResult({ insertedId: result.insertedId });
    },
  };

  // ------ mongo_update ------
  const updateTool: AnyAgentTool = {
    name: "mongo_update",
    label: "MongoDB Update",
    description: `Update documents in a collection in MongoDB database ${DESC_DATABASE}. Collections: ${COLLECTION_LIST}. ${SCHEMA_DESCRIPTION}

Provide a filter to match leads and an update object. Use $set to change fields, $inc to increment counters, $unset to remove fields.
Common updates:
- Mark lead contacted: {"$set":{"lead_status":"Contacted","whatsapp_reachout_status":"contacted","updated_at":{"$date":"..."}}}
- Increment WhatsApp count: {"$inc":{"whatsapp_message_count":1,"whatsapp_attempt":1}}
- Update lead data: {"$set":{"lead_data.budget":"50L","lead_data.location":"Mumbai"}}
- Mark call connected: {"$set":{"call_reachout_status":"connected"},"$inc":{"call_attempt_count":1,"call_connected_count":1}}
Always set updated_at to current date when modifying a lead. By default updates one document; set updateMany=true for bulk updates.`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for d_leads.`,
        },
        filter: {
          type: "object",
          description:
            'Filter to match documents. Examples: {"lead_id":"lead_fe4f5b0d-..."}, {"lead_phone_no":"919204292878"}, {"org_id":"ORG_..."}',
          additionalProperties: true,
        },
        update: {
          type: "object",
          description:
            'MongoDB update operators. Examples: {"$set":{"lead_status":"Contacted","updated_at":new Date()}}, {"$inc":{"whatsapp_message_count":1}}, {"$set":{"lead_data.budget":"50L"}}',
          additionalProperties: true,
        },
        updateMany: {
          type: "boolean",
          description: "If true, update all matching documents instead of just the first one",
        },
      },
      required: ["filter", "update"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const col = resolveCollection(defaultCollection, params.collection);
      const filter = convertFilterDateStrings(parseJsonParam(params.filter, "filter"));
      const update = parseJsonParam(params.update, "update");

      if (Object.keys(filter).length === 0) {
        throw new Error("filter is required to prevent accidental full-collection updates");
      }
      if (Object.keys(update).length === 0) {
        throw new Error("update object is required");
      }

      // Auto-wrap plain field updates in $set if no operator keys present
      const hasOperator = Object.keys(update).some((k) => k.startsWith("$"));
      const mongoUpdate = hasOperator ? update : { $set: update };

      // Expand string _id to ObjectId in filter
      if (typeof filter._id === "string") {
        filter._id = safeObjectId(filter._id);
      }

      const client = await getClient(uri);
      const db = client.db(dbName);

      if (params.updateMany) {
        const result = await db.collection(col).updateMany(filter, mongoUpdate);
        return jsonResult({
          matchedCount: result.matchedCount,
          modifiedCount: result.modifiedCount,
        });
      }
      const result = await db.collection(col).updateOne(filter, mongoUpdate);
      return jsonResult({
        matchedCount: result.matchedCount,
        modifiedCount: result.modifiedCount,
      });
    },
  };

  // ------ mongo_count ------
  const countTool: AnyAgentTool = {
    name: "mongo_count",
    label: "MongoDB Count",
    description: `Count documents in a collection in MongoDB database ${DESC_DATABASE}. Collections: ${COLLECTION_LIST}. Optionally provide a filter. Use ISO date strings for created_at/updated_at; they are auto-converted to ISODate.

${CONTEXT_AND_ADVANCED_FILTERS}`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for d_leads.`,
        },
        filter: {
          type: "object",
          description:
            'Optional filter. For "budget above 8 lakhs" use {"budgetMinLakhs":8}; do NOT use regex on lead_data.budget. Examples: {"lead_status":"New"}, {"org_id":"ORG_..."}',
          additionalProperties: true,
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const col = resolveCollection(defaultCollection, params.collection);
      const rawFilter = parseJsonParam(params.filter, "filter");
      const filter = convertFilterDateStrings(applyBudgetRangeToFilter(rawFilter));

      const client = await getClient(uri);
      const db = client.db(dbName);
      const count = await db.collection(col).countDocuments(filter);
      return jsonResult({ count });
    },
  };

  // ------ mongo_aggregate ------
  const aggregateTool: AnyAgentTool = {
    name: "mongo_aggregate",
    label: "MongoDB Aggregate",
    description: `Run an aggregation pipeline on a collection in MongoDB database ${DESC_DATABASE}. Collections: ${COLLECTION_LIST}.
Common aggregations:
- Leads by status: [{"$group":{"_id":"$lead_status","count":{"$sum":1}}}]
- Leads by org: [{"$group":{"_id":"$org_id","count":{"$sum":1}}}]
- Leads by campaign: [{"$group":{"_id":"$campaign_id","count":{"$sum":1}}}]
- WhatsApp contacted vs not: [{"$group":{"_id":"$whatsapp_reachout_status","count":{"$sum":1}}}]
- Leads created per day: [{"$group":{"_id":{"$dateToString":{"format":"%Y-%m-%d","date":"$created_at"}},"count":{"$sum":1}}},{"$sort":{"_id":-1}}]
- Average call attempts: [{"$group":{"_id":null,"avgCalls":{"$avg":"$call_attempt_count"},"totalLeads":{"$sum":1}}}]
- For budget range (e.g. "above 8 lakhs") use mongo_find/mongo_export_csv with filter={"budgetMinLakhs":8} (converted to lead_data.budget >= 800000).`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for d_leads.`,
        },
        pipeline: {
          type: "string",
          description:
            'JSON array of aggregation stages. Example: [{"$group":{"_id":"$lead_status","count":{"$sum":1}}}]',
        },
      },
      required: ["pipeline"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const col = resolveCollection(defaultCollection, params.collection);
      const rawPipeline =
        typeof params.pipeline === "string" ? JSON.parse(params.pipeline) : params.pipeline;

      if (!Array.isArray(rawPipeline)) {
        throw new Error("pipeline must be a JSON array of aggregation stages");
      }

      // Convert ISO date strings to Date in any $match stage so date comparison works
      const pipeline = rawPipeline.map((stage: Record<string, unknown>) => {
        const match = stage?.$match;
        if (match !== null && typeof match === "object" && !Array.isArray(match)) {
          return { ...stage, $match: convertFilterDateStrings(match as Record<string, unknown>) };
        }
        return stage;
      });

      const client = await getClient(uri);
      const db = client.db(dbName);
      const results = await db.collection(col).aggregate(pipeline).toArray();

      return jsonResult({ count: results.length, results });
    },
  };

  // ------ mongo_export_csv ------
  const exportCsvTool: AnyAgentTool = {
    name: "mongo_export_csv",
    label: "MongoDB Export CSV",
    description: `Export ALL matching documents from a collection to a CSV file. Collections: ${COLLECTION_LIST}. This tool has NO row limit — it fetches every matching document and writes a proper CSV file to disk. Use this when the user asks for an Excel/CSV/spreadsheet export of leads. Returns the file path. After exporting, if the user wants the file in chat: call send_file_to_chat with that filePath (and a caption), then call the message tool with action sendAttachment and media set to the filePath so the file is delivered in Telegram/WhatsApp. Optionally provide a filter to export only matching leads, and fields to select which columns to include.

${CONTEXT_AND_ADVANCED_FILTERS}`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for d_leads.`,
        },
        filter: {
          type: "object",
          description:
            'Optional filter. For "budget above 8 lakhs" use {"budgetMinLakhs":8}. Do NOT use regex on lead_data.budget. Use ISO date strings for dates. Omit or {} for all documents.',
          additionalProperties: true,
        },
        fields: {
          type: "string",
          description:
            'Comma-separated list of fields to include as CSV columns. Default: "lead_id,lead_name,lead_phone_no,lead_status,whatsapp_reachout_status,whatsapp_message_count,call_reachout_status,call_attempt_count,call_connected_count,created_at,updated_at,org_id,campaign_id,lead_data.occupation,lead_data.budget,lead_data.property_type,lead_data.bhk,lead_data.location,lead_data.timeline"',
        },
        sort: {
          type: "object",
          description: 'Sort order. Default: {"created_at":-1} (newest first)',
          additionalProperties: true,
        },
        filename: {
          type: "string",
          description:
            "Output filename (default: leads_export.csv). Saved to the workspace directory.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const col = resolveCollection(defaultCollection, params.collection);
      const rawFilter = parseJsonParam(params.filter, "filter");
      const filter = convertFilterDateStrings(applyBudgetRangeToFilter(rawFilter));
      const sort = parseJsonParam(params.sort, "sort");
      const sortFinal = Object.keys(sort).length > 0 ? sort : { created_at: -1 };
      const filename = (params.filename as string) || "leads_export.csv";

      const defaultFields = [
        "lead_id",
        "lead_name",
        "lead_phone_no",
        "lead_status",
        "whatsapp_reachout_status",
        "whatsapp_message_count",
        "call_reachout_status",
        "call_attempt_count",
        "call_connected_count",
        "created_at",
        "updated_at",
        "org_id",
        "campaign_id",
        "lead_data.occupation",
        "lead_data.budget",
        "lead_data.property_type",
        "lead_data.bhk",
        "lead_data.location",
        "lead_data.timeline",
      ];

      const fields =
        typeof params.fields === "string"
          ? params.fields
              .split(",")
              .map((f) => f.trim())
              .filter(Boolean)
          : defaultFields;

      const client = await getClient(uri);
      const db = client.db(dbName);
      const docs = await db.collection(col).find(filter).sort(sortFinal).toArray();

      // Resolve nested field value (e.g. "lead_data.budget")
      function getNestedValue(obj: Record<string, unknown>, fieldPath: string): string {
        const parts = fieldPath.split(".");
        let current: unknown = obj;
        for (const part of parts) {
          if (current === null || current === undefined || typeof current !== "object") {
            return "";
          }
          current = (current as Record<string, unknown>)[part];
        }
        if (current === null || current === undefined) {
          return "";
        }
        if (current instanceof Date) {
          return current.toISOString();
        }
        if (typeof current === "object") {
          // Handle MongoDB $date objects
          const dateObj = current as Record<string, unknown>;
          if (dateObj.$date) {
            return String(dateObj.$date);
          }
          return JSON.stringify(current);
        }
        return String(current);
      }

      function escapeCsvField(value: string): string {
        if (value.includes(",") || value.includes('"') || value.includes("\n")) {
          return `"${value.replace(/"/g, '""')}"`;
        }
        return value;
      }

      const header = fields.map(escapeCsvField).join(",");
      const rows = docs.map((doc) =>
        fields
          .map((f) => escapeCsvField(getNestedValue(doc as Record<string, unknown>, f)))
          .join(","),
      );

      const csv = [header, ...rows].join("\n");

      // Write to workspace (OpenClaw canvas dir or home dir)
      const homeDir = os.homedir();
      const openclawDir = path.join(homeDir, ".openclaw");
      const workspaceDir = path.join(openclawDir, "workspace");
      if (!fs.existsSync(workspaceDir)) {
        fs.mkdirSync(workspaceDir, { recursive: true });
      }
      const filePath = path.join(workspaceDir, filename);
      fs.writeFileSync(filePath, csv, "utf-8");

      return jsonResult({
        exported: docs.length,
        fields: fields.length,
        filePath,
        filename,
        sizeBytes: Buffer.byteLength(csv, "utf-8"),
        message: `Exported ${docs.length} leads to ${filePath}`,
        sendToChatInstruction:
          "To send this file to the user in the current chat (Telegram/WhatsApp etc), call the message tool with action sendAttachment, media set to the filePath above, and message set to a short caption (e.g. 'Here is your leads export.'). Do that so the user receives the file.",
        messageToolParams: {
          action: "sendAttachment",
          media: filePath,
          message: `Leads export (${docs.length} rows).`,
        },
      });
    },
  };

  // ------ send_file_to_chat ------
  const workspaceDir = path.join(os.homedir(), ".openclaw", "workspace");

  const sendFileToChatTool: AnyAgentTool = {
    name: "send_file_to_chat",
    label: "Send file to chat",
    description: `Send a file that is already on disk (e.g. a CSV exported by mongo_export_csv) to the user in the current chat. The file must be under the OpenClaw workspace directory (~/.openclaw/workspace). Use this when the user asked for an Excel/CSV and you have already exported it — pass the filePath returned by mongo_export_csv and a short caption. You MUST then call the message tool with action sendAttachment, media set to the returned filePath, and message set to the caption, so the file is delivered in Telegram/WhatsApp/etc.`,
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description:
            "Full path to the file (e.g. /Users/you/.openclaw/workspace/all_leads_export.csv). Must be under ~/.openclaw/workspace.",
        },
        caption: {
          type: "string",
          description: "Short caption to send with the file (e.g. 'Here is your leads export').",
        },
      },
      required: ["filePath"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const rawPath = (params.filePath as string)?.trim();
      if (!rawPath) {
        throw new Error("filePath is required");
      }
      const resolvedPath = path.resolve(
        rawPath.startsWith("~") ? rawPath.replace("~", os.homedir()) : rawPath,
      );
      const resolvedWorkspace = path.resolve(workspaceDir);
      if (
        resolvedPath !== resolvedWorkspace &&
        !resolvedPath.startsWith(resolvedWorkspace + path.sep)
      ) {
        throw new Error(
          `File must be under the workspace directory (${resolvedWorkspace}). Got: ${resolvedPath}`,
        );
      }
      if (!fs.existsSync(resolvedPath)) {
        throw new Error(`File not found: ${resolvedPath}`);
      }
      const stat = fs.statSync(resolvedPath);
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${resolvedPath}`);
      }
      const caption = (params.caption as string)?.trim() || "File attached.";

      return jsonResult({
        success: true,
        filePath: resolvedPath,
        caption,
        sizeBytes: stat.size,
        instruction:
          "Now call the message tool with action sendAttachment, media set to the filePath above, and message set to the caption above. That will deliver the file to the user in the current chat.",
        messageToolParams: {
          action: "sendAttachment",
          media: resolvedPath,
          message: caption,
        },
      });
    },
  };

  return [
    findTool,
    insertTool,
    updateTool,
    countTool,
    aggregateTool,
    exportCsvTool,
    sendFileToChatTool,
  ];
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const MONGO_URI =
  "mongodb+srv://fixitaiwhatsappagent:Automate%402025@fixit-whatsapp-agent.mongocluster.cosmos.azure.com/?tls=true&authMechanism=SCRAM-SHA-256&retrywrites=false&maxIdleTimeMS=120000";
const DB_NAME = "fixit_whatsapp_agent_dev";
const DEFAULT_COLLECTION = "d_leads";

const mongodbPlugin = {
  id: "mongodb",
  name: "MongoDB CRUD",
  description:
    "Provides mongo_find, mongo_insert, mongo_update, mongo_count, mongo_aggregate, mongo_export_csv, and send_file_to_chat. No delete tool — dev database is read/insert/update only.",

  register(api: OpenClawPluginApi) {
    // Allow overriding via plugin config; fall back to hardcoded defaults
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const uri = (pluginCfg.uri as string) || MONGO_URI;
    const dbName = (pluginCfg.database as string) || DB_NAME;
    const collection = (pluginCfg.collection as string) || DEFAULT_COLLECTION;

    api.registerTool(() => createMongoTools(uri, dbName, collection), {
      names: [
        "mongo_find",
        "mongo_insert",
        "mongo_update",
        "mongo_count",
        "mongo_aggregate",
        "mongo_export_csv",
        "send_file_to_chat",
      ],
    });

    // Graceful shutdown: close connection when gateway stops
    api.on("gateway_stop", async () => {
      if (cachedClient) {
        try {
          await cachedClient.close();
        } catch {
          // ignore close errors on shutdown
        }
        cachedClient = null;
      }
    });

    api.logger.info(`MongoDB plugin configured: db="${dbName}", collection="${collection}"`);
  },
};

export default mongodbPlugin;
