---
name: lead-meeting-schedule
description: Schedule a meeting with a lead or an email at a specified time; create Meet and notify invitee (calendar email; optional reminder).
metadata:
  {
    "openclaw":
      {
        "requires": { "bins": ["gog"], "tools": ["mongo_find", "cron", "exec"] },
        "optionalTools": ["google_meet_create", "google_calendar_event_update"],
      },
  }
---

# Schedule meeting and notify invitee

When the user asks to **schedule a meet/meeting** with someone **at a specified time** and to **notify** them (e.g. "schedule a meet with X at 8PM today and notify"), you **must** create a real calendar event with a Meet link and add the invitee as attendee so they receive the **Google Calendar invite email** with the Meet link. Do **not** only set a reminder for the user to "do it yourself"—create the meeting and notify the invitee.

**Time zone:** For all meet-creation queries, interpret times as **IST (Indian Standard Time, UTC+5:30)** unless the user explicitly states another timezone. Use ISO-8601 with offset `+05:30` for IST (e.g. 8:00 PM IST → `20:00:00+05:30`).

**Required outcome:** The invitee must receive a **Google Calendar invite email** (event on their calendar + Meet link). Optionally send them a reminder (e.g. WhatsApp) 30 minutes before. To achieve the invite email, you **must** create the event with the invitee as attendee and **always** use **sendUpdates: all** (google_meet_create) or **`--send-updates all`** (gog). Never skip this; otherwise the invitee gets no email.

## When the user gives an email directly

If the user says e.g. **"schedule a meet with pjhastudy1234@gmail.com at 8:00 PM today and notify"** (email provided in the message):

1. **Parse the time** in IST: e.g. 8:00 PM today → start `YYYY-MM-DDTH20:00:00+05:30`, end start + 1 hour.
2. **Create the meeting immediately** (do not only set a reminder):
   - **If you have the `google_meet_create` tool:** Call it with **summary** (e.g. "Meeting with pjhastudy1234@gmail.com"), **startIso**, **endIso**, **attendeeEmails**: `pjhastudy1234@gmail.com`, **sendUpdates**: `all`. The invitee will receive the calendar invite email with the Meet link.
   - **If you do not have google_meet_create:** Use **gog** (see fallback in step 3 below) with that email as attendee and `--send-updates all`.
3. **Confirm to the user:** e.g. "Done. I've created a Google Meet for 8 PM today and added pjhastudy1234@gmail.com as attendee—they'll get a calendar invite email with the Meet link."
4. Optionally, if the user also asked for a "reminder 30 min before" and you have the invitee’s phone and WhatsApp/cron configured, add the cron reminder as in the lead workflow below.

If you **do not** have **google_meet_create** (or gog) available, say so clearly and suggest enabling the Google Calendar Meet plugin or gog so you can create the meeting and notify the invitee; do not offer only a reminder for the user to send the link themselves.

## Update an existing meet (same link): add attendee and/or change title

When the user says e.g. **"send the same meet to tameesh@fix-it.ai"**, **"add X to the same meet"**, **"update the title to Climate control"**, or **"notify pjha that it's a climate control meet"** (after you already created a meet):

1. **Use the eventId** from when you created that meet (it was in the **google_meet_create** tool result; keep it in context for the conversation).
2. **If you have the `google_calendar_event_update` tool:** Call it with:
   - **eventId**: the event ID from the create step.
   - **summary**: new title if requested (e.g. "Climate control").
   - **addAttendeeEmails**: comma-separated emails to add (e.g. `tameesh@fix-it.ai`); they receive the calendar invite and the **same Meet link** appears on their calendar.
   - **sendUpdates**: `all` so all attendees (existing and new) get the update.
3. **Confirm:** e.g. "Done. I've added tameesh@fix-it.ai to the same Meet and set the title to Climate control. Both attendees' calendars are updated and they'll get the invite/update email."
4. If you do **not** have **google_calendar_event_update**, and gog supports updating an event with new attendees and `--send-updates all`, use that; otherwise say you can't update existing events and suggest enabling the Google Calendar Meet plugin (which provides google_calendar_event_update).

---

## When the user names a lead (lookup in d_leads)

When the user asks to **schedule a meeting with a lead at a specified time** and to **send the meeting link 30 minutes before**, follow the workflow below. Use the **direct-email** flow above if the user already provided an email and you have google_meet_create or gog.

## Prerequisites

- **gog** installed and authenticated (`gog auth add ... --services calendar`).
- **MongoDB** plugin with `d_leads` collection (leads have `lead_name`, `lead_phone_no`).
- **Cron** tool and **WhatsApp** channel configured so cron can deliver to a phone number.
- Default calendar: use `primary` for gog unless the user specifies another calendar.

## Steps

### 1. Resolve the lead

- Use **mongo_find** on collection **d_leads** with a filter that matches the lead (e.g. `lead_name` or `lead_phone_no` from the user’s message).
- From the result, take **lead_name**, **lead_phone_no**, and **lead email** if available (e.g. a field like `lead_email` or `lead_data.email` in the document, or from the user’s message e.g. “Samar (samar310804@gmail.com)”). You need the invitee’s email so they can be added as an attendee and receive the Google Calendar invite.
- If the lead’s email is not in the data and the user did not provide it, **ask for the invitee’s email** so the calendar event can be created with them as attendee (they will then get the event on their calendar and an email from Google Calendar).
- Normalize **lead_phone_no** for WhatsApp: use E.164 (e.g. if stored as `919140223349`, use `+919140223349` or the format your WhatsApp delivery expects).

### 2. Parse the meeting time

- **Times are in IST** unless the user says otherwise. Derive **start** and **end** in **IST** and express as ISO-8601 with `+05:30` (e.g. 5:30 PM today → `2026-02-20T17:30:00+05:30`).
- Default duration if only start is given: e.g. **1 hour** (adjust if the user says otherwise).
- Compute **reminderTime** = start minus **30 minutes** (ISO-8601).

### 3. Create the calendar event (with Google Meet link and invite email)

- **Preferred (when available):** Use the **google_meet_create** tool so the invitee receives a **Google Meet (video) link** in their calendar invite email, not just a calendar event link. Call it with:
  - **summary**: e.g. `Meeting with <lead_name>`
  - **startIso**, **endIso**: the meeting start and end in ISO-8601 (e.g. `2026-02-20T17:30:00+05:30`)
  - **attendeeEmails**: the lead’s email (so they get the invite email with the Meet link)
  - **sendUpdates**: `all` (default)
  - Use the returned **meetLink** (Google Meet URL) for the 30‑minute reminder message.
- **Fallback (no google_meet_create):** Run **gog** to create the event with the lead as attendee and **always send invites**:
  - `gog calendar create primary --summary "Meeting with <lead_name>" --from <startISO> --to <endISO> --attendees "<invitee_email>" --send-updates all`
  - Use the lead’s email as `<invitee_email>`. **You must include `--send-updates all` in every gog calendar create command** that has attendees; without it the invitee does not receive the calendar invite email.
  - If the command output includes a **meeting link** (Meet/hangout), use it for the reminder; otherwise use the **calendar event link** or “Check your calendar invite for the link.”

### 4. Schedule the “send link 30 min before” reminder

- Use the **cron** tool with action **add** to create a **one-shot** job:
  - **name**: e.g. `Meeting reminder: <lead_name>`
  - **schedule**: `{ "kind": "at", "at": "<reminderTime ISO-8601>" }` (the time 30 minutes before the meeting start).
  - **sessionTarget**: `isolated`
  - **payload**: `{ "kind": "agentTurn", "message": "Output exactly this and nothing else: 'Hi <lead_name>, your meeting is in 30 minutes. Join here: <meeting_link>.'" }`
  - **delivery**: `{ "mode": "announce", "channel": "whatsapp", "to": "<lead_phone_no E.164>" }`
  - **deleteAfterRun**: true (so the job is removed after it runs).
- Ensure **delivery.to** is the lead’s WhatsApp number in the format your gateway expects (usually E.164 with `+`).

### 5. Confirm to the user

- Tell the user that:
  - The meeting is scheduled at the given time (and in which calendar).
  - The **invitee will receive a Google Calendar invite email** and the event will appear on their calendar (because you used `--attendees` and `--send-updates all`).
  - A reminder with the meeting link will be sent to the lead **30 minutes before** the meeting via WhatsApp (if configured).

## Example (conceptual)

- User: “Schedule a meeting with Surat at 3pm tomorrow and send the link half an hour before.”
- You: find lead “Surat” in d_leads → get `lead_phone_no` (e.g. `+919140223349`); parse “3pm tomorrow” → start `2026-02-21T15:00:00` (local), end `2026-02-21T16:00:00`; reminder at `2026-02-21T14:30:00`; create event with gog; add cron job at 14:30 with delivery to that WhatsApp number and the meeting link in the message.

## Notes

- **Time zone:** Meet-creation times are **IST (UTC+5:30)** unless the user specifies otherwise. Use ISO-8601 with `+05:30` for start/end.
- **Invitees and send-updates:** Always add `--attendees "<email>"` and **always** pass **`--send-updates all`** when using gog to create a meeting. Never skip `--send-updates all`; without it the invitee does not get the calendar invite email.
- If **gog calendar create** does not return a Meet/hangout link, the reminder can still include the calendar event URL if you have it, or a generic line like “Check your calendar invite for the join link.”
- **Cron** delivery to WhatsApp requires the gateway to have WhatsApp configured and delivery to the given `to` (lead’s number) allowed by your config.
- **Recurrence:** When creating recurring events, always use `recurrence` with google_meet_create instead of creating multiple separate events. This ensures all occurrences share the same Meet link.

## Recurring meetings (same Meet link for multiple days)

When the user asks to schedule a meeting **for multiple consecutive days** (e.g. "schedule a meet for the next N days at X time"), you **must** create a **single recurring event** using the `recurrence` parameter so that **all occurrences share the same Google Meet link**. Do **not** create N separate events (each would get a different Meet link).

Keywords/phrases that indicate a recurring meeting: "for the next N days", "daily for N days", "every day for N days", "same meet link", "same link", "recurring", "repeat daily", "for a week", etc.

### How to use `recurrence`

The `recurrence` parameter accepts an RFC 5545 RRULE string. Dynamically construct the RRULE based on the user's request:

- **Daily for N days:** `RRULE:FREQ=DAILY;COUNT=<N>` where `<N>` is the number of days the user specifies (e.g. 3, 6, 7, 30, etc.)
- **Daily until a specific date:** `RRULE:FREQ=DAILY;UNTIL=<YYYYMMDD>T<HHMMSS>Z` (UNTIL must be in UTC)
- **Weekly on specific days:** `RRULE:FREQ=WEEKLY;BYDAY=<DAYS>;COUNT=<N>` (e.g. BYDAY=MO,WE,FR)
- **For a week:** `RRULE:FREQ=DAILY;COUNT=7`

### How to handle the request dynamically

1. **Extract from the user's message:**
   - `<EMAIL>`: the attendee's email address (any valid email)
   - `<TIME>`: the meeting time (parse to IST unless user specifies another timezone)
   - `<N>`: the number of days/occurrences
   - `<DURATION>`: default 1 hour unless user specifies otherwise

2. **Parse the time in IST:** Convert `<TIME>` to ISO-8601 with `+05:30`. Compute:
   - `startIso` = first occurrence date at `<TIME>` → e.g. `YYYY-MM-DDT<HH:MM:SS>+05:30`
   - `endIso` = `startIso` + `<DURATION>` → e.g. `YYYY-MM-DDT<HH+1:MM:SS>+05:30`

3. **Create meeting with `google_meet_create`:**
   - **summary**: `"Meeting with <EMAIL>"` (or lead name if resolved from d_leads)
   - **startIso**: computed start time
   - **endIso**: computed end time
   - **attendeeEmails**: `<EMAIL>`
   - **sendUpdates**: `all`
   - **recurrence**: `RRULE:FREQ=DAILY;COUNT=<N>`

4. The result will have **one Meet link** shared across **all `<N>` occurrences**. The invitee gets calendar events for all days.

### Example patterns

| User says                   | recurrence value                                                    |
| --------------------------- | ------------------------------------------------------------------- |
| "for the next 6 days"       | `RRULE:FREQ=DAILY;COUNT=6`                                          |
| "for 3 days"                | `RRULE:FREQ=DAILY;COUNT=3`                                          |
| "for a week"                | `RRULE:FREQ=DAILY;COUNT=7`                                          |
| "every weekday for 2 weeks" | `RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10`                   |
| "daily until March 10"      | `RRULE:FREQ=DAILY;UNTIL=20260310T183000Z` (convert end date to UTC) |
