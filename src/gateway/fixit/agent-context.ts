/**
 * Fixit Chatbot Integration — agent context injection.
 * Builds per-user system prompt so the AI auto-scopes all MongoDB queries to org_id/user_id.
 *
 * Injects:
 * 1. Identity + strict scoping rules
 * 2. Workspace docs (identity/soul/agents) or onboarding instructions
 * 3. Conversation memory (current session + cross-session)
 * 4. Export / formatting rules
 */

import type { WorkspaceCheckResult, HistoryMessage } from "./mongo-sync.js";
import { CORE_DOC_TYPES } from "./mongo-sync.js";
import type { FixitIdentity } from "./types.js";

export type AgentContextInput = {
  identity: FixitIdentity;
  workspace?: WorkspaceCheckResult;
  sessionHistory?: HistoryMessage[];
  crossSessionHistory?: HistoryMessage[];
};

const MAX_CONTEXT_CHARS = 12_000;

export function buildFixitAgentContext(input: AgentContextInput): string {
  const { identity, workspace, sessionHistory, crossSessionHistory } = input;

  const sections: string[] = [
    buildIdentitySection(identity),
    buildScopingRules(identity),
    buildWorkspaceSection(identity, workspace),
    buildConversationMemory(sessionHistory, crossSessionHistory),
    buildExportRules(),
    buildFormattingRules(),
  ];

  let prompt = sections.filter(Boolean).join("\n\n");

  // Token budget safety: if the entire prompt exceeds budget, truncate memory
  if (prompt.length > MAX_CONTEXT_CHARS) {
    const trimmedSections = [
      buildIdentitySection(identity),
      buildScopingRules(identity),
      buildWorkspaceSection(identity, workspace),
      buildConversationMemory(sessionHistory?.slice(-10), []),
      buildExportRules(),
      buildFormattingRules(),
    ];
    prompt = trimmedSections.filter(Boolean).join("\n\n");
  }

  return prompt.trim();
}

function buildIdentitySection(identity: FixitIdentity): string {
  const campaignLine = identity.campaignId
    ? `\n- campaign_id: "${identity.campaignId}" (REQUIRED in every query on campaign-scoped collections)`
    : "";
  return `## Fixit User Context (auto-injected, strict scope)
You are serving a Fixit dashboard user. All data access is HARD-SCOPED to this org and user.
- org_id: "${identity.orgId}" (REQUIRED in every query filter)
- user_id: "${identity.userId}"
- org_name: "${identity.orgName ?? "unknown"}"
- user_name: "${identity.userName ?? "unknown"}"
- role: "${identity.role}"${campaignLine}`;
}

function buildScopingRules(identity: FixitIdentity): string {
  const campaignFilter = identity.campaignId ? ` AND {"campaign_id":"${identity.campaignId}"}` : "";
  const campaignNote = identity.campaignId ? ` Treat campaign_id as a hard filter.` : "";
  return `STRICT SCOPING RULES (enforced backend + agent level):
- You MUST include {"org_id":"${identity.orgId}"} AND {"user_id":"${identity.userId}"}${campaignFilter} in EVERY mongo_find, mongo_count, mongo_aggregate, and mongo_update filter on collections with org_id (e.g. d_lead, d_campaign, f_user_workspace).${campaignNote}
- f_lead_status, f_lead_call, f_lead_whatsapp, d_lead_crm do NOT have org_id — they only have lead_id. For "how many leads are qualified?" or any count/list by lead_status: use mongo_aggregate on d_lead with $match on org_id+user_id${identity.campaignId ? "+campaign_id" : ""}, then $lookup f_lead_status on lead_id, then $match {"status.lead_status":"qualified"} (lowercase: "new", "contacted", "qualified", "converted", "lost"). Do NOT use mongo_count on f_lead_status with org_id.
- CROSS-ORG/USER ACCESS DENIED: Never query or return data for any other org_id, user_id${identity.campaignId ? ", or campaign_id" : ""}. If the user asks for another org's data, respond: "Access denied — you can only access data for your own organization."
- "My leads", "my campaigns", "our data" = org_id "${identity.orgId}" + user_id "${identity.userId}"${identity.campaignId ? ` + campaign_id "${identity.campaignId}"` : ""}.
- The user does NOT supply org_id or user_id — you already have them.
- When fetching by lead_id, ALWAYS include org_id and user_id in the filter. If empty result: "No lead found with that ID for your org."`;
}

function buildWorkspaceSection(identity: FixitIdentity, workspace?: WorkspaceCheckResult): string {
  const header = `WORKSPACE (MongoDB collection "f_user_workspace", scoped by org_id/user_id${identity.campaignId ? "/campaign_id" : ""}):
- Schema: org_id, user_id, campaign_id (nullable), doc_id, doc_type, title, content_md, content_json, tags, metadata, created_at, updated_at, deleted_at.
- Core docs: IDENTITY (doc_type="identity"), SOUL (doc_type="soul"), AGENTS (doc_type="agents").`;

  if (!workspace || workspace.status === "empty") {
    return `${header}\n\n${buildFullOnboardingPrompt(identity)}`;
  }

  if (workspace.status === "partial") {
    return `${header}\n\n${buildPartialOnboardingPrompt(identity, workspace)}`;
  }

  // status === "full"
  return `${header}\n\n${buildLoadedWorkspacePrompt(workspace)}`;
}

function buildFullOnboardingPrompt(identity: FixitIdentity): string {
  const scopeFields = buildScopeFields(identity);
  return `*** NEW USER — NO WORKSPACE YET ***
No identity/soul/agents docs exist for this org/user. You MUST run onboarding NOW.

ONBOARDING FLOW:
1. Greet the user warmly. Explain you need to learn about them to personalize the experience.
2. Ask these questions (you may ask them together or one by one):
   a) "What is your company/organization name and what do you do?" → for IDENTITY
   b) "How should I communicate with you — formal, casual, concise, detailed?" → for SOUL (tone/style)
   c) "What are your main goals with this dashboard? What kind of questions will you ask most?" → for AGENTS (capabilities/focus)
3. After the user answers, synthesize markdown for each and save using mongo_insert:
   ${buildInsertExample("identity", "Identity", scopeFields)}
   ${buildInsertExample("soul", "Soul", scopeFields)}
   ${buildInsertExample("agents", "Agents", scopeFields)}
4. Confirm: "Your workspace is ready! I now know your identity, communication style, and goals."

IMPORTANT: Do NOT answer data queries or skip onboarding. Complete setup first.`;
}

function buildPartialOnboardingPrompt(identity: FixitIdentity, ws: WorkspaceCheckResult): string {
  const scopeFields = buildScopeFields(identity);

  // Show existing docs as context
  const existingLines = ws.docs
    .filter((d) => CORE_DOC_TYPES.includes(d.doc_type as (typeof CORE_DOC_TYPES)[number]))
    .map((d) => `### ${d.doc_type.toUpperCase()}\n${d.content_md}`)
    .join("\n\n");

  const missingList = ws.missingTypes
    .map((t) => {
      const questions: Record<string, string> = {
        identity: "What is your company/organization name and what do you do?",
        soul: "How should I communicate with you — formal, casual, concise, detailed?",
        agents: "What are your main goals with this dashboard?",
      };
      return `- **${t.toUpperCase()}**: Ask: "${questions[t] ?? `Tell me about your ${t}`}" → then mongo_insert: ${buildInsertExample(t, t.charAt(0).toUpperCase() + t.slice(1), scopeFields)}`;
    })
    .join("\n");

  return `*** PARTIAL WORKSPACE — ${ws.missingTypes.length} doc(s) missing ***
Existing docs loaded:
${existingLines || "(none with content)"}

Missing: ${ws.missingTypes.map((t) => t.toUpperCase()).join(", ")}

Ask the user ONLY for the missing information:
${missingList}

After saving, confirm completion. You may answer data queries about existing context while collecting missing info.`;
}

function buildLoadedWorkspacePrompt(ws: WorkspaceCheckResult): string {
  const coreDocs = ws.docs.filter((d) =>
    CORE_DOC_TYPES.includes(d.doc_type as (typeof CORE_DOC_TYPES)[number]),
  );
  const customDocs = ws.docs.filter(
    (d) => !CORE_DOC_TYPES.includes(d.doc_type as (typeof CORE_DOC_TYPES)[number]),
  );

  const coreLines = coreDocs
    .map((d) => `### ${d.doc_type.toUpperCase()}\n${d.content_md}`)
    .join("\n\n");

  const customLines =
    customDocs.length > 0
      ? `\n\nAdditional workspace docs:\n${customDocs.map((d) => `- **${d.title || d.doc_type}** (${d.doc_id}): ${d.content_md.slice(0, 200)}${d.content_md.length > 200 ? "…" : ""}`).join("\n")}`
      : "";

  return `WORKSPACE LOADED — returning user.

${coreLines}${customLines}

Use these docs as your operating context and persona. Respect the tone/style from SOUL.
If the user updates policies, goals, or preferences, update the relevant doc via mongo_update on f_user_workspace (match by doc_id + org_id + user_id).`;
}

function buildConversationMemory(
  sessionHistory?: HistoryMessage[],
  crossSessionHistory?: HistoryMessage[],
): string {
  const parts: string[] = [];

  if (crossSessionHistory && crossSessionHistory.length > 0) {
    const lines = crossSessionHistory.map((m) => `[${m.role}] ${m.text}`);
    parts.push(
      `PREVIOUS SESSIONS (recent messages from past conversations — use for continuity):\n${lines.join("\n")}`,
    );
  }

  if (sessionHistory && sessionHistory.length > 0) {
    const lines = sessionHistory.map((m) => `[${m.role}] ${m.text}`);
    parts.push(
      `CURRENT SESSION HISTORY (${sessionHistory.length} messages — this is the ongoing conversation):\n${lines.join("\n")}`,
    );
  }

  if (parts.length === 0) {
    return "";
  }

  return `CONVERSATION MEMORY:\n${parts.join("\n\n")}`;
}

function buildExportRules(): string {
  return `EXCEL/CSV EXPORT RULES:
- When the user requests lead data and the result would contain MORE THAN 10 rows, you MUST use mongo_export_csv to generate a CSV file instead of listing them in chat.
- After exporting, provide the download link: [Download <filename>](/api/fixit/files/download?path=<filePath>)
- For 10 or fewer rows, show data inline as a markdown table.`;
}

function buildFormattingRules(): string {
  return `RESPONSE FORMATTING:
- Use markdown: **bold**, *italic*, tables, lists, headings, code blocks.
- Format tabular results (≤10 rows) as markdown tables.
- Wrap JSON in \`\`\`json code blocks.
- For file downloads, use the markdown link format above.`;
}

// -- Helpers --

function buildScopeFields(identity: FixitIdentity): string {
  const parts = [`"org_id":"${identity.orgId}","user_id":"${identity.userId}"`];
  parts.push(identity.campaignId ? `"campaign_id":"${identity.campaignId}"` : `"campaign_id":null`);
  return parts.join(",");
}

function buildInsertExample(docType: string, title: string, scopeFields: string): string {
  return `{"collection":"f_user_workspace","document":{${scopeFields},"doc_id":"${docType}","doc_type":"${docType}","title":"${title}","content_md":"<synthesized markdown>","created_at":{"$date":"now"},"updated_at":{"$date":"now"},"deleted_at":null}}`;
}
