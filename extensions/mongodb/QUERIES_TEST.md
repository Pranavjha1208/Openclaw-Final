# MongoDB Plugin – Test Queries (Natural Language + Tool Calls)

Use these on Telegram (ask the bot in natural language) and/or call the tools directly with the params below. Replace `ORG_5OB7E2DP`, `lead_xxx`, etc. with your real IDs.

---

## 1. Simple single-collection queries

### 1.1 "Show me all leads for org ORG_5OB7E2DP"

**Tool:** `mongo_find`  
**Params:**

```json
{
  "collection": "d_lead",
  "filter": { "org_id": "ORG_5OB7E2DP" },
  "sort": { "created_at": -1 },
  "limit": 20
}
```

---

### 1.2 "How many leads do we have in total?"

**Tool:** `mongo_count`  
**Params:**

```json
{
  "collection": "d_lead",
  "filter": {}
}
```

---

### 1.3 "List leads created from January 2026 onwards"

**Tool:** `mongo_find`  
**Params:**

```json
{
  "collection": "d_lead",
  "filter": { "created_at": { "$gte": "2026-01-01T00:00:00.000Z" } },
  "sort": { "created_at": -1 },
  "limit": 20
}
```

---

### 1.4 "Find leads by phone number 919204292878"

**Tool:** `mongo_find`  
**Params:**

```json
{
  "collection": "d_lead",
  "filter": { "lead_phone_no": "919204292878" },
  "limit": 10
}
```

---

### 1.5 "Search leads by name containing 'John'"

**Tool:** `mongo_find`  
**Params:**

```json
{
  "collection": "d_lead",
  "filter": { "lead_name": { "$regex": "John", "$options": "i" } },
  "limit": 20
}
```

---

### 1.6 "Show me all NEW leads (by status)"

**Tool:** `mongo_find`  
**Params:**

```json
{
  "collection": "f_lead_status",
  "filter": { "lead_status": "New" },
  "sort": { "created_at": -1 },
  "limit": 20
}
```

---

### 1.7 "Leads not contacted on WhatsApp"

**Tool:** `mongo_find`  
**Params:**

```json
{
  "collection": "f_lead_whatsapp",
  "filter": { "whatsapp_reachout_status": "not_contacted" },
  "limit": 20
}
```

---

### 1.8 "Leads with budget above 8 lakhs"

**Tool:** `mongo_find`  
**Params:** (budget filter only applies on `f_lead_status`)

```json
{
  "collection": "f_lead_status",
  "filter": { "budgetMinLakhs": 8 },
  "limit": 20
}
```

---

### 1.9 "Leads in Mumbai (location in lead_data)"

**Tool:** `mongo_find`  
**Params:**

```json
{
  "collection": "f_lead_status",
  "filter": { "lead_data.location": { "$regex": "Mumbai", "$options": "i" } },
  "limit": 20
}
```

---

### 1.10 "Count of new leads this year"

**Tool:** `mongo_count`  
**Params:**

```json
{
  "collection": "f_lead_status",
  "filter": {
    "$and": [{ "lead_status": "New" }, { "created_at": { "$gte": "2026-01-01T00:00:00.000Z" } }]
  }
}
```

---

## 2. Aggregations (single collection)

### 2.1 "How many leads per status?"

**Tool:** `mongo_aggregate`  
**Params:**

```json
{
  "collection": "f_lead_status",
  "pipeline": "[{\"$group\":{\"_id\":\"$lead_status\",\"count\":{\"$sum\":1}}},{\"$sort\":{\"count\":-1}}]"
}
```

---

### 2.2 "Leads per org (from d_lead)"

**Tool:** `mongo_aggregate`  
**Params:**

```json
{
  "collection": "d_lead",
  "pipeline": "[{\"$group\":{\"_id\":\"$org_id\",\"count\":{\"$sum\":1}}},{\"$sort\":{\"count\":-1}}]"
}
```

---

### 2.3 "WhatsApp contacted vs not contacted counts"

**Tool:** `mongo_aggregate`  
**Params:**

```json
{
  "collection": "f_lead_whatsapp",
  "pipeline": "[{\"$group\":{\"_id\":\"$whatsapp_reachout_status\",\"count\":{\"$sum\":1}}}]"
}
```

---

### 2.4 "100 random leads"

**Tool:** `mongo_aggregate`  
**Params:**

```json
{
  "collection": "d_lead",
  "pipeline": "[{\"$sample\":{\"size\":100}}]"
}
```

---

## 3. Joins (full lead view – d_lead + status + call + whatsapp + crm)

Use **`mongo_aggregate`** on **`d_lead`** with **`$lookup`** on `f_lead_status`, `f_lead_call`, `f_lead_whatsapp`, `d_lead_crm` (all on `lead_id`).

### 3.1 "Full lead view for org: identity + status + call + whatsapp (first 10)"

**Tool:** `mongo_aggregate`  
**Params:**

```json
{
  "collection": "d_lead",
  "pipeline": "[{\"$match\":{\"org_id\":\"ORG_5OB7E2DP\"}},{\"$lookup\":{\"from\":\"f_lead_status\",\"localField\":\"lead_id\",\"foreignField\":\"lead_id\",\"as\":\"status\"}},{\"$lookup\":{\"from\":\"f_lead_call\",\"localField\":\"lead_id\",\"foreignField\":\"lead_id\",\"as\":\"call\"}},{\"$lookup\":{\"from\":\"f_lead_whatsapp\",\"localField\":\"lead_id\",\"foreignField\":\"lead_id\",\"as\":\"whatsapp\"}},{\"$unwind\":{\"path\":\"$status\",\"preserveNullAndEmptyArrays\":true}},{\"$unwind\":{\"path\":\"$call\",\"preserveNullAndEmptyArrays\":true}},{\"$unwind\":{\"path\":\"$whatsapp\",\"preserveNullAndEmptyArrays\":true}},{\"$limit\":10}]"
}
```

**Pipeline (readable):**

```json
[
  { "$match": { "org_id": "ORG_5OB7E2DP" } },
  {
    "$lookup": {
      "from": "f_lead_status",
      "localField": "lead_id",
      "foreignField": "lead_id",
      "as": "status"
    }
  },
  {
    "$lookup": {
      "from": "f_lead_call",
      "localField": "lead_id",
      "foreignField": "lead_id",
      "as": "call"
    }
  },
  {
    "$lookup": {
      "from": "f_lead_whatsapp",
      "localField": "lead_id",
      "foreignField": "lead_id",
      "as": "whatsapp"
    }
  },
  { "$unwind": { "path": "$status", "preserveNullAndEmptyArrays": true } },
  { "$unwind": { "path": "$call", "preserveNullAndEmptyArrays": true } },
  { "$unwind": { "path": "$whatsapp", "preserveNullAndEmptyArrays": true } },
  { "$limit": 10 }
]
```

---

### 3.2 "Full lead view only for NEW status (joined)"

**Tool:** `mongo_aggregate`  
**Params (pipeline as string):**

```json
{
  "collection": "d_lead",
  "pipeline": "[{\"$lookup\":{\"from\":\"f_lead_status\",\"localField\":\"lead_id\",\"foreignField\":\"lead_id\",\"as\":\"status\"}},{\"$unwind\":\"$status\"},{\"$match\":{\"status.lead_status\":\"New\"}},{\"$lookup\":{\"from\":\"f_lead_call\",\"localField\":\"lead_id\",\"foreignField\":\"lead_id\",\"as\":\"call\"}},{\"$lookup\":{\"from\":\"f_lead_whatsapp\",\"localField\":\"lead_id\",\"foreignField\":\"lead_id\",\"as\":\"whatsapp\"}},{\"$unwind\":{\"path\":\"$call\",\"preserveNullAndEmptyArrays\":true}},{\"$unwind\":{\"path\":\"$whatsapp\",\"preserveNullAndEmptyArrays\":true}},{\"$limit\":20}]"
}
```

**Pipeline (readable):**

```json
[
  {
    "$lookup": {
      "from": "f_lead_status",
      "localField": "lead_id",
      "foreignField": "lead_id",
      "as": "status"
    }
  },
  { "$unwind": "$status" },
  { "$match": { "status.lead_status": "New" } },
  {
    "$lookup": {
      "from": "f_lead_call",
      "localField": "lead_id",
      "foreignField": "lead_id",
      "as": "call"
    }
  },
  {
    "$lookup": {
      "from": "f_lead_whatsapp",
      "localField": "lead_id",
      "foreignField": "lead_id",
      "as": "whatsapp"
    }
  },
  { "$unwind": { "path": "$call", "preserveNullAndEmptyArrays": true } },
  { "$unwind": { "path": "$whatsapp", "preserveNullAndEmptyArrays": true } },
  { "$limit": 20 }
]
```

---

### 3.3 "Joined view: leads not contacted on WhatsApp, with name and phone"

**Tool:** `mongo_aggregate`  
**Pipeline (readable then stringify for pipeline param):**

```json
[
  {
    "$lookup": {
      "from": "f_lead_whatsapp",
      "localField": "lead_id",
      "foreignField": "lead_id",
      "as": "wa"
    }
  },
  { "$unwind": "$wa" },
  { "$match": { "wa.whatsapp_reachout_status": "not_contacted" } },
  {
    "$project": {
      "lead_id": 1,
      "lead_name": 1,
      "lead_phone_no": 1,
      "wa.whatsapp_reachout_status": 1
    }
  },
  { "$limit": 20 }
]
```

---

### 3.4 "Joined: full lead + CRM data for a specific lead_id"

**Tool:** `mongo_aggregate`  
**Params:**

```json
{
  "collection": "d_lead",
  "pipeline": "[{\"$match\":{\"lead_id\":\"lead_YOUR_LEAD_ID\"}},{\"$lookup\":{\"from\":\"d_lead_crm\",\"localField\":\"lead_id\",\"foreignField\":\"lead_id\",\"as\":\"crm\"}},{\"$lookup\":{\"from\":\"f_lead_status\",\"localField\":\"lead_id\",\"foreignField\":\"lead_id\",\"as\":\"status\"}},{\"$unwind\":{\"path\":\"$crm\",\"preserveNullAndEmptyArrays\":true}},{\"$unwind\":{\"path\":\"$status\",\"preserveNullAndEmptyArrays\":true}}]"
}
```

---

### 3.5 "Joined: new leads with budget above 10 lakhs (status + lead identity)"

**Tool:** `mongo_aggregate`  
**Pipeline (readable):**

```json
[
  {
    "$lookup": {
      "from": "f_lead_status",
      "localField": "lead_id",
      "foreignField": "lead_id",
      "as": "status"
    }
  },
  { "$unwind": "$status" },
  { "$match": { "status.lead_status": "New", "status.lead_data.budget": { "$gte": 1000000 } } },
  {
    "$project": {
      "lead_id": 1,
      "lead_name": 1,
      "lead_phone_no": 1,
      "org_id": 1,
      "status.lead_status": 1,
      "status.lead_data": 1
    }
  },
  { "$limit": 20 }
]
```

---

## 4. Natural language prompts to type to the bot (Telegram)

Use these as-is; the bot should map them to the right tool and params.

- "How many leads are in org ORG_5OB7E2DP?"
- "Show me the 10 most recently created leads."
- "List all leads with status New."
- "How many leads have we not contacted on WhatsApp?"
- "Find leads with budget above 8 lakhs."
- "Search leads by name John."
- "Give me a full list of leads for org X with their status, call and WhatsApp info."
- "Export to CSV the new leads from this year." (then use send attachment to get the file)
- "How many leads per status?"
- "100 random leads from the database."
- "Full details for lead_id lead_abc123 including CRM and status."

---

## 5. Other collections (no joins)

### 5.1 "List active campaigns"

**Tool:** `mongo_find`  
**Params:**

```json
{
  "collection": "d_campaign",
  "filter": { "is_active": true },
  "limit": 20
}
```

### 5.2 "Call records for a lead"

**Tool:** `mongo_find`  
**Params:**

```json
{
  "collection": "f_call_records",
  "filter": { "lead_id": "lead_YOUR_LEAD_ID" },
  "sort": { "call_started": -1 },
  "limit": 10
}
```

### 5.3 "Count calls this month"

**Tool:** `mongo_count`  
**Params:**

```json
{
  "collection": "f_call_records",
  "filter": {
    "call_started": { "$gte": "2026-02-01T00:00:00.000Z", "$lte": "2026-02-28T23:59:59.999Z" }
  }
}
```

---

Replace placeholders (`ORG_5OB7E2DP`, `lead_YOUR_LEAD_ID`, dates) with your real data when testing.
