/**
 * Fixit Chatbot Integration — agent context injection.
 * Builds per-user system prompt so the AI auto-scopes all MongoDB queries to org_id/user_id.
 *
 * Injects:
 * 1. Identity + strict scoping rules
 * 2. Workspace profile (single doc) or onboarding instructions
 * 3. Conversation memory (current session + cross-session)
 * 4. Export / formatting rules
 */

import type { WorkspaceCheckResult, HistoryMessage } from "./mongo-sync.js";
import { WORKSPACE_PROFILE_DOC_ID } from "./mongo-sync.js";
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
- All user preferences are stored in a SINGLE document with doc_id="${WORKSPACE_PROFILE_DOC_ID}" and doc_type="profile".
- Schema: org_id, user_id, campaign_id (nullable), doc_id, doc_type, title, content_md, created_at, updated_at, deleted_at.`;

  if (!workspace || !workspace.initialized) {
    return `${header}\n\n${buildOnboardingPrompt(identity)}`;
  }

  return `${header}\n\n${buildLoadedWorkspacePrompt(workspace)}`;
}

function buildOnboardingPrompt(identity: FixitIdentity): string {
  const scopeFields = buildScopeFields(identity);
  return `*** NEW USER — NO PROFILE EXISTS YET ***
No profile document exists for this org/user. You MUST run onboarding NOW.

ONBOARDING FLOW:
1. Greet the user. Ask ALL of these in a single message:
   - "What is your name and company/organization?"
   - "How should I communicate — formal or casual?"
   - "What are your main goals with this dashboard?"
2. Once the user replies (they may answer in one message or across a few), create ONE document combining everything:
   {"collection":"f_user_workspace","document":{${scopeFields},"doc_id":"${WORKSPACE_PROFILE_DOC_ID}","doc_type":"profile","title":"User Profile","content_md":"# User Profile\\n\\n**Name:** <name>\\n**Company:** <company>\\n**Industry:** <if mentioned>\\n**Communication Style:** <formal/casual/etc>\\n**Goals:** <goals>\\n**Focus Areas:** <what they want to do>","created_at":{"$date":"now"},"updated_at":{"$date":"now"},"deleted_at":null}}
3. Confirm briefly: "Profile saved! How can I help you?"

RULES:
- Ask all questions in ONE message, not one by one.
- Create exactly ONE document (doc_id="${WORKSPACE_PROFILE_DOC_ID}"), not multiple.
- If the user wants to skip a question, that's fine — save what you have.
- Do NOT answer data queries until the profile is saved.`;
}

function buildLoadedWorkspacePrompt(ws: WorkspaceCheckResult): string {
  const profileContent = ws.profile?.content_md ?? "";

  const extraLines =
    ws.extras.length > 0
      ? `\n\nAdditional workspace docs:\n${ws.extras.map((d) => `- **${d.title || d.doc_type}** (${d.doc_id}): ${d.content_md.slice(0, 200)}${d.content_md.length > 200 ? "…" : ""}`).join("\n")}`
      : "";

  return `PROFILE LOADED — returning user.

${profileContent}${extraLines}

Use this profile as your operating context. Respect the communication style.
If the user updates preferences, update the profile via mongo_update on f_user_workspace (filter by doc_id="${WORKSPACE_PROFILE_DOC_ID}" + org_id + user_id).`;
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
