import { randomBytes } from "node:crypto";
import { google } from "googleapis";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

const TAG = "[gcal-meet]";

// Module-level logger — set during plugin registration, falls back to console.
let log: Logger = {
  info: (...args: unknown[]) => console.log(TAG, ...args),
  warn: (...args: unknown[]) => console.warn(TAG, ...args),
  error: (...args: unknown[]) => console.error(TAG, ...args),
};

function textResult(text: string, details?: unknown): ToolResult {
  return {
    content: [{ type: "text", text }],
    details: details ?? { text },
  };
}

const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar";
const DEFAULT_TIMEZONE = "Asia/Kolkata";

function getCalendarClient(pluginCfg: Record<string, unknown>) {
  // 1) Service account (keyFile path or credentials JSON string)
  const keyFile =
    (pluginCfg.keyFile as string) ||
    process.env.GOOGLE_CALENDAR_KEY_FILE ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const credentialsJson =
    (pluginCfg.credentialsJson as string) || process.env.GOOGLE_CALENDAR_CREDENTIALS_JSON;

  if (keyFile || credentialsJson) {
    log.info(
      "auth method=service-account",
      keyFile ? `keyFile=${keyFile}` : "credentialsJson=<set>",
    );
    const auth = new google.auth.GoogleAuth({
      ...(keyFile ? { keyFile } : { credentials: JSON.parse(credentialsJson as string) as object }),
      scopes: [CALENDAR_SCOPE],
    });
    const calendar = google.calendar({ version: "v3", auth });
    return calendar;
  }

  // 2) OAuth2 (refresh token) — use for personal calendar as pranavjhacoc@gmail.com
  const clientId = (pluginCfg.clientId as string) || process.env.GOOGLE_CALENDAR_CLIENT_ID;
  const clientSecret =
    (pluginCfg.clientSecret as string) || process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
  const refreshToken =
    (pluginCfg.refreshToken as string) || process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    log.error("auth failed — missing credentials", {
      hasClientId: !!clientId,
      hasClientSecret: !!clientSecret,
      hasRefreshToken: !!refreshToken,
    });
    throw new Error(
      "Google Calendar Meet plugin requires either (A) keyFile or credentialsJson (service account) or (B) clientId, clientSecret, and refreshToken (OAuth). " +
        "Config: plugins.google-calendar-meet. Env: GOOGLE_CALENDAR_KEY_FILE or GOOGLE_APPLICATION_CREDENTIALS, or GOOGLE_CALENDAR_CLIENT_ID, GOOGLE_CALENDAR_CLIENT_SECRET, GOOGLE_CALENDAR_REFRESH_TOKEN. " +
        "For OAuth (e.g. pranavjhacoc@gmail.com), get a refresh token via Google OAuth Playground with scope https://www.googleapis.com/auth/calendar.",
    );
  }

  log.info("auth method=oauth2 clientId=<set> refreshToken=<set>");
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, "urn:ietf:wg:oauth:2.0:oob");
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });
  return calendar;
}

async function executeGoogleMeet(
  _toolCallId: string,
  params: Record<string, unknown>,
  pluginCfg: Record<string, unknown>,
): Promise<ToolResult> {
  log.info("google_meet_create called", {
    summary: params.summary,
    startIso: params.startIso,
    endIso: params.endIso,
    attendeeEmails: params.attendeeEmails,
    recurrence: params.recurrence,
    calendarId: params.calendarId,
    timeZone: params.timeZone,
    sendUpdates: params.sendUpdates,
  });

  const summary = params.summary as string;
  const startIso = params.startIso as string;
  const endIso = params.endIso as string;
  if (!summary?.trim() || !startIso?.trim() || !endIso?.trim()) {
    log.warn("missing required params", {
      hasSummary: !!summary?.trim(),
      hasStart: !!startIso?.trim(),
      hasEnd: !!endIso?.trim(),
    });
    return textResult("Error: summary, startIso, and endIso are required.", {
      error: "missing_params",
    });
  }

  let attendeeEmails: string[] = [];
  const raw = params.attendeeEmails;
  if (typeof raw === "string" && raw.trim()) {
    attendeeEmails = raw
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
  } else if (Array.isArray(raw)) {
    attendeeEmails = raw
      .filter((e) => typeof e === "string" && e.trim())
      .map((e) => String(e).trim());
  }

  const calendarId = (params.calendarId as string)?.trim() || "primary";
  const sendUpdates = ((params.sendUpdates as string)?.trim() || "all").toLowerCase();
  const timeZone = (params.timeZone as string)?.trim() || DEFAULT_TIMEZONE;

  // Recurrence: accept a single RRULE string or an array of RRULE/EXRULE/RDATE/EXDATE strings.
  let recurrence: string[] | undefined;
  const rawRecurrence = params.recurrence;
  if (typeof rawRecurrence === "string" && rawRecurrence.trim()) {
    recurrence = [rawRecurrence.trim()];
  } else if (Array.isArray(rawRecurrence)) {
    recurrence = rawRecurrence
      .filter((r) => typeof r === "string" && (r as string).trim())
      .map((r) => String(r).trim());
    if (recurrence.length === 0) recurrence = undefined;
  }

  log.info("resolved params", {
    summary: summary.trim(),
    start: startIso,
    end: endIso,
    attendees: attendeeEmails,
    calendarId,
    sendUpdates,
    timeZone,
    recurrence: recurrence ?? "none",
  });

  let calendar;
  try {
    calendar = getCalendarClient(pluginCfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("auth error", msg);
    return textResult(msg, { error: "config" });
  }

  const start = { dateTime: startIso, timeZone };
  const end = { dateTime: endIso, timeZone };

  const requestId = randomBytes(12).toString("hex");
  const body: Record<string, unknown> = {
    summary: summary.trim(),
    start,
    end,
    conferenceData: {
      createRequest: {
        requestId,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  if (recurrence) {
    body.recurrence = recurrence;
    log.info("recurring event", { recurrence });
  }

  if (attendeeEmails.length > 0) {
    body.attendees = attendeeEmails.map((email) => ({ email }));
    log.info("attendees added", { count: attendeeEmails.length, emails: attendeeEmails });
  } else {
    log.info("no attendees");
  }

  log.info("inserting event via Calendar API", {
    calendarId,
    sendUpdates,
    hasRecurrence: !!recurrence,
  });

  try {
    const res = await calendar.events.insert({
      calendarId,
      conferenceDataVersion: 1,
      sendUpdates: sendUpdates === "none" ? "none" : "all",
      requestBody: body,
    });

    const event = res.data as {
      conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
      htmlLink?: string | null;
      id?: string | null;
      summary?: string | null;
    };
    const entryPoints = event.conferenceData?.entryPoints ?? [];
    const videoEntry = entryPoints.find((ep) => ep.entryPointType === "video");
    const meetLink = videoEntry?.uri ?? entryPoints[0]?.uri ?? null;
    const eventLink = event.htmlLink ?? null;
    const eventId = event.id ?? null;

    log.info("event created successfully", {
      eventId,
      meetLink,
      eventLink,
      summary: event.summary ?? summary,
      recurrence: recurrence ?? "none",
    });

    const out = [
      "Created event: " + (event.summary ?? summary),
      meetLink
        ? "Google Meet link: " + meetLink
        : "Meet link not returned (check Calendar API quota).",
      eventLink ? "Calendar event: " + eventLink : "",
      recurrence ? "Recurrence: " + recurrence.join("; ") : "",
    ]
      .filter(Boolean)
      .join("\n");

    return textResult(out, {
      meetLink: meetLink ?? null,
      eventLink: eventLink ?? null,
      eventId,
      summary: event.summary ?? summary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Calendar API insert failed", { error: msg, calendarId, summary: summary.trim() });
    return textResult("Google Calendar API error: " + msg, { error: msg });
  }
}

async function executeCalendarEventUpdate(
  _toolCallId: string,
  params: Record<string, unknown>,
  pluginCfg: Record<string, unknown>,
): Promise<ToolResult> {
  log.info("google_calendar_event_update called", {
    eventId: params.eventId,
    summary: params.summary,
    addAttendeeEmails: params.addAttendeeEmails,
    calendarId: params.calendarId,
    sendUpdates: params.sendUpdates,
  });

  const eventId = (params.eventId as string)?.trim();
  if (!eventId) {
    log.warn("missing eventId");
    return textResult("Error: eventId is required.", { error: "missing_params" });
  }

  const calendarId = (params.calendarId as string)?.trim() || "primary";
  const sendUpdates = ((params.sendUpdates as string)?.trim() || "all").toLowerCase();

  let newSummary: string | undefined;
  const s = (params.summary as string)?.trim();
  if (s) {
    newSummary = s;
  }

  let addAttendeeEmails: string[] = [];
  const raw = params.addAttendeeEmails;
  if (typeof raw === "string" && raw.trim()) {
    addAttendeeEmails = raw
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
  } else if (Array.isArray(raw)) {
    addAttendeeEmails = raw
      .filter((e) => typeof e === "string" && (e as string).trim())
      .map((e) => String(e).trim());
  }

  log.info("resolved update params", {
    eventId,
    calendarId,
    sendUpdates,
    newSummary: newSummary ?? "unchanged",
    addAttendees: addAttendeeEmails.length > 0 ? addAttendeeEmails : "none",
  });

  let calendar;
  try {
    calendar = getCalendarClient(pluginCfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("auth error", msg);
    return textResult(msg, { error: "config" });
  }

  try {
    log.info("fetching existing event", { eventId, calendarId });
    const existing = await calendar.events.get({
      calendarId,
      eventId,
    });
    const event = existing.data as {
      summary?: string | null;
      attendees?: Array<{ email?: string | null }>;
      conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
      htmlLink?: string | null;
    };

    log.info("existing event fetched", {
      summary: event.summary,
      existingAttendees: (event.attendees ?? []).map((a) => a.email),
      hasMeetLink: !!event.conferenceData?.entryPoints?.length,
    });

    const body: Record<string, unknown> = {};
    if (newSummary !== undefined) {
      body.summary = newSummary;
    }
    if (addAttendeeEmails.length > 0) {
      const existingEmails = new Set(
        (event.attendees ?? []).map((a) => (a.email ?? "").toLowerCase()).filter(Boolean),
      );
      const combined = [...(event.attendees ?? [])];
      for (const email of addAttendeeEmails) {
        if (!existingEmails.has(email.toLowerCase())) {
          combined.push({ email });
          existingEmails.add(email.toLowerCase());
        }
      }
      body.attendees = combined;
      log.info("attendees merged", {
        existing: (event.attendees ?? []).length,
        adding: addAttendeeEmails.length,
        total: combined.length,
      });
    }

    if (Object.keys(body).length === 0) {
      log.warn("no changes to apply", { eventId });
      return textResult("No changes specified. Provide summary and/or addAttendeeEmails.", {
        error: "no_changes",
      });
    }

    log.info("patching event", { eventId, calendarId, changes: Object.keys(body) });
    const updated = await calendar.events.patch({
      calendarId,
      eventId,
      sendUpdates: sendUpdates === "none" ? "none" : "all",
      requestBody: body,
    });

    const updatedEvent = updated.data as {
      summary?: string | null;
      htmlLink?: string | null;
      conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
    };
    const entryPoints = updatedEvent.conferenceData?.entryPoints ?? [];
    const videoEntry = entryPoints.find((ep) => ep.entryPointType === "video");
    const meetLink = videoEntry?.uri ?? entryPoints[0]?.uri ?? null;

    log.info("event updated successfully", {
      eventId,
      summary: updatedEvent.summary,
      meetLink,
      eventLink: updatedEvent.htmlLink,
    });

    const lines = [
      "Updated event: " + (updatedEvent.summary ?? event.summary ?? eventId),
      meetLink ? "Meet link (unchanged): " + meetLink : "",
      updatedEvent.htmlLink ? "Calendar event: " + updatedEvent.htmlLink : "",
    ].filter(Boolean);

    return textResult(lines.join("\n"), {
      meetLink: meetLink ?? null,
      eventLink: updatedEvent.htmlLink ?? null,
      summary: updatedEvent.summary ?? newSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error("Calendar API update failed", { error: msg, eventId, calendarId });
    return textResult("Google Calendar API error: " + msg, { error: msg });
  }
}

function createGoogleMeetTool(pluginCfg: Record<string, unknown>): AnyAgentTool {
  const cfg = pluginCfg;
  return {
    name: "google_meet_create",
    label: "Create Google Meet event",
    description:
      "Create a Google Calendar event with a Google Meet (video) link and notify attendees. " +
      "Required: summary, startIso, endIso (ISO-8601 with timezone offset, e.g. 2026-02-20T17:30:00+05:30 for IST). " +
      "Optional: attendeeEmails (comma-separated), calendarId (default primary), sendUpdates (all sends invite email with Meet link), timeZone (default Asia/Kolkata). " +
      "RECURRING / MULTI-DAY MEETINGS: If the user wants a meeting for multiple days with the SAME Meet link, " +
      "you MUST use the 'recurrence' parameter with a single call. Do NOT call this tool multiple times — that creates different Meet links each time. " +
      "Example: for 'next 6 days' use recurrence='RRULE:FREQ=DAILY;COUNT=6'. For 'a week' use COUNT=7. " +
      "The recurrence parameter accepts RFC 5545 RRULE strings. All recurring occurrences share the same Google Meet link. " +
      "Returns: meetLink, eventLink, eventId.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Event title (e.g. Meeting with Alice)." },
        startIso: {
          type: "string",
          description: "Start time ISO-8601 (e.g. 2026-02-27T11:00:00+05:30 for 11 AM IST).",
        },
        endIso: {
          type: "string",
          description: "End time ISO-8601 (e.g. 2026-02-27T12:00:00+05:30 for 12 PM IST).",
        },
        attendeeEmails: {
          type: "string",
          description:
            "Comma-separated attendee emails; they get the calendar invite with Meet link.",
        },
        calendarId: { type: "string", description: "Calendar ID (default primary)." },
        sendUpdates: {
          type: "string",
          description: "all (default) sends invite emails; none does not.",
        },
        timeZone: { type: "string", description: "IANA timezone (default Asia/Kolkata)." },
        recurrence: {
          type: "string",
          description:
            "RFC 5545 recurrence rule for multi-day meetings with the SAME Meet link. " +
            "ALWAYS use this when user wants meetings on multiple days. " +
            "Examples: 'RRULE:FREQ=DAILY;COUNT=6' (daily 6 days), 'RRULE:FREQ=DAILY;COUNT=7' (a week), " +
            "'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6' (Mon/Wed/Fri for 2 weeks). " +
            "NEVER create multiple separate events — use recurrence instead so all days share one Meet link.",
        },
      },
    },
    execute: (id: string, params: Record<string, unknown>) => executeGoogleMeet(id, params, cfg),
  };
}

function createCalendarEventUpdateTool(pluginCfg: Record<string, unknown>): AnyAgentTool {
  const cfg = pluginCfg;
  return {
    name: "google_calendar_event_update",
    label: "Update Google Calendar event",
    description:
      "Update an existing calendar event: change title (summary) and/or add attendees. Same Meet link is kept. Use when the user says 'add X to the same meet', 'send the same meet to X', or 'update the title to Y'. Required: eventId (from the event creation response or calendar API). Optional: summary (new title), addAttendeeEmails (comma-separated; they receive the invite and event appears on their calendar), calendarId (default primary), sendUpdates (all = notify all attendees, default).",
    parameters: {
      type: "object",
      properties: {
        eventId: {
          type: "string",
          description: "Google Calendar event ID (returned when the event was created).",
        },
        summary: { type: "string", description: "New event title (e.g. Climate control)." },
        addAttendeeEmails: {
          type: "string",
          description:
            "Comma-separated emails to add as attendees; they get the calendar invite with the same Meet link.",
        },
        calendarId: { type: "string", description: "Calendar ID (default primary)." },
        sendUpdates: {
          type: "string",
          description: "all (default) notifies all attendees of the update; none does not.",
        },
      },
    },
    execute: (id: string, params: Record<string, unknown>) =>
      executeCalendarEventUpdate(id, params, cfg),
  };
}

// Plugin config is not on globalThis; we need to receive it at register time.
function createTools(pluginCfg: Record<string, unknown>): AnyAgentTool[] {
  return [createGoogleMeetTool(pluginCfg), createCalendarEventUpdateTool(pluginCfg)];
}

const plugin = {
  id: "google-calendar-meet",
  name: "Google Calendar Meet",
  description:
    "Create Google Calendar events with a Google Meet (video) link. Attendees receive the invite email with the Meet URL.",

  register(api: OpenClawPluginApi) {
    // Wire up the module-level logger to the plugin API logger.
    log = {
      info: (msg: unknown, meta?: unknown) =>
        api.logger.info(`${TAG} ${msg} ${meta ? JSON.stringify(meta) : ""}`.trim()),
      warn: (msg: unknown, meta?: unknown) =>
        api.logger.warn(`${TAG} ${msg} ${meta ? JSON.stringify(meta) : ""}`.trim()),
      error: (msg: unknown, meta?: unknown) =>
        api.logger.error(`${TAG} ${msg} ${meta ? JSON.stringify(meta) : ""}`.trim()),
    };

    const pluginCfg = (api.pluginConfig ?? {}) as Record<string, unknown>;
    api.registerTool(() => createTools(pluginCfg), {
      names: ["google_meet_create", "google_calendar_event_update"],
    });
    log.info("plugin registered", {
      tools: ["google_meet_create", "google_calendar_event_update"],
      hasKeyFile: !!(
        pluginCfg.keyFile ||
        process.env.GOOGLE_CALENDAR_KEY_FILE ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS
      ),
      hasCredentialsJson: !!(
        pluginCfg.credentialsJson || process.env.GOOGLE_CALENDAR_CREDENTIALS_JSON
      ),
      hasOAuth: !!(pluginCfg.clientId || process.env.GOOGLE_CALENDAR_CLIENT_ID),
    });
  },
};

export default plugin;
