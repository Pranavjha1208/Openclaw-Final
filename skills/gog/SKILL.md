---
name: gog
description: Google Workspace CLI for Gmail, Calendar, Drive, Contacts, Sheets, and Docs.
homepage: https://gogcli.sh
metadata:
  {
    "openclaw":
      {
        "emoji": "🎮",
        "requires": { "bins": ["gog"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "steipete/tap/gogcli",
              "bins": ["gog"],
              "label": "Install gog (brew)",
            },
          ],
      },
  }
---

# gog

Use `gog` for Gmail/Calendar/Drive/Contacts/Sheets/Docs. Requires OAuth setup.

Setup (once)

- `gog auth credentials /path/to/client_secret.json`
- `gog auth add you@gmail.com --services gmail,calendar,drive,contacts,docs,sheets`
- `gog auth list`

OAuth redirect_uri_mismatch (Error 400): `gog` starts a local callback server on a **random port** each run (e.g. `http://127.0.0.1:57512/oauth2/callback`). Google requires the exact redirect URI to be allowed. **Fix:** In [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Credentials → your OAuth 2.0 Client ID → **Authorized redirect URIs**, add the **exact** URI from the error (e.g. `http://127.0.0.1:57512/oauth2/callback`). Because the port changes each run, add **multiple** URIs for ports gog might use: e.g. `http://127.0.0.1:56557/oauth2/callback`, `http://127.0.0.1:56605/oauth2/callback`, `http://127.0.0.1:57512/oauth2/callback`, and a few more in the 56xxx–58xxx range. After adding, retry `gog auth add`. Alternatively, create a **Desktop application** OAuth client (not Web) and use its `client_secret.json` with `gog auth credentials`; some Desktop clients use a fixed redirect (e.g. `http://localhost`) which may work without adding many URIs.

Common commands

- Gmail search: `gog gmail search 'newer_than:7d' --max 10`
- Gmail messages search (per email, ignores threading): `gog gmail messages search "in:inbox from:ryanair.com" --max 20 --account you@example.com`
- Gmail send (plain): `gog gmail send --to a@b.com --subject "Hi" --body "Hello"`
- Gmail send (multi-line): `gog gmail send --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send (stdin): `gog gmail send --to a@b.com --subject "Hi" --body-file -`
- Gmail send (HTML): `gog gmail send --to a@b.com --subject "Hi" --body-html "<p>Hello</p>"`
- Gmail draft: `gog gmail drafts create --to a@b.com --subject "Hi" --body-file ./message.txt`
- Gmail send draft: `gog gmail drafts send <draftId>`
- Gmail reply: `gog gmail send --to a@b.com --subject "Re: Hi" --body "Reply" --reply-to-message-id <msgId>`
- Calendar list events: `gog calendar events <calendarId> --from <iso> --to <iso>`
- Calendar create event: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso>`. Use `primary` as calendarId for the default calendar. If the command output includes a meeting/hangout link, use it for reminders.
- Calendar create with **attendees** (so the invitee gets the event and a Google Calendar email): `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --attendees "email@example.com" --send-updates all`. **You must always include `--send-updates all`** when creating a meeting with attendees; without it the invitee does not receive the calendar invite email. Never omit it.
- **Meet-creation time zone:** When the user asks to create a meeting and does not specify a timezone, treat the time as **IST (Indian Standard Time, UTC+5:30)**. Use ISO-8601 with `+05:30` for --from and --to (e.g. 5:30 PM IST → `2026-02-20T17:30:00+05:30`).
- Example (meeting with one invitee; --send-updates all is required): `gog calendar create primary --summary "Meeting with Alice" --from 2026-02-20T17:30:00+05:30 --to 2026-02-20T18:30:00+05:30 --attendees "alice@example.com" --send-updates all`
- Calendar create with color: `gog calendar create <calendarId> --summary "Title" --from <iso> --to <iso> --event-color 7`
- Calendar update event: `gog calendar update <calendarId> <eventId> --summary "New Title" --event-color 4`. If your gog build supports `--attendees` and `--send-updates all` on update, use them to add attendees to an existing event and notify everyone (same Meet link).
- **Update existing Meet (same link):** If you have the **google_calendar_event_update** tool, use it to add attendees and/or change the title of an existing event without creating a new Meet. Required: **eventId** (from when the event was created). Optional: **summary** (new title), **addAttendeeEmails** (comma-separated; they get the invite and the event appears on their calendar), **sendUpdates**: `all`. Example: after creating a meet you get `eventId` in the tool result; when the user says "send the same meet to tameesh@fix-it.ai and update the title to Climate control", call **google_calendar_event_update** with that eventId, summary `"Climate control"`, addAttendeeEmails `"tameesh@fix-it.ai"`, sendUpdates `all`. All attendees (existing and new) get updated; their calendars show the same Meet link.
- Calendar show colors: `gog calendar colors`
- Drive search: `gog drive search "query" --max 10`
- Contacts: `gog contacts list --max 20`
- Sheets get: `gog sheets get <sheetId> "Tab!A1:D10" --json`
- Sheets update: `gog sheets update <sheetId> "Tab!A1:B2" --values-json '[["A","B"],["1","2"]]' --input USER_ENTERED`
- Sheets append: `gog sheets append <sheetId> "Tab!A:C" --values-json '[["x","y","z"]]' --insert INSERT_ROWS`
- Sheets clear: `gog sheets clear <sheetId> "Tab!A2:Z"`
- Sheets metadata: `gog sheets metadata <sheetId> --json`
- Docs export: `gog docs export <docId> --format txt --out /tmp/doc.txt`
- Docs cat: `gog docs cat <docId>`

Calendar Colors

- Use `gog calendar colors` to see all available event colors (IDs 1-11)
- Add colors to events with `--event-color <id>` flag
- Event color IDs (from `gog calendar colors` output):
  - 1: #a4bdfc
  - 2: #7ae7bf
  - 3: #dbadff
  - 4: #ff887c
  - 5: #fbd75b
  - 6: #ffb878
  - 7: #46d6db
  - 8: #e1e1e1
  - 9: #5484ed
  - 10: #51b749
  - 11: #dc2127

Email Formatting

- Prefer plain text. Use `--body-file` for multi-paragraph messages (or `--body-file -` for stdin).
- Same `--body-file` pattern works for drafts and replies.
- `--body` does not unescape `\n`. If you need inline newlines, use a heredoc or `$'Line 1\n\nLine 2'`.
- Use `--body-html` only when you need rich formatting.
- HTML tags: `<p>` for paragraphs, `<br>` for line breaks, `<strong>` for bold, `<em>` for italic, `<a href="url">` for links, `<ul>`/`<li>` for lists.
- Example (plain text via stdin):

  ```bash
  gog gmail send --to recipient@example.com \
    --subject "Meeting Follow-up" \
    --body-file - <<'EOF'
  Hi Name,

  Thanks for meeting today. Next steps:
  - Item one
  - Item two

  Best regards,
  Your Name
  EOF
  ```

- Example (HTML list):
  ```bash
  gog gmail send --to recipient@example.com \
    --subject "Meeting Follow-up" \
    --body-html "<p>Hi Name,</p><p>Thanks for meeting today. Here are the next steps:</p><ul><li>Item one</li><li>Item two</li></ul><p>Best regards,<br>Your Name</p>"
  ```

Notes

- Set `GOG_ACCOUNT=you@gmail.com` to avoid repeating `--account`.
- For scripting, prefer `--json` plus `--no-input`.
- Sheets values can be passed via `--values-json` (recommended) or as inline rows.
- Docs supports export/cat/copy. In-place edits require a Docs API client (not in gog).
- Confirm before sending mail or creating events.
- `gog gmail search` returns one row per thread; use `gog gmail messages search` when you need every individual email returned separately.

Troubleshooting: calendar/Gmail stopped working after changing the bot or moving the gateway

- gog’s Google (Calendar/Gmail) auth is **per-environment**: it lives on the machine where the gateway runs (and under the user/process that runs it). It is **not** tied to the Telegram bot token.
- If you changed the Telegram bot or moved OpenClaw to a new server (e.g. AWS), the **new** environment has no gog credentials until you add them.
- **Fix:** On the **same machine (and user) that runs the gateway**, run gog auth again:
  - `gog auth credentials /path/to/client_secret.json`
  - `gog auth add you@gmail.com --services calendar,gmail,...`
- **Docker:** Set `GOG_KEYRING_PASSWORD` and `XDG_CONFIG_HOME` (e.g. `XDG_CONFIG_HOME=/home/node/.openclaw`) in the container env, persist the config dir as a volume, and run `gog auth add` **inside that container** (or copy an existing gog config into the volume) so the gateway process can use it when it runs `gog` via exec.
