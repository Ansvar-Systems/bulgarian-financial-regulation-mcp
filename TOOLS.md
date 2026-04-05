# Tool Reference

All tools use the `bg_fin_` prefix. All responses include a `_meta` block with disclaimer, copyright, source URL, and data age information.

## bg_fin_search_regulations

Full-text search across Bulgarian FSC (КФН) regulatory provisions.

**Input**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query in Bulgarian or English (e.g., `капиталови пазари`, `capital markets`) |
| `sourcebook` | string | No | Filter by sourcebook ID: `FSC_NAREDBI`, `FSC_UKAZANIYA`, `BNB_NAREDBI` |
| `status` | `"in_force"` \| `"deleted"` \| `"not_yet_in_force"` | No | Filter by provision status |
| `limit` | number (1–100) | No | Maximum results to return (default: 20) |

**Output**

```json
{
  "results": [{ "id": 1, "sourcebook_id": "FSC_NAREDBI", "reference": "Наредба 38", "title": "...", "text": "...", "status": "in_force", "effective_date": "2023-01-01" }],
  "count": 1,
  "_meta": { "disclaimer": "...", "copyright": "...", "source_url": "...", "data_age": "..." }
}
```

---

## bg_fin_get_regulation

Get a specific FSC provision by sourcebook and reference number.

**Input**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourcebook` | string | Yes | Sourcebook identifier (e.g., `FSC_NAREDBI`) |
| `reference` | string | Yes | Provision reference (e.g., `Наредба 38`) |

**Output**

```json
{
  "id": 1, "sourcebook_id": "FSC_NAREDBI", "reference": "Наредба 38", "title": "...", "text": "...",
  "type": null, "status": "in_force", "effective_date": "2023-01-01", "chapter": null, "section": null,
  "_meta": { "disclaimer": "...", "copyright": "...", "source_url": "...", "data_age": "..." }
}
```

---

## bg_fin_list_sourcebooks

List all FSC and BNB sourcebook collections with their names and descriptions.

**Input**: none

**Output**

```json
{
  "sourcebooks": [{ "id": "FSC_NAREDBI", "name": "FSC Ordinances", "description": "..." }],
  "count": 3,
  "_meta": { ... }
}
```

---

## bg_fin_search_enforcement

Search FSC enforcement actions — sanctions, fines, licence revocations, and warnings.

**Input**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (firm name, breach type, etc.) |
| `action_type` | `"fine"` \| `"ban"` \| `"restriction"` \| `"warning"` | No | Filter by action type |
| `limit` | number (1–100) | No | Maximum results (default: 20) |

**Output**

```json
{
  "results": [{ "id": 1, "firm_name": "...", "action_type": "fine", "amount": 5000, "date": "2024-01-15", "summary": "..." }],
  "count": 1,
  "_meta": { ... }
}
```

> **Note**: Enforcement data currently contains 0 records. See [COVERAGE.md](COVERAGE.md) for details.

---

## bg_fin_check_currency

Check whether a specific FSC provision reference is currently in force.

**Input**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reference` | string | Yes | Provision reference (e.g., `Наредба 38`) |

**Output**

```json
{
  "reference": "Наредба 38",
  "status": "in_force",
  "effective_date": "2023-01-01",
  "found": true,
  "_meta": { ... }
}
```

---

## bg_fin_about

Return metadata about this MCP server: version, data source, tool list.

**Input**: none

**Output**

```json
{
  "name": "bulgarian-financial-regulation-mcp",
  "version": "0.1.0",
  "description": "...",
  "data_source": "FSC (https://www.fsc.bg/) and BNB (https://www.bnb.bg/)",
  "tools": [{ "name": "bg_fin_search_regulations", "description": "..." }],
  "_meta": { ... }
}
```

---

## bg_fin_list_sources

List all authoritative data sources used by this MCP server.

**Input**: none

**Output**

```json
{
  "sources": [
    { "id": "FSC_NAREDBI", "authority": "Financial Supervision Commission (FSC / КФН)", "name": "FSC Ordinances (Наредби)", "url": "https://www.fsc.bg/en/regulations/ordinances/", "language": ["bg", "en"], "license": "Public domain — official government publication" },
    { "id": "FSC_UKAZANIYA", "authority": "Financial Supervision Commission (FSC / КФН)", "name": "FSC Instructions (Указания)", "url": "https://www.fsc.bg/en/regulations/instructions/", "language": ["bg"], "license": "Public domain — official government publication" },
    { "id": "BNB_NAREDBI", "authority": "Bulgarian National Bank (BNB / БНБ)", "name": "BNB Ordinances (Наредби)", "url": "https://www.bnb.bg/BankSupervision/BSRegulation/BSROrdinances/index.htm", "language": ["bg", "en"], "license": "Public domain — official government publication" },
    { "id": "FSC_ENFORCEMENT", "authority": "Financial Supervision Commission (FSC / КФН)", "name": "FSC Enforcement Actions", "url": "https://www.fsc.bg/en/compulsory-administrative-measures-and-penal-decrees/", "language": ["bg"], "license": "Public domain — official government publication" }
  ],
  "count": 4,
  "_meta": { ... }
}
```

---

## bg_fin_check_data_freshness

Return data freshness information from the last ingestion run.

**Input**: none

**Output**

```json
{
  "last_updated": "2026-03-23T15:05:04.245Z",
  "provisions_count": 9,
  "enforcements_count": 0,
  "status": "ok",
  "_meta": { ... }
}
```

`status` is `"ok"` if an ingestion timestamp exists, `"unknown"` otherwise.
