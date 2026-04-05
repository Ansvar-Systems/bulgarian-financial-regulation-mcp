# Data Coverage

This document describes what data is currently ingested into the Bulgarian Financial Regulation MCP database.

## Summary

| Metric | Value |
|--------|-------|
| Provisions ingested | 9 |
| Enforcement actions ingested | 0 |
| Last ingestion | 2026-03-23 |

## Sourcebook Coverage

### FSC_NAREDBI — FSC Ordinances (Наредби)

**Status: Partial**

The following ordinances are currently ingested:

| Reference | Area |
|-----------|------|
| Наредба 8 | Investment activity |
| Наредба 50 | Investment activity |
| Наредба 44 | Investment activity |
| Наредба 71 | Insurance |
| Наредба 48 | Insurance |
| Наредба 51 | Insurance |
| Наредба 66 | Insurance |
| Наредба 67 | Insurance |
| Наредба 31 | Insurance |
| Наредба 29 | Social insurance |

Not all FSC ordinances are ingested. Additional ordinances will be added in future ingestion runs.

### FSC_UKAZANIYA — FSC Instructions (Указания)

**Status: Not yet ingested**

FSC instructions are identified in the sourcebook schema but have not yet been crawled and ingested.

### BNB_NAREDBI — BNB Ordinances (Наредби)

**Status: Not yet ingested**

BNB ordinances are identified in the sourcebook schema but have not yet been crawled and ingested.

### FSC_ENFORCEMENT — FSC Enforcement Actions

**Status: Zero results**

22 enforcement-related URLs were crawled during the last ingestion run, but 0 enforcement actions were successfully parsed and stored. The crawler reached the enforcement pages but was unable to extract structured data. This is a known issue — see the data quality note below.

## Data Quality Notes

- **Enforcement data gap**: The ingest script (`scripts/ingest-fsc.ts`) crawled 22 enforcement URLs but parsed 0 records. The FSC enforcement pages use a dynamic table format that requires additional parsing work. This is tracked as a known issue.
- **Provision count**: 9 provisions reflect the seed data and initial crawl. Additional ordinances exist on the FSC website and will be added in future runs.
- **Language**: Bulgarian (bg) is primary. English translations exist for some ordinances and are ingested when available.

## Machine-Readable Coverage

See [`data/coverage.json`](data/coverage.json) for a machine-readable version of this information.

## Authoritative Sources

| Source | URL |
|--------|-----|
| FSC Ordinances | https://www.fsc.bg/en/regulations/ordinances/ |
| FSC Instructions | https://www.fsc.bg/en/regulations/instructions/ |
| FSC Enforcement | https://www.fsc.bg/en/compulsory-administrative-measures-and-penal-decrees/ |
| BNB Ordinances | https://www.bnb.bg/BankSupervision/BSRegulation/BSROrdinances/index.htm |
