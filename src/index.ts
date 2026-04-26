#!/usr/bin/env node

/**
 * Bulgarian Financial Regulation MCP — stdio entry point.
 *
 * Provides MCP tools for querying FSC (КФН - Комисия за финансов надзор)
 * ordinances, guidance, and enforcement actions.
 *
 * Tool prefix: bg_fin_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
} from "./db.js";
import { buildCitation } from "./citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "bulgarian-financial-regulation-mcp";

// Tool definitions

const TOOLS = [
  {
    name: "bg_fin_search_regulations",
    description:
      "Full-text search across Bulgarian FSC (КФН) regulatory provisions. Returns matching ordinances (наредби), instructions (указания), and BNB regulations.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query in Bulgarian or English (e.g., 'капиталови пазари', 'capital markets', 'застраховане')",
        },
        sourcebook: {
          type: "string",
          description: "Filter by sourcebook ID (e.g., FSC_NAREDBI, FSC_UKAZANIYA, BNB_NAREDBI). Optional.",
        },
        status: {
          type: "string",
          enum: ["in_force", "deleted", "not_yet_in_force"],
          description: "Filter by provision status. Defaults to all statuses.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "bg_fin_get_regulation",
    description:
      "Get a specific FSC provision by sourcebook and reference number (e.g., sourcebook 'FSC_NAREDBI', reference 'Наредба 38').",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: {
          type: "string",
          description: "Sourcebook identifier (e.g., FSC_NAREDBI, FSC_UKAZANIYA, BNB_NAREDBI)",
        },
        reference: {
          type: "string",
          description: "Provision reference (e.g., 'Наредба 38', 'Наредба 50', 'Указание 2')",
        },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "bg_fin_list_sourcebooks",
    description:
      "List all FSC and BNB sourcebook collections with their names and descriptions.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "bg_fin_search_enforcement",
    description:
      "Search FSC enforcement actions — sanctions, fines, licence revocations, and warnings against regulated entities.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query (e.g., firm name, type of breach, 'пазарна злоупотреба')",
        },
        action_type: {
          type: "string",
          enum: ["fine", "ban", "restriction", "warning"],
          description: "Filter by action type. Optional.",
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return. Defaults to 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "bg_fin_check_currency",
    description:
      "Check whether a specific FSC provision reference is currently in force. Returns status and effective date.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "Provision reference to check (e.g., 'Наредба 38')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "bg_fin_about",
    description: "Return metadata about this MCP server: version, data source, tool list.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "bg_fin_list_sources",
    description:
      "List all authoritative data sources used by this MCP server, with authority, URL, language, and licence information.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "bg_fin_check_data_freshness",
    description:
      "Return data freshness information: last ingestion timestamp, provision count, enforcement action count, and overall status.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// Zod schemas

const SearchRegulationsArgs = z.object({
  query: z.string().min(1),
  sourcebook: z.string().optional(),
  status: z.enum(["in_force", "deleted", "not_yet_in_force"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetRegulationArgs = z.object({
  sourcebook: z.string().min(1),
  reference: z.string().min(1),
});

const SearchEnforcementArgs = z.object({
  query: z.string().min(1),
  action_type: z.enum(["fine", "ban", "restriction", "warning"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const CheckCurrencyArgs = z.object({
  reference: z.string().min(1),
});

// Helper

const _meta = {
  disclaimer:
    "This data is sourced from official Bulgarian regulatory publications and is provided for research purposes only. Not legal or regulatory advice. Verify all references against primary sources before making compliance decisions.",
  copyright: "© Financial Supervision Commission (FSC / КФН), Republic of Bulgaria",
  source_url: "https://www.fsc.bg/",
  data_age: "Periodic updates — see bg_fin_check_data_freshness for last ingestion timestamp.",
};

function textContent(data: unknown) {
  const payload =
    data !== null && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), _meta }
      : { data, _meta };
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(payload, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// Server setup

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "bg_fin_search_regulations": {
        const parsed = SearchRegulationsArgs.parse(args);
        const results = searchProvisions({
          query: parsed.query,
          sourcebook: parsed.sourcebook,
          status: parsed.status,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "bg_fin_get_regulation": {
        const parsed = GetRegulationArgs.parse(args);
        const provision = getProvision(parsed.sourcebook, parsed.reference);
        if (!provision) {
          return errorContent(
            `Provision not found: ${parsed.sourcebook} ${parsed.reference}`,
          );
        }
        return textContent({
          ...(typeof provision === 'object' ? provision : { data: provision }),
          _citation: buildCitation(
            (provision as any).reference || parsed.reference,
            (provision as any).title || (provision as any).subject || '',
            'bg_fin_get_regulation',
            { sourcebook: parsed.sourcebook, reference: parsed.reference },
            (provision as any).url || null,
          ),
        });
      }

      case "bg_fin_list_sourcebooks": {
        const sourcebooks = listSourcebooks();
        return textContent({ sourcebooks, count: sourcebooks.length });
      }

      case "bg_fin_search_enforcement": {
        const parsed = SearchEnforcementArgs.parse(args);
        const results = searchEnforcement({
          query: parsed.query,
          action_type: parsed.action_type,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "bg_fin_check_currency": {
        const parsed = CheckCurrencyArgs.parse(args);
        const currency = checkProvisionCurrency(parsed.reference);
        return textContent(currency);
      }

      case "bg_fin_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "Bulgarian Financial Supervision Commission (FSC / КФН) MCP server. Provides access to FSC ordinances (наредби), instructions (указания), BNB regulations, and enforcement actions.",
          data_source: "FSC (https://www.fsc.bg/) and BNB (https://www.bnb.bg/)",
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      case "bg_fin_list_sources": {
        return textContent({
          sources: [
            {
              id: "FSC_NAREDBI",
              authority: "Financial Supervision Commission (FSC / КФН)",
              name: "FSC Ordinances (Наредби)",
              url: "https://www.fsc.bg/en/regulations/ordinances/",
              language: ["bg", "en"],
              license: "Public domain — official government publication",
            },
            {
              id: "FSC_UKAZANIYA",
              authority: "Financial Supervision Commission (FSC / КФН)",
              name: "FSC Instructions (Указания)",
              url: "https://www.fsc.bg/en/regulations/instructions/",
              language: ["bg"],
              license: "Public domain — official government publication",
            },
            {
              id: "BNB_NAREDBI",
              authority: "Bulgarian National Bank (BNB / БНБ)",
              name: "BNB Ordinances (Наредби)",
              url: "https://www.bnb.bg/BankSupervision/BSRegulation/BSROrdinances/index.htm",
              language: ["bg", "en"],
              license: "Public domain — official government publication",
            },
            {
              id: "FSC_ENFORCEMENT",
              authority: "Financial Supervision Commission (FSC / КФН)",
              name: "FSC Enforcement Actions",
              url: "https://www.fsc.bg/en/compulsory-administrative-measures-and-penal-decrees/",
              language: ["bg"],
              license: "Public domain — official government publication",
            },
          ],
          count: 4,
        });
      }

      case "bg_fin_check_data_freshness": {
        const ingestStatePath = join(__dirname, "..", "data", "ingest-state.json");
        if (!existsSync(ingestStatePath)) {
          return textContent({
            status: "unknown",
            message: "ingest-state.json not found",
            last_updated: null,
            provisions_count: null,
            enforcements_count: null,
          });
        }
        const state = JSON.parse(readFileSync(ingestStatePath, "utf8")) as {
          lastRun?: string;
          provisionsIngested?: number;
          enforcementsIngested?: number;
        };
        return textContent({
          last_updated: state.lastRun ?? null,
          provisions_count: state.provisionsIngested ?? 0,
          enforcements_count: state.enforcementsIngested ?? 0,
          status: state.lastRun ? "ok" : "unknown",
        });
      }

      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Error executing ${name}: ${message}`);
  }
});

// Main

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
