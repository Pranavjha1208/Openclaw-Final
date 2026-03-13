import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MongoClient, ObjectId, type Sort } from "mongodb";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { transliterate } from "transliteration";
import * as XLSX from "xlsx";

/** Allow Latin letters, digits, space, and common punctuation for names/email. Strip everything else so only English is stored. */
const LATIN_SAFE_RE = /[^\x20-\x7E\u00A0-\u024F]/g;

/** Normalize lead text fields to English (Latin) only. Transliterates e.g. Hindi/Devanagari to Latin, then strips any remaining non-Latin. */
function normalizeToEnglish(value: string | undefined | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) return "";
  try {
    const transliterated = transliterate(trimmed, { trim: true, unknown: "" });
    return transliterated.replace(LATIN_SAFE_RE, "").replace(/\s+/g, " ").trim();
  } catch {
    return trimmed.replace(LATIN_SAFE_RE, "").replace(/\s+/g, " ").trim();
  }
}

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

const DEFAULT_SERVER_SELECTION_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

export type MongoClientOptions = {
  serverSelectionTimeoutMS?: number;
  connectTimeoutMS?: number;
};

async function getClient(uri: string, options?: MongoClientOptions): Promise<MongoClient> {
  if (cachedClient) {
    return cachedClient;
  }
  const serverSelectionTimeoutMS =
    options?.serverSelectionTimeoutMS ?? DEFAULT_SERVER_SELECTION_TIMEOUT_MS;
  const connectTimeoutMS = options?.connectTimeoutMS ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS,
    connectTimeoutMS,
  });
  try {
    await client.connect();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/timed out|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/i.test(msg)) {
      throw new Error(
        `${msg} If this gateway runs on AWS/another cloud, add this server's outbound IP to your database firewall (e.g. Azure Cosmos DB → Networking → Firewall). You can also set plugins.mongodb.serverSelectionTimeoutMS / connectTimeoutMS in config.`,
      );
    }
    throw err;
  }
  cachedClient = client;
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
Lead data is split across collections; join on lead_id for a full lead view.
IMPORTANT: Always present results in clear, natural language. Summarize counts, names, and key details in a readable way. Never dump raw JSON to the user.

== PRIMARY LEAD COLLECTIONS (join on lead_id) ==

d_lead (default): Core identity.
  Fields: _id, lead_id (String, unique), user_id (String), org_id (String), lead_name (String), lead_phone_no (String), lead_email (String), lead_company (String), lead_country (String), campaign_id (String), prospect_token, lead_token, created_at (DateTime), updated_at (DateTime).

f_lead_status: Lead lifecycle status and extracted lead_data. Join: lead_id (unique).
  Fields: lead_id, lead_data (Dict — keys: occupation, budget, property_type, bhk, location, timeline), lead_status (String — values often stored LOWERCASE in DB: "new", "contacted", "qualified", "converted", "lost"), lead_heat_score (String — values: "Hot", "Warm", "Cold"), comments (String), lead_summary (Dict), reachout_step_count (Int), current_batch_id, lead_enriched_data (Dict), status_description (String), last_interaction (DateTime), has_visited_site (Boolean), excel_batch_id (String), created_at, updated_at.
  NOTE: lead_status, lead_heat_score, lead_data.budget, lead_data.location all live HERE, not in d_lead. When matching lead_status use lowercase (e.g. "qualified" not "Qualified") or case-insensitive regex.

f_lead_call: Call metrics per lead. Join: lead_id (unique).
  Fields: lead_id, call_attempt_count (Int), call_connected_count (Int), call_reachout_status (String — values: "not_contacted", "contacted", "connected"), last_call_attempted_at (DateTime), last_call_duration_seconds (Int), first_call_attempted_at (DateTime), last_call_connected_at (DateTime), is_call_in_progress (Boolean), created_at, updated_at.
  NOTE: Pick rate is NOT stored here. To compute pick rate, use call_connected_count / call_attempt_count. For calling number pick rates, query c_calling_number instead.

f_lead_whatsapp: WhatsApp metrics per lead. Join: lead_id (unique).
  Fields: lead_id, whatsapp_message_count (Int), whatsapp_attempt (Int), whatsapp_reachout_status (String — values: "not_contacted", "contacted", "replied"), whatsapp_status_description (String), whatsapp_first_message_sent_at (DateTime), whatsapp_last_reply_at (DateTime), whatsapp_last_message_sent_at (DateTime), failed_template_count (Int), is_template_sending_disabled (Boolean), created_at, updated_at.

d_lead_crm: CRM dimension per lead. Join: lead_id (unique).
  Fields: lead_id, prospect_token, lead_token, opportunity_ref_id (String), crm_data (Dict), created_at, updated_at.

== ORGANIZATION & USER COLLECTIONS ==

d_org: Organization master.
  Fields: org_id (String, unique), org_name (String), email (String), phone (String), org_status (String — values: "Active", "Inactive", "Suspended"), plan (Reference to d_plan), plan_start_date (DateTime), plan_end_date (DateTime), is_plan_expired (Boolean), is_free_trial (Boolean), lead_count (Int), followup_count (Int), subscription_id (String), subscription_status (String — values: "active", "pending", "halted", "cancelled", "paused", "expired"), gupshup_integration_status (String — values: "not_setup", "active", "not_verified", "not_active"), custom_url, custom_company_name, created_at, updated_at.
  IMPORTANT: "is plan expired" → use is_plan_expired (Boolean). "subscription status" → use subscription_status (String enum). These are DIFFERENT fields.

d_user: User accounts.
  Fields: user_id (String, unique), phone_number (String, unique), name (String), state (String), country (String), user_status (String — values: "Active", "Dead", "Inactive"), role (String — values: "super_user", "user", "admin"), org (Reference to d_org), gst_number, nurturing_agent_number, created_at, updated_at.

d_campaign: Campaign config.
  Fields: campaign_id (String, unique), campaign_name (String), user_id (String), org_id (String), is_active (Boolean), telecom_call_category (String), control_table (Dict — keys: calling, whatsapp), campaign_referral_id, created_at, updated_at.

d_plan: Subscription plans.
  Fields: plan_id (String, unique), name (String), lead_limit (Int), followup_limit (Int), price (Float), plan_timeline (String — values: "monthly", "quarterly", "yearly"), is_active (Boolean), currency (String — "INR"/"USD"), created_at, updated_at.

== CALL & TELEPHONY COLLECTIONS ==

c_calling_number: Calling numbers with pick rate tracking.
  Fields: caller_id (String, unique), telephony_name (String), country_code (String), org_id (String), status (String — "Active"/"Inactive"), total_attempts (Int), pick_rate (Float, 0.0–1.0), baseline_rate (Float), telecom_call_category (String), call_history (Dict), created_at, updated_at.
  NOTE: This is WHERE pick_rate for calling numbers lives. To find numbers with pick rate below 50%: filter={"pick_rate":{"$lt":0.5}}.

f_call_records: Individual call records.
  Fields: call_sid (String), stream_sid (String), lead_id (String), org_id (String), lead_phone_no (String), telephony_name (String), recording_url (String), call_category (String), batch_id (String), call_started (DateTime), call_ended (DateTime), call_duration_seconds (Int), conversation_transcript (List of Dict), total_user_messages (Int), total_assistant_messages (Int), interruption_count (Int), created_at, updated_at.

== OTHER COLLECTIONS ==

d_payments: Payment records. Fields: payment_id (unique), order_id, org_id (Ref d_org), plan_id (Ref d_plan), amount (Float), amount_in_rupees (Float), currency, payment_status (String — "created"/"authorized"/"captured"/"failed"/"refunded"/"cancelled"/"pending"), payment_method (String — "card"/"upi"/"bank_transfer"/"netbanking"/"wallet"/"emi"/"paylater"), payment_date (DateTime), created_at, updated_at.
d_schedules: Scheduled actions. Fields: schedule_id (unique), user_id, lead_id, schedule_time (DateTime), next_occur_at (DateTime), status, cta (String — "call"/"whatsapp"/"email"/""), created_at, updated_at.
d_brochure: Brochure docs. Fields: brochure_id (unique), org_id, user_id, campaign_id, brochure_data (List), is_active (Boolean), created_at, updated_at.
d_follow_up_batch: Follow-up batches. Fields: batch_id (unique), campaign_id, user_id, status (String — "active"/"completed"/"failed"/"in_progress"), leads_status (embedded list), created_at, updated_at.
d_reachout_flow: Reachout flow config. Fields: user_id, org_id, campaign_id, flow (Dict), terminal_states (List), business_hours (Dict), created_at, updated_at.
d_user_prompt: Agent prompts per campaign. Fields: user_id, campaign_id (unique), prompt, system_prompt, whatsapp_prompt, language, voice_name, voice_type, created_at, updated_at.
d_validated_user: Validated phone numbers. Fields: phone_number (unique), created_at, updated_at.
d_whatsapp_template: WhatsApp templates. Fields: user_id, org_id, campaign_id, template_name, gupshup_template_id, approval_status, template_type, category, created_at, updated_at.
d_whatsapp_followup: WhatsApp followup config. Fields: user_id, campaign_id (unique), followup1–followup4, whatsapp_followup_count, created_at, updated_at.
d_whatsapp_analytics: Daily WhatsApp stats. Fields: user_id, org_id, campaign_id, analytics_date (DateTime), sent_count (Int), delivered_count (Int), read_count (Int), failed_count (Int), template_health_score (Float), created_at, updated_at.
d_providers: Telephony providers. Fields: provider_name (unique), concurrency (Int), provider_type, created_at, updated_at.
f_lead_sessions: Lead chat sessions. Fields: lead_id, campaign_id, session_id (unique), start_time, end_time, created_at, updated_at.
f_lead_messages: Lead chat messages. Fields: lead_id, user_id, org_id, campaign_id, session_id, message, message_type ("text"/"image"/"video"/"document"/"audio"/"template"), message_owner ("assistant"/"user"), created_at, updated_at.
f_user_sessions: User admin sessions. Fields: user_id, session_id (unique), start_time, end_time, created_at, updated_at.
f_user_messages: User admin messages. Fields: user_id, session_id, message, message_type, message_owner ("assistant"/"user"), created_at, updated_at.
f_user_feedback: User feedback. Fields: feedback_id (unique), user_id, org_id, feedback_type ("general"/"bug_report"/"feature_request"/"improvement_suggestion"/"complaint"/"compliment"/"service_rating"/"other"), feedback_text, rating (1–5), status ("new"/"in_review"/"acknowledged"/"in_progress"/"resolved"/"closed"), created_at, updated_at.
f_lead_feedback: Lead feedback. Fields: feedback_id (unique), lead_id, user_id, org_id, campaign_id, feedback, created_at, updated_at.
f_automation_test_results: Test run results. Fields: test_run_id (unique), environment, run_status ("in_progress"/"completed"/"failed"/"partial"/"timeout"), total_tests, total_passed, total_failed, overall_pass_rate, created_at, updated_at.
c_crm_config: CRM configuration per org. Fields: config_id (unique), org_id (unique), crm_type, is_active (Boolean), created_at, updated_at.
c_valid_numbers: Valid phone number patterns. Fields: country (unique), country_code (unique), regex, telephony_name.
c_call_monitor: Live call monitoring. Fields: stream_sid, call_sid, lead_id, batch_id, cqs (Float), call_evaluation (Dict), avg_end_to_end_latency_ms, created_at, updated_at.
o_cron_jobs: Scheduled cron jobs. Fields: job_id (unique), status, type, lead_id, org_id, user_id, campaign_id, next_attempt_at (DateTime), retry_attempt_count (Int), created_at, updated_at.
elevenlabs_voices: Voice catalog. Fields: voice_id (unique), name, labels (Dict), preview_url, created_at, updated_at.

== JOINS ==
Use mongo_aggregate on d_lead with $lookup to join related collections on lead_id. Example: [{"$match":{...}},{"$lookup":{"from":"f_lead_status","localField":"lead_id","foreignField":"lead_id","as":"status"}},{"$lookup":{"from":"f_lead_call","localField":"lead_id","foreignField":"lead_id","as":"call"}},{"$lookup":{"from":"f_lead_whatsapp","localField":"lead_id","foreignField":"lead_id","as":"whatsapp"}},{"$lookup":{"from":"d_lead_crm","localField":"lead_id","foreignField":"lead_id","as":"crm"}},{"$unwind":{"path":"$status","preserveNullAndEmptyArrays":true}},{"$unwind":{"path":"$call","preserveNullAndEmptyArrays":true}},{"$unwind":{"path":"$whatsapp","preserveNullAndEmptyArrays":true}},{"$unwind":{"path":"$crm","preserveNullAndEmptyArrays":true}}].
`.trim();

const CONTEXT_AND_ADVANCED_FILTERS = `
== FIELD → COLLECTION QUICK REFERENCE (use the RIGHT collection) ==
- lead_name, lead_phone_no, lead_email, lead_company, lead_country → d_lead
- lead_status, lead_heat_score, lead_data.budget, lead_data.location, lead_data.occupation, lead_data.property_type, lead_data.bhk, lead_data.timeline, lead_summary, comments, has_visited_site → f_lead_status
- call_attempt_count, call_connected_count, call_reachout_status, is_call_in_progress, last_call_attempted_at, last_call_duration_seconds → f_lead_call
- whatsapp_message_count, whatsapp_reachout_status, whatsapp_attempt → f_lead_whatsapp
- org_name, org_status, is_plan_expired, is_free_trial, subscription_status, plan_start_date, plan_end_date → d_org
- user_status, phone_number (user's), name (user's), role → d_user
- campaign_name, is_active (campaign) → d_campaign
- pick_rate, total_attempts, caller_id, baseline_rate → c_calling_number
- call_sid, recording_url, call_started, call_duration_seconds, conversation_transcript → f_call_records
IMPORTANT: If you are unsure which collection a field belongs to, check the schema above. Do NOT guess — querying the wrong collection returns empty results.

== DATA SCOPING ==
- When the user provides an org_id, ALWAYS include {"org_id":"ORG_XXX"} in filters to scope results to their organization.
- CRITICAL: f_lead_status, f_lead_call, f_lead_whatsapp, d_lead_crm do NOT have org_id. They only have lead_id. So you CANNOT use mongo_count or mongo_find on f_lead_status with org_id in the filter — it will return 0.
- For "how many leads are qualified?" or any count/list by lead_status: use mongo_aggregate on d_lead with $match org_id, $lookup f_lead_status on lead_id, $unwind status, $match {"status.lead_status":"qualified"} (use lowercase: "new", "contacted", "qualified", "converted", "lost" — DB often stores lowercase), then $count or $limit. Never use mongo_count on f_lead_status when scoping by org.
- When querying d_lead, f_lead_status, f_lead_call, f_lead_whatsapp: first find leads for the org from d_lead, then filter related collections by those lead_ids, or use $lookup from d_lead.
- For cross-collection queries (e.g. "leads with status new for org X", "qualified leads count"), use mongo_aggregate with $lookup, not mongo_count on f_lead_status.

== NAME / TEXT SEARCHES ==
- ALWAYS use case-insensitive regex for name and text searches: {"lead_name":{"$regex":"searchterm","$options":"i"}}.
- This applies to lead_name (d_lead), org_name (d_org), campaign_name (d_campaign), name (d_user), lead_data.location (f_lead_status), etc.
- Never do exact-match on names unless the user explicitly provides the exact casing.

== DATE FILTERS ==
- ALWAYS use ISO 8601 format for ALL date filters: "YYYY-MM-DDTHH:mm:ss.sssZ". ISO date strings are auto-converted to ISODate.
- "This year" / "from January" → {"created_at":{"$gte":"2026-01-01T00:00:00.000Z"}} (use current year).
- "January 2026" only → {"$gte":"2026-01-01T00:00:00.000Z","$lt":"2026-02-01T00:00:00.000Z"}.
- Date range → {"created_at":{"$gte":"YYYY-MM-DDT00:00:00.000Z","$lte":"YYYY-MM-DDT23:59:59.999Z"}}.
- "last 30 days" → compute $gte date dynamically (30 days before today's ISO date).

== COMBINING CONDITIONS ==
- $and: {"$and":[{"lead_status":"new"},{"created_at":{"$gte":"2026-01-01T00:00:00.000Z"}}]} (use on f_lead_status; lead_status is lowercase in DB).
- $or: {"$or":[{"lead_status":"new"},{"lead_status":"contacted"}]}.

== BUDGET FILTERS (f_lead_status only) ==
- Budget: use budgetMinLakhs and/or budgetMaxLakhs in filter; auto-converted to lead_data.budget in rupees. Example: {"budgetMinLakhs":8}. Do NOT use $regex on budget.

== COMMON FIELD CONFUSIONS ==
- "Is plan expired?" → query d_org with is_plan_expired (Boolean true/false), NOT subscription_status.
- "Subscription status" → query d_org with subscription_status (String: "active"/"pending"/"halted"/"cancelled"/"paused"/"expired").
- "Lead status" (new/contacted/qualified/converted/lost) → stored in f_lead_status; DB often uses lowercase. Always use lowercase in $match, e.g. {"status.lead_status":"qualified"}. f_lead_status has NO org_id — use mongo_aggregate on d_lead with $lookup, then $match status.lead_status. Do NOT use mongo_count on f_lead_status with org_id (returns 0).
- "Call pick rate" for calling numbers → query c_calling_number field pick_rate, NOT f_lead_call.
- "Calls in progress" → query f_lead_call with {"is_call_in_progress":true}.
- "Total leads per campaign" → query d_lead grouped by campaign_id, filtering by org_id.

== RESPONSE FORMATTING ==
- Always summarize results in natural, readable language. State counts, key names, and important details.
- Do NOT dump raw JSON documents to the user. Extract and present the relevant fields in a clear format.
- For lists, show key fields (name, phone, status) in a readable format, not full document dumps.
- When no results are found, explain what was searched and suggest alternatives (e.g. different filters or collections).
- If the query is ambiguous or you need more info (like org_id, campaign_id, date range), ASK the user before querying.
`.trim();

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

// Generic labels in tool descriptions.
const DESC_DATABASE = "the configured database";
const COLLECTION_LIST =
  "d_lead (default), d_lead_crm, f_lead_status, f_lead_call, f_lead_whatsapp, d_org, d_user, d_campaign, d_reachout_flow, d_plan, d_payments, d_schedules, d_brochure, d_follow_up_batch, d_user_prompt, d_validated_user, d_whatsapp_template, d_whatsapp_followup, d_whatsapp_analytics, d_providers, f_call_records, f_lead_sessions, f_lead_messages, f_user_sessions, f_user_messages, f_user_workspace, f_user_feedback, f_lead_feedback, f_automation_test_results, c_crm_config, c_valid_numbers, c_calling_number, c_call_monitor, o_cron_jobs, elevenlabs_voices";

// All collections in the dev database. No delete tool is exposed; dev DB is read/insert/update only.
const ALLOWED_COLLECTIONS = [
  "d_lead",
  "d_lead_crm",
  "f_lead_status",
  "f_lead_call",
  "f_lead_whatsapp",
  "d_org",
  "d_user",
  "d_campaign",
  "d_reachout_flow",
  "d_plan",
  "d_payments",
  "d_schedules",
  "d_brochure",
  "d_follow_up_batch",
  "d_user_prompt",
  "d_validated_user",
  "d_whatsapp_template",
  "d_whatsapp_followup",
  "d_whatsapp_analytics",
  "d_providers",
  "f_call_records",
  "f_lead_sessions",
  "f_lead_messages",
  "f_user_sessions",
  "f_user_messages",
  "f_user_workspace",
  "f_user_feedback",
  "f_lead_feedback",
  "f_automation_test_results",
  "c_crm_config",
  "c_valid_numbers",
  "c_calling_number",
  "c_call_monitor",
  "o_cron_jobs",
  "elevenlabs_voices",
];

function resolveCollection(defaultCol: string, paramCol: unknown): string {
  const col = (paramCol as string)?.trim() || defaultCol;
  if (!ALLOWED_COLLECTIONS.includes(col)) {
    throw new Error(`Invalid collection "${col}". Allowed: ${ALLOWED_COLLECTIONS.join(", ")}.`);
  }
  return col;
}

/** Extract budgetMinLakhs/budgetMaxLakhs from filter and merge as lead_data.budget range in rupees. Only applied when collection is f_lead_status (lead_data lives there). */
function applyBudgetRangeToFilter(
  filter: Record<string, unknown>,
  collection?: string,
): Record<string, unknown> {
  if (collection && collection !== "f_lead_status") {
    return filter;
  }
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

const DEFAULT_LEAD_ORG_ID = "ORG_DEMO";
const DEFAULT_LEAD_USER_ID = "USER_DEMO";
const DEFAULT_LEAD_CAMPAIGN_ID = "CAMPAIGN_DEMO";

/** Collections that have org_id; when fixitScope is set, filters are merged to enforce scope. */
const ORG_SCOPED_COLLECTIONS = new Set([
  "d_lead",
  "d_org",
  "d_campaign",
  "c_calling_number",
  "f_call_records",
  "d_payments",
  "d_brochure",
  "d_reachout_flow",
  "d_whatsapp_template",
  "d_whatsapp_analytics",
  "f_lead_messages",
  "f_user_feedback",
  "f_lead_feedback",
  "f_user_workspace",
  "c_crm_config",
  "o_cron_jobs",
]);

export type LeadDefaults = {
  org_id: string;
  user_id: string;
  campaign_id: string;
};

export type FixitScope = { orgId: string; userId: string; campaignId?: string };

/** When fixitScope is set, enforce org_id, user_id, and (when present) campaign_id so queries only return data for that org/user/campaign. */
function mergeScopeIntoFilter(
  col: string,
  filter: Record<string, unknown>,
  scope: FixitScope,
): Record<string, unknown> {
  if (col === "d_lead" || ORG_SCOPED_COLLECTIONS.has(col)) {
    const scopeMatch: Record<string, unknown> = {
      org_id: scope.orgId,
      user_id: scope.userId,
    };
    if (scope.campaignId) {
      scopeMatch.campaign_id = scope.campaignId;
    }
    return { $and: [filter, scopeMatch] };
  }
  return filter;
}

function ensurePipelineScope(
  pipeline: unknown[],
  scope: FixitScope,
  collection: string,
): unknown[] {
  if (collection !== "d_lead" && !ORG_SCOPED_COLLECTIONS.has(collection)) {
    return pipeline;
  }
  const scopeMatch: Record<string, unknown> = {
    org_id: scope.orgId,
    user_id: scope.userId,
  };
  if (scope.campaignId) {
    scopeMatch.campaign_id = scope.campaignId;
  }
  if (
    pipeline.length > 0 &&
    typeof pipeline[0] === "object" &&
    pipeline[0] !== null &&
    "$match" in (pipeline[0] as Record<string, unknown>)
  ) {
    const first = pipeline[0] as Record<string, unknown>;
    const existing = (first.$match as Record<string, unknown>) ?? {};
    const merged = { ...existing, ...scopeMatch };
    return [{ $match: merged }, ...pipeline.slice(1)];
  }
  return [{ $match: scopeMatch }, ...pipeline];
}

function createMongoTools(
  uri: string,
  dbName: string,
  defaultCollection: string,
  clientOptions?: MongoClientOptions,
  leadDefaults?: LeadDefaults,
  fixitScope?: FixitScope,
): AnyAgentTool[] {
  if (fixitScope) {
    console.log(
      `[mongodb] fixitScope enforced: org=${fixitScope.orgId} user=${fixitScope.userId}${
        fixitScope.campaignId ? ` campaign=${fixitScope.campaignId}` : ""
      }`,
    );
  }
  const getClientWithOpts = () => getClient(uri, clientOptions);
  const orgId = fixitScope?.orgId ?? leadDefaults?.org_id ?? DEFAULT_LEAD_ORG_ID;
  const userId = fixitScope?.userId ?? leadDefaults?.user_id ?? DEFAULT_LEAD_USER_ID;
  const campaignId = leadDefaults?.campaign_id ?? DEFAULT_LEAD_CAMPAIGN_ID;
  // ------ mongo_find ------
  const findTool: AnyAgentTool = {
    name: "mongo_find",
    label: "MongoDB Find",
    description: `Query documents from a collection in MongoDB database ${DESC_DATABASE}. Collections: ${COLLECTION_LIST}. ${SCHEMA_DESCRIPTION}

Use filter to narrow results (MongoDB query syntax). Use projection to select only needed fields for cleaner results. Use sort, skip, limit to paginate.
Common queries: filter={"org_id":"ORG_XXX"} (d_lead), filter={"lead_phone_no":"919204292878"} (d_lead), filter={"lead_name":{"$regex":"john","$options":"i"}} (d_lead — ALWAYS case-insensitive for names), filter={"lead_status":"qualified"} (f_lead_status — use lowercase: new/contacted/qualified/converted/lost; NOT d_lead), filter={"is_call_in_progress":true} (f_lead_call).
For cross-collection queries: use mongo_aggregate with $lookup for joined results instead of multiple separate finds.
RESPONSE: Summarize results in natural language. Show key fields (name, phone, status) clearly. Do NOT show raw JSON to the user.

${CONTEXT_AND_ADVANCED_FILTERS}`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for default (d_lead).`,
        },
        filter: {
          type: "object",
          description:
            'MongoDB query filter. For created_at/updated_at use ISO strings (auto-converted to ISODate). For "budget above 8 lakhs" use filter={"budgetMinLakhs":8}; for range use budgetMinLakhs and/or budgetMaxLakhs (converted to rupees internally). Do NOT use regex on lead_data.budget. For lead_status use lowercase: {"lead_status":"qualified"}. Other examples: {"lead_phone_no":"919204292878"}, {"lead_name":{"$regex":"john","$options":"i"}}',
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
      let filter = convertFilterDateStrings(applyBudgetRangeToFilter(rawFilter, col));
      if (fixitScope && (col === "d_lead" || ORG_SCOPED_COLLECTIONS.has(col))) {
        filter = mergeScopeIntoFilter(col, filter, fixitScope) as Record<string, unknown>;
      }
      const projection = parseJsonParam(params.projection, "projection");
      const sort = parseJsonParam(params.sort, "sort");
      const limit = Math.min(Number(params.limit) || 20, 500);
      const skip = Number(params.skip) || 0;

      const client = await getClientWithOpts();
      const db = client.db(dbName);
      const docs = await db
        .collection(col)
        .find(filter, { projection })
        .sort(sort as Sort)
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

For d_lead include: user_id, org_id, lead_id, lead_name, lead_phone_no, campaign_id, created_at, updated_at. For f_lead_status include lead_id, lead_status, lead_data, created_at, updated_at. For f_lead_call/f_lead_whatsapp include lead_id and their fields. Use consistent lead_id across collections for joins.`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for default (d_lead).`,
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
      const client = await getClientWithOpts();
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

  // ------ mongo_save_lead ------
  const saveLeadTool: AnyAgentTool = {
    name: "mongo_save_lead",
    label: "Save lead",
    description: `Insert a new lead into d_lead and related tables (f_lead_status, f_lead_call, f_lead_whatsapp) in ${DESC_DATABASE}. Uses default org_id, user_id, and campaign_id when not provided (demo-friendly). Call this when the user asks to save or add a lead; do not ask for org_id, user_id, or campaign_id—use defaults.`,
    parameters: {
      type: "object",
      properties: {
        lead_name: { type: "string", description: "Full name of the lead" },
        lead_phone_no: { type: "string", description: "Phone number of the lead" },
        lead_email: { type: "string", description: "Email of the lead (optional)" },
        lead_company: { type: "string", description: "Company name (optional)" },
        lead_country: { type: "string", description: "Country (optional)" },
        org_id: { type: "string", description: "Override default org_id (optional)" },
        user_id: { type: "string", description: "Override default user_id (optional)" },
        campaign_id: { type: "string", description: "Override default campaign_id (optional)" },
      },
      required: ["lead_name", "lead_phone_no"],
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const client = await getClientWithOpts();
      const db = client.db(dbName);
      const now = new Date().toISOString();
      const leadId = `lead_${crypto.randomUUID()}`;
      const oid = (params.org_id as string)?.trim() || orgId;
      const uid = (params.user_id as string)?.trim() || userId;
      const cid = (params.campaign_id as string)?.trim() || campaignId;

      const leadDoc: Record<string, unknown> = {
        lead_id: leadId,
        user_id: uid,
        org_id: oid,
        campaign_id: cid,
        lead_name: normalizeToEnglish((params.lead_name as string) ?? "") || "Unknown",
        lead_phone_no: (params.lead_phone_no as string)?.trim() ?? "",
        created_at: now,
        updated_at: now,
      };
      if ((params.lead_email as string)?.trim())
        leadDoc.lead_email = (params.lead_email as string).trim();
      const companyNorm = normalizeToEnglish((params.lead_company as string) ?? "");
      if (companyNorm) leadDoc.lead_company = companyNorm;
      const countryNorm = normalizeToEnglish((params.lead_country as string) ?? "");
      if (countryNorm) leadDoc.lead_country = countryNorm;

      await db.collection("d_lead").insertOne(leadDoc);

      const statusDoc = {
        lead_id: leadId,
        lead_status: "new",
        lead_data: {},
        created_at: now,
        updated_at: now,
      };
      await db.collection("f_lead_status").insertOne(statusDoc);

      const callDoc = {
        lead_id: leadId,
        call_attempt_count: 0,
        call_reachout_status: "not_called",
        created_at: now,
        updated_at: now,
      };
      await db.collection("f_lead_call").insertOne(callDoc);

      const whatsappDoc = {
        lead_id: leadId,
        whatsapp_message_count: 0,
        whatsapp_attempt: 0,
        whatsapp_reachout_status: "not_contacted",
        created_at: now,
        updated_at: now,
      };
      await db.collection("f_lead_whatsapp").insertOne(whatsappDoc);

      return jsonResult({
        success: true,
        lead_id: leadId,
        message: "Lead saved to d_lead, f_lead_status, f_lead_call, f_lead_whatsapp",
        lead_name: leadDoc.lead_name,
        lead_phone_no: leadDoc.lead_phone_no,
      });
    },
  };

  // ------ mongo_update ------
  const updateTool: AnyAgentTool = {
    name: "mongo_update",
    label: "MongoDB Update",
    description: `Update documents in a collection in MongoDB database ${DESC_DATABASE}. Collections: ${COLLECTION_LIST}. ${SCHEMA_DESCRIPTION}

Provide a filter and an update object. Use $set to change fields, $inc to increment counters. Filter by lead_id, org_id, etc. Update f_lead_status for lead_status/lead_data; f_lead_whatsapp for whatsapp_reachout_status/whatsapp_message_count; f_lead_call for call_reachout_status/call_attempt_count. Set updated_at when modifying. By default updates one document; set updateMany=true for bulk updates.
Do NOT use $unset, $pull, $pullAll, or any operator that removes data — delete operations are disabled for safety.`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for default (d_lead).`,
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
            'MongoDB update operators. Use only $set, $inc (no $unset/$pull — delete-like ops are disabled). For lead_status use lowercase. Examples: {"$set":{"lead_status":"contacted","updated_at":new Date()}}, {"$inc":{"whatsapp_message_count":1}}',
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
      let filter = convertFilterDateStrings(parseJsonParam(params.filter, "filter"));
      if (fixitScope && (col === "d_lead" || ORG_SCOPED_COLLECTIONS.has(col))) {
        filter = mergeScopeIntoFilter(col, filter, fixitScope) as Record<string, unknown>;
      }
      const update = parseJsonParam(params.update, "update");

      if (Object.keys(filter).length === 0) {
        throw new Error("filter is required to prevent accidental full-collection updates");
      }
      if (Object.keys(update).length === 0) {
        throw new Error("update object is required");
      }

      // Block delete-like operators (dangerous): no removing fields or array elements
      const forbidden = ["$unset", "$pull", "$pullAll"];
      for (const key of Object.keys(update)) {
        if (key.startsWith("$") && forbidden.includes(key)) {
          throw new Error(
            `Update operator ${key} is not allowed; delete-like operations are disabled for safety`,
          );
        }
      }

      // Auto-wrap plain field updates in $set if no operator keys present
      const hasOperator = Object.keys(update).some((k) => k.startsWith("$"));
      const mongoUpdate = hasOperator ? update : { $set: update };

      // Expand string _id to ObjectId in filter
      if (typeof filter._id === "string") {
        filter._id = safeObjectId(filter._id);
      }

      const client = await getClientWithOpts();
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
    description: `Count documents in a collection in MongoDB database ${DESC_DATABASE}. Collections: ${COLLECTION_LIST}. Optionally provide a filter. Use ISO date strings ("YYYY-MM-DDTHH:mm:ss.sssZ") for created_at/updated_at; they are auto-converted to ISODate.
IMPORTANT: lead_status lives in f_lead_status, but f_lead_status has NO org_id. For "how many leads are qualified?" or any count by lead_status, do NOT use mongo_count on f_lead_status — use mongo_aggregate on d_lead: [{"$match":{"org_id":"ORG_xxx"}},{"$lookup":{"from":"f_lead_status","localField":"lead_id","foreignField":"lead_id","as":"status"}},{"$unwind":"$status"},{"$match":{"status.lead_status":"qualified"}},{"$count":"count"}]. Use lowercase for lead_status ("qualified", "new", "contacted", "converted", "lost") — DB stores lowercase. For counts by fields in d_lead (e.g. total leads per org), mongo_count on d_lead with org_id is correct.
RESPONSE: Report the count in a clear sentence. Do NOT return raw JSON.

${CONTEXT_AND_ADVANCED_FILTERS}`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for default (d_lead).`,
        },
        filter: {
          type: "object",
          description:
            'Optional filter. For "budget above 8 lakhs" use {"budgetMinLakhs":8}; do NOT use regex on lead_data.budget. For lead_status use lowercase: {"lead_status":"qualified"}. Examples: {"org_id":"ORG_..."} (d_lead).',
          additionalProperties: true,
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const col = resolveCollection(defaultCollection, params.collection);
      const rawFilter = parseJsonParam(params.filter, "filter");
      let filter = convertFilterDateStrings(applyBudgetRangeToFilter(rawFilter, col));
      if (fixitScope && (col === "d_lead" || ORG_SCOPED_COLLECTIONS.has(col))) {
        filter = mergeScopeIntoFilter(col, filter, fixitScope) as Record<string, unknown>;
      }

      const client = await getClientWithOpts();
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
Joins: Start from d_lead and use $lookup to join f_lead_status, f_lead_call, f_lead_whatsapp, d_lead_crm on lead_id for full lead view. Always include org_id in the first $match when scoping to an org.
"How many leads are qualified?" (or new/contacted/converted/lost): use collection d_lead, pipeline [{"$match":{"org_id":"ORG_xxx"}},{"$lookup":{"from":"f_lead_status","localField":"lead_id","foreignField":"lead_id","as":"status"}},{"$unwind":"$status"},{"$match":{"status.lead_status":"qualified"}},{"$count":"count"}]. Use lowercase lead_status ("qualified", "new", "contacted", "converted", "lost") — the DB stores these in lowercase. This is required because f_lead_status has no org_id.
Other joins: [{"$match":{"org_id":"ORG_xxx"}},{"$lookup":{"from":"f_lead_status","localField":"lead_id","foreignField":"lead_id","as":"status"}},{"$lookup":{"from":"f_lead_call",...}},{"$unwind":{"path":"$status","preserveNullAndEmptyArrays":true}},{"$match":{"status.lead_status":"new"}}].
"Total leads per campaign for an org" → d_lead with [{"$match":{"org_id":"ORG_xxx"}},{"$group":{"_id":"$campaign_id","count":{"$sum":1}}}].
RESPONSE: Present aggregation results in a clear, summarized format. Do NOT dump raw pipeline output.`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for default (d_lead).`,
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
      let pipeline = rawPipeline.map((stage: Record<string, unknown>) => {
        const match = stage?.$match;
        if (match !== null && typeof match === "object" && !Array.isArray(match)) {
          return { ...stage, $match: convertFilterDateStrings(match as Record<string, unknown>) };
        }
        return stage;
      });
      if (fixitScope && (col === "d_lead" || ORG_SCOPED_COLLECTIONS.has(col))) {
        pipeline = ensurePipelineScope(pipeline, fixitScope, col) as Record<string, unknown>[];
      }

      const client = await getClientWithOpts();
      const db = client.db(dbName);
      const results = await db.collection(col).aggregate(pipeline).toArray();

      return jsonResult({ count: results.length, results });
    },
  };

  // ------ mongo_export_csv ------
  const exportCsvTool: AnyAgentTool = {
    name: "mongo_export_csv",
    label: "MongoDB Export CSV",
    description: `Export matching documents from a collection to CSV or Excel. Collections: ${COLLECTION_LIST}. Use when the user asks for an Excel/CSV/spreadsheet of leads. For production-quality leads (Campaign Name, Lead Status, Comments, enrichment): use collection d_lead, exportStyle "leads_production", and filename ending in .xlsx (Excel) or .csv. Returns file path and download link. For "100 random leads" use sampleSize: 100. Without sampleSize, exports ALL matching documents. After exporting, include the returned downloadLink in your reply. For Telegram/WhatsApp use the message tool with action sendAttachment and media set to filePath.

${CONTEXT_AND_ADVANCED_FILTERS}`,
    parameters: {
      type: "object",
      properties: {
        collection: {
          type: "string",
          description: `Collection: ${COLLECTION_LIST}. Omit for default (d_lead).`,
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
            "Comma-separated list of fields to include as CSV columns. Default for d_lead: lead_id,lead_name,lead_phone_no,user_id,org_id,campaign_id,created_at,updated_at. For f_lead_status add lead_status,lead_data.budget,lead_data.location; for f_lead_call add call_reachout_status,call_attempt_count; for f_lead_whatsapp add whatsapp_reachout_status,whatsapp_message_count.",
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
        sampleSize: {
          type: "number",
          description:
            "If set, export a random sample of N documents (MongoDB $sample). Use for e.g. '100 random leads'. Omit to export all matching documents.",
        },
        exportStyle: {
          type: "string",
          description:
            "Set to 'leads_production' when collection is d_lead and the user asked for a production-quality leads export (includes Campaign Name, Lead Status, Comments, lead_data columns). Use with filename ending in .xlsx for Excel output.",
        },
      },
    },
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const col = resolveCollection(defaultCollection, params.collection);
      const rawFilter = parseJsonParam(params.filter, "filter");
      let filter = convertFilterDateStrings(applyBudgetRangeToFilter(rawFilter, col));
      if (fixitScope && (col === "d_lead" || ORG_SCOPED_COLLECTIONS.has(col))) {
        filter = mergeScopeIntoFilter(col, filter, fixitScope) as Record<string, unknown>;
      }
      const sort = parseJsonParam(params.sort, "sort");
      const sortFinal = Object.keys(sort).length > 0 ? sort : { created_at: -1 };
      const filename = (params.filename as string) || "leads_export.csv";
      const sampleSize =
        typeof params.sampleSize === "number" && params.sampleSize > 0
          ? Math.min(Math.floor(params.sampleSize), 100_000)
          : null;
      const exportStyle =
        typeof params.exportStyle === "string" && params.exportStyle.trim() === "leads_production"
          ? "leads_production"
          : "raw";

      const client = await getClientWithOpts();
      const db = client.db(dbName);

      const isXlsx = filename.toLowerCase().endsWith(".xlsx");
      const useProductionLeads = col === "d_lead" && exportStyle === "leads_production";

      let docs: Record<string, unknown>[];
      let productionRows: Record<string, string>[] = [];
      let productionColumns: string[] = [];

      if (useProductionLeads) {
        // Production leads: d_lead + $lookup d_campaign (campaign_name) and f_lead_status (lead_status, comments, lead_data).
        const pipeline: Record<string, unknown>[] = [];
        if (Object.keys(filter).length > 0) {
          pipeline.push({ $match: filter });
        }
        if (sampleSize != null) {
          pipeline.push({ $sample: { size: sampleSize } });
        }
        pipeline.push({ $sort: sortFinal });
        pipeline.push({
          $lookup: {
            from: "d_campaign",
            let: { cid: "$campaign_id", uid: "$user_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [{ $eq: ["$campaign_id", "$$cid"] }, { $eq: ["$user_id", "$$uid"] }],
                  },
                },
              },
              { $limit: 1 },
              { $project: { campaign_name: 1, _id: 0 } },
            ],
            as: "campaignDoc",
          },
        });
        pipeline.push({
          $lookup: {
            from: "f_lead_status",
            localField: "lead_id",
            foreignField: "lead_id",
            as: "statusDoc",
          },
        });
        pipeline.push({
          $addFields: {
            campaignDoc: { $arrayElemAt: ["$campaignDoc", 0] },
            statusDoc: { $arrayElemAt: ["$statusDoc", 0] },
          },
        });
        docs = (await db.collection(col).aggregate(pipeline).toArray()) as Record<
          string,
          unknown
        >[];

        const leadDataKeyToCol: Record<string, string> = {
          estimated_annual_income: "Estimated Annual Income",
          investment_timeline: "Investment Timeline",
          years_of_experience: "No of Years of Experience",
          estimated_net_worth: "Estimated Net Worth",
          risk_profile: "Risk Profile",
          confidence_score: "Confidence Score",
        };
        const allLeadDataKeys = new Set<string>(Object.keys(leadDataKeyToCol));
        for (const doc of docs) {
          const statusDoc = doc.statusDoc as Record<string, unknown> | undefined;
          const leadData = statusDoc?.lead_data as Record<string, unknown> | undefined;
          if (leadData && typeof leadData === "object") {
            for (const k of Object.keys(leadData)) {
              if (k !== "campaign_id" && k !== "other_requirements") {
                allLeadDataKeys.add(k);
              }
            }
          }
        }

        function formatDate(v: unknown): string {
          if (v == null) return "";
          if (v instanceof Date) {
            return v.toISOString().replace("T", " ").slice(0, 19);
          }
          if (typeof v === "object" && v !== null && "$date" in v) {
            const d = (v as { $date: string }).$date;
            if (typeof d === "string") return d.replace("T", " ").slice(0, 19);
          }
          return String(v);
        }
        function strVal(v: unknown): string {
          if (v == null) return "";
          if (typeof v === "object") return JSON.stringify(v);
          return String(v);
        }

        productionColumns = [
          "Lead Name",
          "Lead Phone Number",
          "Lead Company",
          "Addition Date",
          "Campaign Name",
          "Lead Email",
          "Lead Address",
          "Lead Status",
          "Comments",
          ...Array.from(allLeadDataKeys).map(
            (k) =>
              leadDataKeyToCol[k] ??
              k
                .split("_")
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" "),
          ),
        ];

        for (const doc of docs) {
          const statusDoc = doc.statusDoc as Record<string, unknown> | undefined;
          const campaignDoc = doc.campaignDoc as { campaign_name?: string } | undefined;
          const leadData = statusDoc?.lead_data as Record<string, unknown> | undefined;
          const row: Record<string, string> = {
            "Lead Name": strVal(doc.lead_name),
            "Lead Phone Number": strVal(doc.lead_phone_no),
            "Lead Company": strVal(doc.lead_company),
            "Addition Date": formatDate(doc.created_at),
            "Campaign Name": strVal(campaignDoc?.campaign_name),
            "Lead Email": strVal(doc.lead_email),
            "Lead Address": strVal(doc.lead_address),
            "Lead Status": strVal(statusDoc?.lead_status),
            Comments: strVal(statusDoc?.comments),
          };
          for (const k of allLeadDataKeys) {
            const colName =
              leadDataKeyToCol[k] ??
              k
                .split("_")
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(" ");
            const val = leadData?.[k];
            row[colName] =
              val != null && typeof val !== "object"
                ? String(val)
                : val != null
                  ? JSON.stringify(val)
                  : "";
          }
          productionRows.push(row);
        }
      } else {
        // Raw export
        const defaultFields = [
          "lead_id",
          "lead_name",
          "lead_phone_no",
          "user_id",
          "org_id",
          "campaign_id",
          "created_at",
          "updated_at",
        ];
        const fields =
          typeof params.fields === "string"
            ? params.fields
                .split(",")
                .map((f) => f.trim())
                .filter(Boolean)
            : defaultFields;

        if (sampleSize != null) {
          const pipeline: Record<string, unknown>[] = [];
          if (Object.keys(filter).length > 0) {
            pipeline.push({ $match: filter });
          }
          pipeline.push({ $sample: { size: sampleSize } });
          docs = (await db.collection(col).aggregate(pipeline).toArray()) as Record<
            string,
            unknown
          >[];
        } else {
          docs = await db
            .collection(col)
            .find(filter)
            .sort(sortFinal as Sort)
            .toArray();
        }

        function getNestedValue(obj: Record<string, unknown>, fieldPath: string): string {
          const parts = fieldPath.split(".");
          let current: unknown = obj;
          for (const part of parts) {
            if (current === null || current === undefined || typeof current !== "object") {
              return "";
            }
            current = (current as Record<string, unknown>)[part];
          }
          if (current === null || current === undefined) return "";
          if (current instanceof Date) return current.toISOString();
          if (typeof current === "object") {
            const dateObj = current as Record<string, unknown>;
            if (dateObj.$date) return String(dateObj.$date);
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

        const stateDir =
          process.env.OPENCLAW_STATE_DIR ??
          path.join(process.cwd(), ".openclaw-local") ??
          path.join(os.homedir(), ".openclaw");
        const fixitExportsDir = path.join(stateDir, "fixit-exports");
        if (!fs.existsSync(fixitExportsDir)) {
          fs.mkdirSync(fixitExportsDir, { recursive: true });
        }
        const filePath = path.join(fixitExportsDir, filename);
        if (isXlsx) {
          const wb = XLSX.utils.book_new();
          const ws = XLSX.utils.json_to_sheet(
            docs.map((d) => {
              const out: Record<string, unknown> = {};
              for (const f of fields) {
                const v = getNestedValue(d as Record<string, unknown>, f);
                const title = f.split(".").pop() ?? f;
                out[title] = v;
              }
              return out;
            }),
          );
          XLSX.utils.book_append_sheet(wb, ws, "Leads");
          XLSX.writeFile(wb, filePath);
        } else {
          fs.writeFileSync(filePath, csv, "utf-8");
        }
        const sizeBytes = isXlsx
          ? (fs.statSync(filePath).size as number)
          : Buffer.byteLength(csv, "utf-8");
        return jsonResult({
          exported: docs.length,
          fields: fields.length,
          filePath,
          filename,
          sizeBytes,
          message: `Exported ${docs.length} rows to ${filePath}`,
          downloadLink: `[Download ${filename}](${pathToFileURL(filePath).href})`,
          downloadInstruction:
            "IMPORTANT: Include the downloadLink markdown above in your response so the user sees a clickable link to the local file (file://). For Telegram/WhatsApp, use the message tool with action sendAttachment instead.",
          messageToolParams: {
            action: "sendAttachment",
            media: filePath,
            message: `Leads export (${docs.length} rows).`,
          },
        });
      }

      // Production leads path: write productionRows to CSV or XLSX
      const stateDir =
        process.env.OPENCLAW_STATE_DIR ??
        path.join(process.cwd(), ".openclaw-local") ??
        path.join(os.homedir(), ".openclaw");
      const fixitExportsDir = path.join(stateDir, "fixit-exports");
      if (!fs.existsSync(fixitExportsDir)) {
        fs.mkdirSync(fixitExportsDir, { recursive: true });
      }
      const filePath = path.join(fixitExportsDir, filename);

      if (isXlsx) {
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(productionRows, { header: productionColumns });
        XLSX.utils.book_append_sheet(wb, ws, "Leads");
        XLSX.writeFile(wb, filePath);
      } else {
        function escapeCsvField(value: string): string {
          if (value.includes(",") || value.includes('"') || value.includes("\n")) {
            return `"${value.replace(/"/g, '""')}"`;
          }
          return value;
        }
        const header = productionColumns.map(escapeCsvField).join(",");
        const rows = productionRows.map((row) =>
          productionColumns.map((c) => escapeCsvField(row[c] ?? "")).join(","),
        );
        const csv = [header, ...rows].join("\n");
        fs.writeFileSync(filePath, csv, "utf-8");
      }
      const sizeBytes = fs.statSync(filePath).size as number;
      return jsonResult({
        exported: productionRows.length,
        fields: productionColumns.length,
        filePath,
        filename,
        sizeBytes,
        message: `Exported ${productionRows.length} leads to ${filePath}`,
        downloadLink: `[Download ${filename}](${pathToFileURL(filePath).href})`,
        downloadInstruction:
          "IMPORTANT: Include the downloadLink markdown above in your response so the user sees a clickable link to the local file (file://). For Telegram/WhatsApp, use the message tool with action sendAttachment instead.",
        messageToolParams: {
          action: "sendAttachment",
          media: filePath,
          message: `Leads export (${productionRows.length} rows).`,
        },
      });
    },
  };

  // ------ send_file_to_chat ------
  const stateDirForSend =
    process.env.OPENCLAW_STATE_DIR ??
    path.join(process.cwd(), ".openclaw-local") ??
    path.join(os.homedir(), ".openclaw");
  const workspaceDir = path.join(stateDirForSend, "workspace");
  const fixitExportsDirForSend = path.join(stateDirForSend, "fixit-exports");

  const sendFileToChatTool: AnyAgentTool = {
    name: "send_file_to_chat",
    label: "Send file to chat",
    description: `Send a file that is already on disk (e.g. a CSV exported by mongo_export_csv) to the user in the current chat. The file must be under the OpenClaw workspace or fixit-exports directory. Use this when the user asked for an Excel/CSV and you have already exported it — pass the filePath returned by mongo_export_csv and a short caption. You MUST then call the message tool with action sendAttachment, media set to the returned filePath, and message set to the caption, so the file is delivered in Telegram/WhatsApp/etc.`,
    parameters: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description:
            "Full path to the file (e.g. from mongo_export_csv). Must be under workspace or fixit-exports.",
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
      const resolvedExports = path.resolve(fixitExportsDirForSend);
      const underWorkspace =
        resolvedPath === resolvedWorkspace || resolvedPath.startsWith(resolvedWorkspace + path.sep);
      const underExports =
        resolvedPath === resolvedExports || resolvedPath.startsWith(resolvedExports + path.sep);
      if (!underWorkspace && !underExports) {
        throw new Error(
          `File must be under workspace (${resolvedWorkspace}) or fixit-exports (${resolvedExports}). Got: ${resolvedPath}`,
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
    saveLeadTool,
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
const DEFAULT_COLLECTION = "d_lead";

const mongodbPlugin = {
  id: "mongodb",
  name: "MongoDB CRUD",
  description:
    "Provides mongo_find, mongo_insert, mongo_save_lead, mongo_update, mongo_count, mongo_aggregate, mongo_export_csv, and send_file_to_chat. No delete tool — dev database is read/insert/update only.",

  register(api: OpenClawPluginApi) {
    // Allow overriding via plugin config; fall back to hardcoded defaults
    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    const uri = (pluginCfg.uri as string) || MONGO_URI;
    const dbName = (pluginCfg.database as string) || DB_NAME;
    const collection = (pluginCfg.collection as string) || DEFAULT_COLLECTION;
    const clientOptions: MongoClientOptions = {};
    if (typeof pluginCfg.serverSelectionTimeoutMS === "number")
      clientOptions.serverSelectionTimeoutMS = pluginCfg.serverSelectionTimeoutMS;
    if (typeof pluginCfg.connectTimeoutMS === "number")
      clientOptions.connectTimeoutMS = pluginCfg.connectTimeoutMS;

    const leadDefaults: LeadDefaults | undefined =
      typeof pluginCfg.defaultOrgId === "string" ||
      typeof pluginCfg.defaultUserId === "string" ||
      typeof pluginCfg.defaultCampaignId === "string"
        ? {
            org_id: (pluginCfg.defaultOrgId as string)?.trim() || DEFAULT_LEAD_ORG_ID,
            user_id: (pluginCfg.defaultUserId as string)?.trim() || DEFAULT_LEAD_USER_ID,
            campaign_id:
              (pluginCfg.defaultCampaignId as string)?.trim() || DEFAULT_LEAD_CAMPAIGN_ID,
          }
        : undefined;

    api.registerTool(
      (ctx) =>
        createMongoTools(uri, dbName, collection, clientOptions, leadDefaults, ctx.fixitScope),
      {
        names: [
          "mongo_find",
          "mongo_insert",
          "mongo_save_lead",
          "mongo_update",
          "mongo_count",
          "mongo_aggregate",
          "mongo_export_csv",
          "send_file_to_chat",
        ],
      },
    );

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
