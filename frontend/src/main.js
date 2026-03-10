/**
 * Fixit Chat demo — calls OpenClaw gateway Fixit API (REST + SSE).
 * Configure API base URL and JWT, then send messages and stream responses.
 */

const FIXIT_API_PREFIX = "/api/fixit";

function getApiBase() {
  const el = document.getElementById("apiBase");
  const v = el?.value?.trim();
  return v || "";
}

function getOrgId() {
  const el = document.getElementById("orgId");
  return el?.value?.trim() || "";
}

function getUserId() {
  const el = document.getElementById("userId");
  return el?.value?.trim() || "";
}

function getCampaignId() {
  const el = document.getElementById("campaignId");
  return el?.value?.trim() || "";
}

/** Return true if both org and user are set (mandatory for all authenticated actions). */
function hasRequiredIdentity() {
  return Boolean(getOrgId() && getUserId());
}

function getAuthHeader() {
  const el = document.getElementById("jwt");
  const token = el?.value?.trim();
  if (!token) {
    return null;
  }
  return { Authorization: `Bearer ${token}` };
}

function updateJwtCommand() {
  const el = document.getElementById("jwtCommand");
  if (!el) {
    return;
  }
  const org = getOrgId();
  const user = getUserId();
  const campaign = getCampaignId();
  const base = `cd frontend && node scripts/gen-fixit-jwt.js YOUR_JWT_SECRET ${org} ${user}`;
  el.textContent = campaign ? `${base} ${campaign}` : base;
}

function apiUrl(path) {
  const base = getApiBase();
  const p = path.startsWith("/") ? path : `/${path}`;
  const fullPath = `${FIXIT_API_PREFIX}${p}`;
  return base ? `${base.replace(/\/+$/, "")}${fullPath}` : fullPath;
}

async function apiFetch(path, options = {}) {
  const url = apiUrl(path);
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  const auth = getAuthHeader();
  if (auth) {
    Object.assign(headers, auth);
  }

  console.log(`[fixit] ${options.method || "GET"} ${url}`);

  const res = await fetch(url, { ...options, headers });
  console.log(`[fixit] ${res.status} ${res.statusText} ← ${url}`);

  if (!res.ok) {
    const text = await res.text();
    console.error(`[fixit] error body:`, text);
    let errBody;
    try {
      errBody = JSON.parse(text);
    } catch {
      errBody = { error: text || res.statusText };
    }
    throw new Error(errBody.error || errBody.message || `HTTP ${res.status}`);
  }
  return res;
}

function setVerifyStatus(ok, text) {
  const el = document.getElementById("verifyStatus");
  if (!el) {
    return;
  }
  el.textContent = text;
  el.className = "status " + (ok ? "ok" : "err");
}

function setJwtValue(token) {
  const el = document.getElementById("jwt");
  if (el) {
    el.value = token;
  }
}

// --- JWT command (copy) ---
updateJwtCommand();
document.getElementById("orgId")?.addEventListener("input", updateJwtCommand);
document.getElementById("userId")?.addEventListener("input", updateJwtCommand);
document.getElementById("campaignId")?.addEventListener("input", updateJwtCommand);

document.getElementById("btnCopyCommand")?.addEventListener("click", () => {
  const el = document.getElementById("jwtCommand");
  if (!el) {
    return;
  }
  navigator.clipboard.writeText(el.textContent).then(
    () => setVerifyStatus(true, "Command copied"),
    () => setVerifyStatus(false, "Copy failed"),
  );
});

// --- Generate JWT (dev endpoint; no auth) ---
document.getElementById("btnGenerateJwt")?.addEventListener("click", async () => {
  const orgId = getOrgId();
  const userId = getUserId();
  if (!orgId || !userId) {
    setVerifyStatus(false, "Set Org ID and User ID first.");
    return;
  }
  try {
    const url = apiUrl("/dev/jwt");
    const campaignId = getCampaignId();
    console.log("[fixit] POST", url, { orgId, userId, campaignId });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgId, userId, ...(campaignId ? { campaignId } : {}) }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || res.statusText);
    }
    if (data.token) {
      setJwtValue(data.token);
      setVerifyStatus(true, `JWT generated for ${orgId} / ${userId}. Click Verify.`);
    } else {
      setVerifyStatus(false, "Server did not return a token.");
    }
  } catch (e) {
    console.error("[fixit] generate JWT failed:", e);
    setVerifyStatus(false, e.message || "Generate JWT failed. Is allowDevJwt enabled?");
  }
});

// --- Verify token ---
document.getElementById("btnVerify")?.addEventListener("click", async () => {
  if (!hasRequiredIdentity()) {
    setVerifyStatus(false, "Org ID and User ID are required. Fill both first.");
    return;
  }
  if (!getAuthHeader()) {
    setVerifyStatus(false, "Enter a JWT first or generate one.");
    return;
  }
  try {
    const res = await apiFetch("/auth/verify", { method: "POST" });
    const data = await res.json();
    console.log("[fixit] verify response:", data);
    document.getElementById("orgId").value = data.orgId ?? getOrgId();
    document.getElementById("userId").value = data.userId ?? getUserId();
    if (data.campaignId !== undefined) {
      const campaignEl = document.getElementById("campaignId");
      if (campaignEl) {
        campaignEl.value = data.campaignId;
      }
    }
    updateJwtCommand();
    setVerifyStatus(
      true,
      `OK — ${data.orgId} / ${data.userId} (${data.role}). Strict scope: org_id=${data.orgId} user_id=${data.userId}`,
    );
  } catch (e) {
    console.error("[fixit] verify failed:", e);
    setVerifyStatus(false, e.message || "Verify failed.");
  }
});

// --- Session state ---
let currentSessionId = null;
let _currentRunId = null;
let abortController = null;

function getSessionId() {
  return currentSessionId;
}

function setSessionId(id) {
  currentSessionId = id;
  console.log("[fixit] session set:", id);
}

// --- New session ---
document.getElementById("btnNewSession")?.addEventListener("click", async () => {
  if (!hasRequiredIdentity()) {
    alert("Org ID and User ID are required. Fill both, then Generate JWT and Verify.");
    return;
  }
  if (!getAuthHeader()) {
    alert("Set JWT first (Generate JWT or paste token), then Verify.");
    return;
  }
  try {
    const res = await apiFetch("/chat/sessions/new", { method: "POST", body: "{}" });
    const data = await res.json();
    console.log("[fixit] new session:", data);
    setSessionId(data.sessionId);
    renderSessionList();
    addSystemMessage(`New conversation: ${data.sessionId.slice(0, 8)}…`);
  } catch (e) {
    console.error("[fixit] new session failed:", e);
    alert(e.message || "Failed to create session.");
  }
});

// --- List sessions ---
async function fetchSessions() {
  const res = await apiFetch("/chat/sessions");
  return res.json();
}

function renderSessionList() {
  const list = document.getElementById("sessionList");
  if (!list) {
    return;
  }
  list.innerHTML = "";
  fetchSessions()
    .then((data) => {
      console.log("[fixit] sessions:", data);
      const sessions = data.sessions || [];
      sessions.forEach((s) => {
        const li = document.createElement("li");
        li.textContent = `${s.sessionId?.slice(0, 8) || "?"}… ${s.updatedAt ? new Date(s.updatedAt).toLocaleString() : ""}`;
        if (s.sessionId === getSessionId()) {
          li.classList.add("active");
        }
        li.addEventListener("click", () => {
          setSessionId(s.sessionId);
          renderSessionList();
          void loadHistory(s.sessionId);
        });
        list.appendChild(li);
      });
    })
    .catch((e) => {
      console.error("[fixit] sessions fetch failed:", e);
      list.innerHTML = "<li>No sessions or not authenticated.</li>";
    });
}

document.getElementById("btnListSessions")?.addEventListener("click", () => {
  if (!hasRequiredIdentity()) {
    alert("Org ID and User ID are required. Fill both, then Generate JWT and Verify.");
    return;
  }
  if (!getAuthHeader()) {
    alert("Set JWT first (Generate JWT or paste token), then Verify.");
    return;
  }
  renderSessionList();
});

// --- Markdown rendering ---
function renderMarkdown(text) {
  if (!text) {
    return "";
  }
  if (typeof marked !== "undefined" && marked.parse) {
    try {
      return marked.parse(text, { breaks: true, gfm: true });
    } catch {
      /* fall through */
    }
  }
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
}

function postProcessHtml(html) {
  const base = getApiBase() || "";
  // Convert /api/fixit/files/download links to styled download buttons
  return html.replace(
    /<a\s+href="(\/api\/fixit\/files\/download\?[^"]+)"[^>]*>([^<]+)<\/a>/g,
    (_match, href, label) => {
      const fullHref = base ? base.replace(/\/+$/, "") + href : href;
      const authHeader = getAuthHeader();
      const token = authHeader ? authHeader.Authorization.replace("Bearer ", "") : "";
      const urlWithAuth =
        fullHref + (fullHref.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
      return `<a class="download-btn" href="${urlWithAuth}" target="_blank" download>
        <span class="download-icon">&#x2B73;</span> ${label}
      </a>`;
    },
  );
}

// --- Messages UI ---
const messagesEl = document.getElementById("messages");

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "msg system";
  div.style.background = "transparent";
  div.style.color = "#8b98a5";
  div.style.fontSize = "0.85rem";
  div.textContent = text;
  messagesEl?.appendChild(div);
  messagesEl?.scrollTo(0, messagesEl.scrollHeight);
}

function appendMessage(owner, text, meta = "") {
  const div = document.createElement("div");
  div.className = `msg ${owner}`;
  const contentDiv = document.createElement("div");
  contentDiv.className = "msg-content";
  if (owner === "assistant" && text) {
    contentDiv.innerHTML = postProcessHtml(renderMarkdown(text));
  } else {
    const p = document.createElement("p");
    p.textContent = text;
    contentDiv.appendChild(p);
  }
  div.appendChild(contentDiv);
  if (meta) {
    const m = document.createElement("div");
    m.className = "meta";
    m.textContent = meta;
    div.appendChild(m);
  }
  messagesEl?.appendChild(div);
  messagesEl?.scrollTo(0, messagesEl.scrollHeight);
  return div;
}

// --- Load history ---
async function loadHistory(sessionId) {
  if (!sessionId) {
    return;
  }
  try {
    const res = await apiFetch(`/chat/history?sessionId=${encodeURIComponent(sessionId)}&limit=50`);
    const data = await res.json();
    console.log("[fixit] history:", data);
    const messages = data.messages || [];
    messagesEl.innerHTML = "";
    messages.forEach((m) => {
      const owner = m.messageOwner === "user" ? "user" : "assistant";
      const msg = appendMessage(
        owner,
        m.message || "",
        m.createdAt ? new Date(m.createdAt).toLocaleString() : "",
      );
      if (owner === "assistant" && m.message) {
        const contentEl = msg.querySelector(".msg-content");
        if (contentEl) {
          contentEl.innerHTML = postProcessHtml(renderMarkdown(m.message));
        }
      }
    });
  } catch (e) {
    console.error("[fixit] history failed:", e);
    messagesEl.innerHTML = "";
    addSystemMessage("Could not load history: " + e.message);
  }
}

// --- Send message (SSE) ---
function setStreamStatus(text) {
  const el = document.getElementById("streamStatus");
  if (el) {
    el.textContent = text;
  }
}

function showTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  if (el) {
    el.classList.add("visible");
    el.setAttribute("aria-hidden", "false");
  }
}

function hideTypingIndicator() {
  const el = document.getElementById("typingIndicator");
  if (el) {
    el.classList.remove("visible");
    el.setAttribute("aria-hidden", "true");
  }
}

document.getElementById("btnSend")?.addEventListener("click", sendMessage);
document.getElementById("messageInput")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void sendMessage();
  }
});

async function sendMessage() {
  const input = document.getElementById("messageInput");
  const text = input?.value?.trim();
  if (!text) {
    return;
  }
  if (!hasRequiredIdentity()) {
    alert(
      "Org ID and User ID are required. Fill both in Connection, then Generate JWT and Verify.",
    );
    return;
  }
  if (!getAuthHeader()) {
    alert("Set JWT first (Generate JWT or paste token), then Verify.");
    return;
  }

  input.value = "";
  appendMessage("user", text, "just now");
  showTypingIndicator();

  let assistantBlock = null;
  let contentEl = null;
  let fullText = "";

  const runIdEl = document.getElementById("btnAbort");
  if (runIdEl) {
    runIdEl.disabled = false;
  }
  abortController = new AbortController();

  const body = {
    message: text,
    ...(getSessionId() ? { sessionId: getSessionId() } : {}),
  };

  const url = apiUrl("/chat/send");
  console.log(`[fixit] POST ${url} body:`, body);

  function ensureAssistantBlock() {
    if (!assistantBlock) {
      hideTypingIndicator();
      assistantBlock = appendMessage("assistant", "");
      contentEl = assistantBlock.querySelector(".msg-content");
    }
    return contentEl;
  }

  function renderFinalMarkdown() {
    if (contentEl && fullText.trim()) {
      contentEl.innerHTML = postProcessHtml(renderMarkdown(fullText));
    }
  }

  try {
    const headers = {
      "Content-Type": "application/json",
      ...getAuthHeader(),
    };

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: abortController.signal,
    });

    console.log(`[fixit] chat/send ${res.status} ${res.statusText}`);

    if (!res.ok) {
      hideTypingIndicator();
      const err = await res.json().catch(() => ({}));
      console.error("[fixit] chat/send error:", err);
      throw new Error(err.error || res.statusText || `HTTP ${res.status}`);
    }

    if (!res.body) {
      throw new Error("No response body");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          try {
            const event = JSON.parse(line.slice(6));
            console.log("[fixit] SSE event:", event);
            if (event.type === "delta" && event.text) {
              const el = ensureAssistantBlock();
              fullText += event.text;
              if (el) {
                el.textContent = fullText;
              }
              messagesEl?.scrollTo(0, messagesEl.scrollHeight);
            } else if (event.type === "tool_call") {
              const toolLabel = event.name ? event.name.replace(/_/g, " ") : "tool";
              const status = event.status === "running" ? "running..." : event.status || "";
              setStreamStatus(`⚙ ${toolLabel} ${status}`);
            } else if (event.type === "done") {
              hideTypingIndicator();
              setStreamStatus("");
              if (event.sessionId && !getSessionId()) {
                setSessionId(event.sessionId);
              }
              _currentRunId = null;
              if (!assistantBlock) {
                appendMessage("assistant", "(No response)");
              } else if (!fullText.trim() && contentEl) {
                contentEl.textContent = "(No response)";
              } else {
                renderFinalMarkdown();
              }
            } else if (event.type === "error") {
              hideTypingIndicator();
              setStreamStatus("");
              ensureAssistantBlock();
              fullText += "\n\n**Error:** " + event.error;
              renderFinalMarkdown();
            }
          } catch {
            /* ignore malformed SSE lines */
          }
        }
      }
    }

    setStreamStatus("");
    hideTypingIndicator();
    if (!assistantBlock) {
      appendMessage("assistant", "(No response)");
    } else if (!fullText.trim() && contentEl) {
      contentEl.textContent = "(No response)";
    } else {
      renderFinalMarkdown();
    }
  } catch (e) {
    hideTypingIndicator();
    setStreamStatus("");
    console.error("[fixit] send error:", e);
    ensureAssistantBlock();
    if (e.name === "AbortError") {
      fullText += "\n\n*[Stopped]*";
    } else {
      fullText += "\n\n**Error:** " + e.message;
    }
    renderFinalMarkdown();
  } finally {
    _currentRunId = null;
    if (runIdEl) {
      runIdEl.disabled = true;
    }
  }
}

// Abort
document.getElementById("btnAbort")?.addEventListener("click", () => {
  if (abortController) {
    abortController.abort();
  }
});

// Init
if (messagesEl && messagesEl.children.length === 0) {
  addSystemMessage(
    "Org ID and User ID are required. Fill both in Connection, then Generate JWT (or paste a JWT) and Verify. All data is strictly scoped to that org and user.",
  );
}
