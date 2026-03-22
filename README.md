# Bulgarian Financial Regulation MCP

MCP server for querying Bulgarian Financial Supervision Commission (FSC / КФН — Комисия за финансов надзор) ordinances, instructions, Bulgarian National Bank (BNB / БНБ) regulations, and enforcement actions.

## Tools

| Tool | Description |
|------|-------------|
| `bg_fin_search_regulations` | Full-text search across FSC and BNB provisions |
| `bg_fin_get_regulation` | Get a specific provision by sourcebook and reference |
| `bg_fin_list_sourcebooks` | List all sourcebook collections |
| `bg_fin_search_enforcement` | Search FSC enforcement actions and sanctions |
| `bg_fin_check_currency` | Check whether a provision is currently in force |
| `bg_fin_about` | Server metadata and tool list |

## Sourcebooks

- `FSC_NAREDBI` — FSC Ordinances (Наредби на КФН)
- `FSC_UKAZANIYA` — FSC Instructions (Указания на КФН)
- `BNB_NAREDBI` — BNB Ordinances (Наредби на БНБ)

## Setup

```bash
npm install
npm run build
npm run seed       # seed sample data
npm start          # HTTP server on port 3000
```

Set `FSC_DB_PATH` to use a custom database location.

## Data Sources

- FSC: https://www.fsc.bg/
- BNB: https://www.bnb.bg/
