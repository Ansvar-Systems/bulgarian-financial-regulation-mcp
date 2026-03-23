/**
 * Ingestion crawler for the FSC (КФН — Комисия за финансов надзор) MCP server.
 *
 * Scrapes ordinances (наредби), instructions (указания), and enforcement
 * actions (принудителни мерки / наказателни постановления) from fsc.bg and
 * populates the SQLite database.
 *
 * Data sources (all under https://www.fsc.bg):
 *
 *   Ordinances (наредби):
 *     - Investment activity:       /en/investment-avtivity/legal-framework/ordinances/
 *     - Insurance activity:        /en/insurance-activity/legal-framework/ordinances/
 *     - Social insurance activity: /en/social-insurance-activity/legal-framework/ordinances/
 *
 *   Enforcement:
 *     - Compulsory admin measures: /registri-i-spravki/prinuditelni-administrativni-merki-i-nakazatelni-postanovleniya/
 *     - Investment enforcement:    /prinuditelni-administrativni-merki-i-nakazatelni-postanovleniya/investitsionna-deynost/
 *     - Penalty decrees:           /?page_id=27966  (наказателни постановления)
 *     - Admin measures:            /?page_id=27967  (принудителни административни мерки)
 *
 * Usage:
 *   npx tsx scripts/ingest-fsc.ts
 *   npx tsx scripts/ingest-fsc.ts --dry-run
 *   npx tsx scripts/ingest-fsc.ts --resume
 *   npx tsx scripts/ingest-fsc.ts --force
 *   npx tsx scripts/ingest-fsc.ts --max-pages 5
 */

import Database from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["FSC_DB_PATH"] ?? "data/fsc.db";
const STATE_FILE = join(dirname(DB_PATH), "ingest-state.json");
const BASE_URL = "https://www.fsc.bg";
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const USER_AGENT =
  "AnsvarFSCCrawler/1.0 (+https://github.com/Ansvar-Systems/bulgarian-financial-regulation-mcp)";

/**
 * Ordinance listing pages on fsc.bg.
 *
 * The FSC website organises ordinances by supervisory domain. Each domain
 * has an "ordinances" sub-page listing all applicable наредби. The English
 * pages list the same ordinances with bilingual titles. Individual ordinance
 * detail pages are linked from these listings.
 */
const ORDINANCE_SOURCES = [
  {
    sourcebook_id: "FSC_NAREDBI",
    id: "investment-ordinances",
    label: "Инвестиционна дейност — Наредби",
    paths: [
      "/en/investment-avtivity/legal-framework/ordinances/",
      "/en/investment-avtivity/legal-framework/ordinances/?lang=en",
    ],
    maxPages: 10,
  },
  {
    sourcebook_id: "FSC_NAREDBI",
    id: "insurance-ordinances",
    label: "Застрахователна дейност — Наредби",
    paths: [
      "/en/insurance-activity/legal-framework/ordinances/",
    ],
    maxPages: 10,
  },
  {
    sourcebook_id: "FSC_NAREDBI",
    id: "social-insurance-ordinances",
    label: "Осигурителна дейност — Наредби",
    paths: [
      "/en/social-insurance-activity/legal-framework/ordinances/",
    ],
    maxPages: 10,
  },
] as const;

/**
 * Enforcement listing pages on fsc.bg.
 *
 * The FSC publishes compulsory administrative measures (принудителни
 * административни мерки) and penalty decrees (наказателни постановления)
 * organised by year and supervisory domain.
 */
const ENFORCEMENT_SOURCES = [
  {
    id: "enforcement-measures",
    label: "Принудителни административни мерки",
    paths: [
      "/registri-i-spravki/prinuditelni-administrativni-merki-i-nakazatelni-postanovleniya/",
      "/?page_id=27967",
    ],
    maxPages: 20,
    actionType: "administrative_measure",
  },
  {
    id: "penalty-decrees",
    label: "Наказателни постановления",
    paths: [
      "/?page_id=27966",
    ],
    maxPages: 20,
    actionType: "penalty_decree",
  },
  {
    id: "investment-enforcement",
    label: "Инвестиционна дейност — мерки",
    paths: [
      "/prinuditelni-administrativni-merki-i-nakazatelni-postanovleniya/investitsionna-deynost/",
    ],
    maxPages: 15,
    actionType: "administrative_measure",
  },
] as const;

// CLI flags
const dryRun = process.argv.includes("--dry-run");
const resume = process.argv.includes("--resume");
const force = process.argv.includes("--force");
const maxPagesArg = process.argv.find((_, i, a) => a[i - 1] === "--max-pages");
const maxPagesOverride = maxPagesArg ? parseInt(maxPagesArg, 10) : null;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IngestState {
  processedUrls: string[];
  lastRun: string;
  provisionsIngested: number;
  enforcementsIngested: number;
  errors: string[];
}

interface ParsedProvision {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string | null;
  chapter: string | null;
  section: string | null;
}

interface ParsedEnforcement {
  firm_name: string;
  reference_number: string | null;
  action_type: string;
  amount: number | null;
  date: string | null;
  summary: string;
  sourcebook_references: string | null;
}

// ---------------------------------------------------------------------------
// HTTP fetching with rate limiting and retries
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<string | null> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "bg,en;q=0.5",
        },
        signal: AbortSignal.timeout(30_000),
      });

      if (response.status === 403 || response.status === 429) {
        console.warn(
          `  [WARN] HTTP ${response.status} for ${url} (attempt ${attempt}/${MAX_RETRIES})`,
        );
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        return null;
      }

      if (!response.ok) {
        console.warn(`  [WARN] HTTP ${response.status} for ${url}`);
        return null;
      }

      return await response.text();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [WARN] Fetch error for ${url} (attempt ${attempt}/${MAX_RETRIES}): ${message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// State management (for --resume)
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (resume && existsSync(STATE_FILE)) {
    try {
      const raw = readFileSync(STATE_FILE, "utf-8");
      return JSON.parse(raw) as IngestState;
    } catch {
      console.warn("[WARN] Could not read state file, starting fresh.");
    }
  }
  return {
    processedUrls: [],
    lastRun: new Date().toISOString(),
    provisionsIngested: 0,
    enforcementsIngested: 0,
    errors: [],
  };
}

function saveState(state: IngestState): void {
  state.lastRun = new Date().toISOString();
  const dir = dirname(STATE_FILE);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Ordinance listing page parsing — discover individual ordinance URLs
// ---------------------------------------------------------------------------

/**
 * Discover ordinance detail page URLs from an FSC listing page.
 *
 * The FSC ordinance listing pages render each ordinance as a linked entry.
 * Links point to PDF files hosted under /wp-content/uploads/ or to detail
 * pages within the legal-framework section. Some ordinance entries are
 * inline text blocks (no separate detail page) and are captured directly.
 */
async function discoverOrdinanceUrls(
  source: (typeof ORDINANCE_SOURCES)[number],
): Promise<string[]> {
  const urls: string[] = [];

  console.log(`\n  Discovering ordinance URLs from: ${source.label}`);

  for (const basePath of source.paths) {
    const effectiveMax = maxPagesOverride
      ? Math.min(maxPagesOverride, source.maxPages)
      : source.maxPages;

    for (let page = 1; page <= effectiveMax; page++) {
      const listUrl =
        page === 1
          ? `${BASE_URL}${basePath}`
          : `${BASE_URL}${basePath}${basePath.includes("?") ? "&" : "?"}page=${page}`;

      if (page === 1 || page % 5 === 0) {
        console.log(
          `    Fetching listing page ${page}/${effectiveMax}... (${urls.length} URLs so far)`,
        );
      }

      const html = await rateLimitedFetch(listUrl);
      if (!html) {
        console.warn(`    [WARN] Could not fetch listing page ${page}`);
        continue;
      }

      const $ = cheerio.load(html);
      let pageUrls = 0;

      // Strategy 1: Links to ordinance detail pages or PDFs
      $("a[href]").each((_i, el) => {
        const href = $(el).attr("href");
        if (!href) return;

        const fullUrl = href.startsWith("http")
          ? href
          : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

        // Match ordinance detail pages and PDF documents
        const isOrdinancePage =
          (href.includes("/legal-framework/") &&
            href.includes("ordinance") &&
            href !== basePath) ||
          (href.includes("/wp-content/uploads/") && href.endsWith(".pdf")) ||
          (href.includes("naredba") || href.includes("наредба"));

        // Skip pagination links and anchor links
        const isNavigation =
          href.includes("?page=") ||
          href.includes("?lang=") ||
          href === "#" ||
          href.startsWith("#");

        if (isOrdinancePage && !isNavigation && !urls.includes(fullUrl)) {
          urls.push(fullUrl);
          pageUrls++;
        }
      });

      // If no new URLs found after the first page, stop pagination
      if (pageUrls === 0 && page > 1) {
        console.log(
          `    No new URLs on page ${page} — stopping pagination for ${source.id}`,
        );
        break;
      }
    }
  }

  console.log(`    Discovered ${urls.length} ordinance URLs from ${source.id}`);
  return urls;
}

/**
 * Scrape inline ordinance entries directly from the listing page.
 *
 * FSC listing pages often present ordinances as text blocks (title + summary)
 * without separate detail pages. This function captures those entries.
 */
async function scrapeInlineOrdinances(
  source: (typeof ORDINANCE_SOURCES)[number],
): Promise<ParsedProvision[]> {
  const provisions: ParsedProvision[] = [];

  for (const basePath of source.paths) {
    const html = await rateLimitedFetch(`${BASE_URL}${basePath}`);
    if (!html) continue;

    const $ = cheerio.load(html);

    // FSC ordinance pages typically list ordinances as headings or list items
    // with "Наредба №" or "Ordinance No." patterns in the text.

    // Strategy 1: Structured list items or article blocks
    $("article, .entry-content li, .post-content li, .wp-block-list li, main li, main p").each(
      (_i, el) => {
        const text = $(el).text().trim();
        if (text.length < 30) return;

        const provision = parseInlineOrdinanceText(text, source.sourcebook_id);
        if (provision) {
          // Avoid duplicates by reference
          if (!provisions.some((p) => p.reference === provision.reference)) {
            provisions.push(provision);
          }
        }
      },
    );

    // Strategy 2: Heading + following paragraph blocks
    $("h2, h3, h4, h5").each((_i, el) => {
      const heading = $(el).text().trim();
      if (!isOrdinanceHeading(heading)) return;

      // Collect sibling paragraphs as body text
      const bodyParts: string[] = [];
      let sibling = $(el).next();
      while (
        sibling.length > 0 &&
        !["H2", "H3", "H4", "H5"].includes(
          sibling.prop("tagName") ?? "",
        )
      ) {
        const sibText = sibling.text().trim();
        if (sibText.length > 10) bodyParts.push(sibText);
        sibling = sibling.next();
      }

      const bodyText = bodyParts.join("\n\n");
      if (bodyText.length < 20) return;

      const reference = extractOrdinanceReference(heading) ?? heading.slice(0, 80);
      const provision: ParsedProvision = {
        sourcebook_id: source.sourcebook_id,
        reference,
        title: heading,
        text: bodyText,
        type: classifyProvisionType(heading),
        status: "in_force",
        effective_date: extractBulgarianDate(heading + " " + bodyText),
        chapter: null,
        section: null,
      };

      if (!provisions.some((p) => p.reference === provision.reference)) {
        provisions.push(provision);
      }
    });
  }

  return provisions;
}

// ---------------------------------------------------------------------------
// Enforcement listing page parsing
// ---------------------------------------------------------------------------

/**
 * Discover enforcement action URLs from FSC listing pages.
 *
 * The FSC publishes enforcement actions as individual posts/pages linked
 * from year-based or category-based listings. Each enforcement entry
 * describes a compulsory administrative measure or penalty decree.
 */
async function discoverEnforcementUrls(
  source: (typeof ENFORCEMENT_SOURCES)[number],
): Promise<string[]> {
  const urls: string[] = [];

  console.log(`\n  Discovering enforcement URLs from: ${source.label}`);

  for (const basePath of source.paths) {
    const effectiveMax = maxPagesOverride
      ? Math.min(maxPagesOverride, source.maxPages)
      : source.maxPages;

    for (let page = 1; page <= effectiveMax; page++) {
      const listUrl =
        page === 1
          ? `${BASE_URL}${basePath}`
          : `${BASE_URL}${basePath}${basePath.includes("?") ? "&" : "?"}page=${page}`;

      if (page === 1 || page % 5 === 0) {
        console.log(
          `    Fetching enforcement listing page ${page}/${effectiveMax}...`,
        );
      }

      const html = await rateLimitedFetch(listUrl);
      if (!html) {
        console.warn(`    [WARN] Could not fetch enforcement page ${page}`);
        continue;
      }

      const $ = cheerio.load(html);
      let pageUrls = 0;

      // Enforcement entries are linked from listing pages. Links point to
      // individual decision pages (WordPress posts or static pages).
      $("a[href]").each((_i, el) => {
        const href = $(el).attr("href");
        if (!href) return;

        const fullUrl = href.startsWith("http")
          ? href
          : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

        // Match enforcement-related links
        const isEnforcementLink =
          href.includes("prinuditelni") ||
          href.includes("nakazatelni") ||
          href.includes("sanktsii") ||
          href.includes("compulsory-administrative") ||
          href.includes("penal-decree") ||
          // Year-based sub-listings (e.g., /2024-2/, /2023-2/)
          /\/\d{4}(-\d)?\//.test(href);

        const isNavigation =
          href === "#" ||
          href.startsWith("#") ||
          href.includes("?page=") ||
          href.includes("?lang=");

        if (
          isEnforcementLink &&
          !isNavigation &&
          fullUrl.includes("fsc.bg") &&
          !urls.includes(fullUrl)
        ) {
          urls.push(fullUrl);
          pageUrls++;
        }
      });

      if (pageUrls === 0 && page > 1) {
        console.log(
          `    No new URLs on page ${page} — stopping pagination for ${source.id}`,
        );
        break;
      }
    }
  }

  console.log(`    Discovered ${urls.length} enforcement URLs from ${source.id}`);
  return urls;
}

// ---------------------------------------------------------------------------
// Individual page parsing — ordinances
// ---------------------------------------------------------------------------

/**
 * Parse an individual ordinance detail page or PDF landing page.
 *
 * FSC ordinance pages contain:
 *   - Title (h1 or article heading)
 *   - Full text or summary of the ordinance
 *   - Effective date information
 *   - Amendment history
 */
function parseOrdinancePage(
  html: string,
  url: string,
  sourcebookId: string,
): ParsedProvision | null {
  const $ = cheerio.load(html);

  // Title extraction
  const title =
    $("h1").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title")
      .text()
      .trim()
      .replace(/\s*[-–|]\s*(?:FSC|КФН|Комисия).*$/i, "") ||
    "";

  if (!title || title.length < 5) return null;

  // Body text extraction
  const bodyText = extractBodyText($);
  if (bodyText.length < 30) return null;

  // Reference extraction from title
  const reference = extractOrdinanceReference(title) ?? generateReferenceFromUrl(url);

  // Date extraction
  const allText = `${title} ${bodyText}`;
  const effectiveDate = extractBulgarianDate(allText);

  // Status detection
  const status = detectProvisionStatus(allText);

  // Chapter/section extraction
  const { chapter, section } = extractChapterSection(allText);

  return {
    sourcebook_id: sourcebookId,
    reference,
    title: title.slice(0, 500),
    text: bodyText,
    type: classifyProvisionType(title),
    status,
    effective_date: effectiveDate,
    chapter,
    section,
  };
}

// ---------------------------------------------------------------------------
// Individual page parsing — enforcement actions
// ---------------------------------------------------------------------------

/**
 * Parse an enforcement action page from fsc.bg.
 *
 * Enforcement pages describe compulsory administrative measures or penalty
 * decrees imposed by the FSC on supervised entities. They contain:
 *   - Name of the sanctioned entity
 *   - Type and nature of the measure
 *   - Fine amount (if applicable)
 *   - Date of the decision
 *   - Summary of the violation
 *   - Referenced regulations
 */
function parseEnforcementPage(
  html: string,
  _url: string,
  defaultActionType: string,
): ParsedEnforcement | null {
  const $ = cheerio.load(html);

  const title =
    $("h1").first().text().trim() ||
    $("title").text().trim().replace(/\s*[-–|]\s*(?:FSC|КФН).*$/i, "") ||
    "";

  if (!title || title.length < 10) return null;

  const bodyText = extractBodyText($);
  if (bodyText.length < 30) return null;

  const allText = `${title}\n${bodyText}`;

  // Extract firm name from the text
  const firmName = extractFirmName(allText);
  if (!firmName) return null;

  // Extract reference number
  const referenceNumber = extractEnforcementReference(allText);

  // Classify the action type
  const actionType = classifyActionType(allText, defaultActionType);

  // Extract fine amount in BGN
  const amount = extractBgnAmount(allText);

  // Extract date
  const date = extractBulgarianDate(allText);

  // Extract summary — first 500 chars of body or the title
  const summary = bodyText.length > 500 ? bodyText.slice(0, 500) + "..." : bodyText;

  // Extract referenced ordinances/regulations
  const sourcebookRefs = extractSourcebookReferences(allText);

  return {
    firm_name: firmName,
    reference_number: referenceNumber,
    action_type: actionType,
    amount,
    date,
    summary,
    sourcebook_references: sourcebookRefs,
  };
}

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/** Extract the main body text from an FSC page, stripping navigation. */
function extractBodyText($: cheerio.CheerioAPI): string {
  // FSC uses WordPress; content is typically in .entry-content or article
  const contentSelectors = [
    ".entry-content",
    "article .post-content",
    "article .content",
    ".post-content",
    ".page-content",
    "main article",
    ".wp-block-group",
    ".elementor-widget-theme-post-content",
  ];

  let bodyText = "";
  for (const sel of contentSelectors) {
    const el = $(sel);
    if (el.length > 0) {
      bodyText = el.text().trim();
      if (bodyText.length > 100) break;
    }
  }

  // Fallback: gather paragraphs from main content area
  if (!bodyText || bodyText.length < 100) {
    const paragraphs: string[] = [];
    $("main p, article p, .content p").each((_i, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) paragraphs.push(text);
    });
    bodyText = paragraphs.join("\n\n");
  }

  // Last resort: strip nav/footer and take remaining main content
  if (!bodyText || bodyText.length < 50) {
    $(
      "nav, footer, header, .menu, .breadcrumb, script, style, .skip-link, .sidebar",
    ).remove();
    bodyText = $("main, article, .content, body").text().trim();
  }

  // Clean up excessive whitespace
  return bodyText
    .replace(/\s{3,}/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Bulgarian text parsing helpers
// ---------------------------------------------------------------------------

/** Bulgarian month names for date parsing. */
const BG_MONTHS: Record<string, string> = {
  "януари": "01",
  "февруари": "02",
  "март": "03",
  "април": "04",
  "май": "05",
  "юни": "06",
  "юли": "07",
  "август": "08",
  "септември": "09",
  "октомври": "10",
  "ноември": "11",
  "декември": "12",
};

/**
 * Parse Bulgarian date strings to ISO format (yyyy-MM-dd).
 *
 * Handles formats:
 *   - dd.MM.yyyy (most common on fsc.bg)
 *   - dd месец yyyy (e.g., "15 юни 2023")
 *   - dd.MM.yyyy г. (with trailing "г.")
 *   - yyyy-MM-dd (already ISO)
 */
function extractBulgarianDate(text: string): string | null {
  if (!text) return null;

  // Pattern 1: dd.MM.yyyy or dd.MM.yyyy г.
  const dotMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*г?\b/);
  if (dotMatch) {
    const [, day, month, year] = dotMatch;
    const m = parseInt(month!, 10);
    const d = parseInt(day!, 10);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
    }
  }

  // Pattern 2: dd месец yyyy г. (Bulgarian textual date)
  const bgMonthPattern =
    /(\d{1,2})\s+(януари|февруари|март|април|май|юни|юли|август|септември|октомври|ноември|декември)\s+(\d{4})/i;
  const bgMatch = text.match(bgMonthPattern);
  if (bgMatch) {
    const [, day, monthName, year] = bgMatch;
    const monthNum = BG_MONTHS[monthName!.toLowerCase()];
    if (monthNum) {
      return `${year}-${monthNum}-${day!.padStart(2, "0")}`;
    }
  }

  // Pattern 3: Already ISO yyyy-MM-dd
  const isoMatch = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return isoMatch[0];
  }

  return null;
}

/**
 * Extract an ordinance reference from a title string.
 *
 * Matches patterns:
 *   - "Наредба № 38" / "Наредба №38"
 *   - "Ordinance No. 38" / "Ordinance No 38"
 *   - "Указание № 2"
 *   - "Правилник за ..."
 */
function extractOrdinanceReference(text: string): string | null {
  // Bulgarian: "Наредба № NN" (with or without space after №)
  const naredbaMatch = text.match(
    /Наредба\s*№\s*(\d+[а-яА-Я]?)/i,
  );
  if (naredbaMatch) {
    return `Наредба ${naredbaMatch[1]}`;
  }

  // English: "Ordinance No. NN" or "Ordinance No NN"
  const engMatch = text.match(
    /Ordinance\s+No\.?\s*(\d+[a-zA-Z]?)/i,
  );
  if (engMatch) {
    return `Наредба ${engMatch[1]}`;
  }

  // Bulgarian: "Указание № NN"
  const ukazanieMatch = text.match(
    /Указание\s*№\s*(\d+[а-яА-Я]?)/i,
  );
  if (ukazanieMatch) {
    return `Указание ${ukazanieMatch[1]}`;
  }

  // Bulgarian: "Правилник за ..."
  const pravilnikMatch = text.match(
    /Правилник\s+(за\s+.{5,60}?)(?:\s*[-–(,]|$)/i,
  );
  if (pravilnikMatch) {
    return `Правилник ${pravilnikMatch[1]!.trim()}`;
  }

  // English: "Instruction No. NN"
  const instrMatch = text.match(
    /Instruction\s+No\.?\s*(\d+[a-zA-Z]?)/i,
  );
  if (instrMatch) {
    return `Указание ${instrMatch[1]}`;
  }

  return null;
}

/** Check whether a heading contains an ordinance reference. */
function isOrdinanceHeading(text: string): boolean {
  return /Наредба|Ordinance|Указание|Instruction|Правилник|Regulation/i.test(text);
}

/**
 * Parse an inline ordinance text block into a structured provision.
 *
 * Inline entries appear as list items or paragraphs on FSC listing pages.
 * They follow patterns like:
 *   "Наредба № 38 от 2007 г. относно изискванията към дейността на..."
 */
function parseInlineOrdinanceText(
  text: string,
  sourcebookId: string,
): ParsedProvision | null {
  const reference = extractOrdinanceReference(text);
  if (!reference) return null;

  // Extract the title (first sentence or up to 200 chars)
  const titleEnd = text.indexOf(".");
  const title =
    titleEnd > 0 && titleEnd < 250
      ? text.slice(0, titleEnd + 1)
      : text.slice(0, 200);

  return {
    sourcebook_id: sourcebookId,
    reference,
    title,
    text: text.slice(0, 5000),
    type: classifyProvisionType(text),
    status: detectProvisionStatus(text),
    effective_date: extractBulgarianDate(text),
    chapter: null,
    section: null,
  };
}

/** Generate a reference from the URL when no reference is found in the text. */
function generateReferenceFromUrl(url: string): string {
  const slug = new URL(url).pathname
    .replace(/\/$/, "")
    .split("/")
    .pop() ?? "";
  // Clean slug: replace hyphens with spaces, capitalize
  const cleaned = slug
    .replace(/[-_]+/g, " ")
    .replace(/\.pdf$/i, "")
    .trim();
  return cleaned.length > 3 ? `FSC/${cleaned.slice(0, 80)}` : `FSC/${Date.now()}`;
}

/**
 * Classify the type of provision based on its title/text.
 *
 * Returns one of: Наредба, Указание, Правилник, Инструкция, Решение
 */
function classifyProvisionType(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("наредба") || lower.includes("ordinance")) return "Наредба";
  if (lower.includes("указание") || lower.includes("instruction")) return "Указание";
  if (lower.includes("правилник") || lower.includes("rules")) return "Правилник";
  if (lower.includes("инструкция")) return "Инструкция";
  if (lower.includes("решение") || lower.includes("decision")) return "Решение";
  if (lower.includes("тарифа") || lower.includes("rate schedule")) return "Тарифа";
  return "Наредба";
}

/**
 * Detect whether a provision is currently in force, amended, or repealed.
 *
 * Looks for Bulgarian keywords:
 *   - "отменен/а/о" = repealed
 *   - "изменен/а/о" = amended (still in force)
 *   - "в сила" = in force
 */
function detectProvisionStatus(text: string): string {
  const lower = text.toLowerCase();

  if (
    lower.includes("отменен") ||
    lower.includes("отменена") ||
    lower.includes("repealed")
  ) {
    return "repealed";
  }
  if (
    lower.includes("изменен") ||
    lower.includes("изменена") ||
    lower.includes("допълнен") ||
    lower.includes("amended")
  ) {
    return "in_force"; // amended but still in force
  }
  return "in_force";
}

/** Extract chapter and section identifiers from text. */
function extractChapterSection(
  text: string,
): { chapter: string | null; section: string | null } {
  // "Глава I" / "Глава 1" / "Chapter 1"
  const chapterMatch = text.match(
    /(?:Глава|Chapter)\s+([IVXLCDM\d]+)/i,
  );

  // "Раздел 1" / "Section 1"
  const sectionMatch = text.match(
    /(?:Раздел|Section)\s+([IVXLCDM\d]+(?:\.\d+)?)/i,
  );

  return {
    chapter: chapterMatch?.[1] ?? null,
    section: sectionMatch?.[1] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Enforcement text parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract a firm/entity name from enforcement text.
 *
 * Bulgarian company suffixes: ЕАД, АД, ЕООД, ООД, ЕТ, КД, КДА, СД
 * Pattern: looks for quoted names or names followed by company suffixes.
 */
function extractFirmName(text: string): string | null {
  // Pattern 1: Quoted name "Фирма ЕАД" or „Фирма ЕАД"
  const quotedMatch = text.match(
    /[„""«]([^""»„]+(?:ЕАД|АД|ЕООД|ООД|ЕТ|КД|КДА|СД))[""»"]/,
  );
  if (quotedMatch?.[1]) return quotedMatch[1].trim();

  // Pattern 2: Name followed by company suffix (without quotes)
  const suffixMatch = text.match(
    /([А-ЯA-Z][а-яА-ЯёЁa-zA-Z\s\-&.]+?)\s+(ЕАД|АД|ЕООД|ООД|ЕТ|КД|КДА|СД)\b/,
  );
  if (suffixMatch) {
    const name = `${suffixMatch[1]!.trim()} ${suffixMatch[2]}`;
    if (name.length > 3 && name.length < 200) return name;
  }

  // Pattern 3: After "на" (on/to) — common in Bulgarian administrative language
  // "Приложена е принудителна мярка на <ENTITY>"
  const naMatch = text.match(
    /(?:мярка|санкция|глоба|наказание)\s+(?:на|срещу)\s+([А-ЯA-Z][^,.;]{3,80})/i,
  );
  if (naMatch?.[1]) {
    return naMatch[1].trim().slice(0, 200);
  }

  // Pattern 4: Use the title itself if it names an entity
  const titleCompanyMatch = text.match(
    /^.{0,30}?([А-ЯA-Z][а-яА-ЯёЁa-zA-Z\s\-&."„"]+?(?:ЕАД|АД|ЕООД|ООД))/,
  );
  if (titleCompanyMatch?.[1]) {
    return titleCompanyMatch[1].trim();
  }

  return null;
}

/**
 * Extract an enforcement reference number from the text.
 *
 * Patterns:
 *   - "РГ-NN-NNNN/DD.MM.YYYY" (FSC reference format)
 *   - "Решение № ..." (Decision number)
 *   - "Заповед № ..." (Order number)
 */
function extractEnforcementReference(text: string): string | null {
  // FSC reference: "РГ-NN-NNNN/DD.MM.YYYY" or similar
  const rgMatch = text.match(/РГ-\d+-\d+\/\d{2}\.\d{2}\.\d{4}/);
  if (rgMatch) return rgMatch[0];

  // Decision/order number: "Решение/Заповед № NNN-NN/YYYY"
  const decisionMatch = text.match(
    /(?:Решение|Заповед|Постановление)\s*№?\s*([\d\-\/]+\d)/i,
  );
  if (decisionMatch?.[1]) return decisionMatch[1];

  // General numbered reference
  const numMatch = text.match(
    /(?:изх\.\s*|Изх\.\s*|№\s*)([\d\-]+\/\d{2}\.\d{2}\.\d{4})/,
  );
  if (numMatch?.[1]) return numMatch[1];

  return null;
}

/**
 * Classify the type of enforcement action from the text.
 *
 * Types:
 *   - fine                  — имуществена санкция, глоба
 *   - restriction           — ограничаване на дейността
 *   - license_revocation    — отнемане на лиценз
 *   - warning               — предупреждение
 *   - administrative_measure — принудителна административна мярка (default)
 *   - penalty_decree        — наказателно постановление
 */
function classifyActionType(text: string, fallback: string): string {
  const lower = text.toLowerCase();

  if (
    lower.includes("глоба") ||
    lower.includes("имуществена санкция") ||
    lower.includes("парична санкция")
  ) {
    return "fine";
  }
  if (lower.includes("отнемане на лиценз") || lower.includes("отнет лиценз")) {
    return "license_revocation";
  }
  if (
    lower.includes("ограничаване на дейността") ||
    lower.includes("спиране на дейността") ||
    lower.includes("забрана")
  ) {
    return "restriction";
  }
  if (lower.includes("предупреждение") || lower.includes("препоръка")) {
    return "warning";
  }
  if (lower.includes("наказателно постановление")) {
    return "penalty_decree";
  }
  if (lower.includes("принудителна") || lower.includes("принудителни")) {
    return "administrative_measure";
  }

  return fallback;
}

/**
 * Extract a fine/penalty amount in BGN (лева) from text.
 *
 * Handles Bulgarian number formatting:
 *   - Space as thousands separator: "150 000 лева"
 *   - Dot as thousands separator:   "150.000 лв."
 *   - Comma as decimal separator:   "1.500,50 лв."
 */
function extractBgnAmount(text: string): number | null {
  const patterns = [
    // "NN NNN лева" / "NN NNN лв."
    /([\d\s.]+(?:,\d+)?)\s*(?:лева|лв\.?|BGN)\b/gi,
    // "санкция/глоба в размер на NN NNN"
    /(?:санкция|глоба|глобата|санкцията)\s+(?:в размер на\s+)?([\d\s.]+(?:,\d+)?)\s*(?:лева|лв\.?|BGN)/gi,
    // "EUR NNN" or "NNN евро"
    /(?:EUR|евро)\s*([\d\s.]+(?:,\d+)?)/gi,
    /([\d\s.]+(?:,\d+)?)\s*(?:евро|EUR)/gi,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match?.[1]) {
      let numStr = match[1].trim();

      // Determine if dot is thousands or decimal separator
      // Bulgarian convention: space or dot = thousands, comma = decimal
      numStr = numStr.replace(/\s/g, ""); // remove space thousands separators

      // If format is "150.000" (dot as thousands) vs "1.50" (dot as decimal)
      // Check: if dot is followed by exactly 3 digits, it is thousands separator
      if (/\.\d{3}/.test(numStr)) {
        numStr = numStr.replace(/\./g, ""); // remove dot thousands separators
      }

      numStr = numStr.replace(",", "."); // comma decimal to dot decimal

      const val = parseFloat(numStr);

      // Convert EUR to BGN (fixed rate: 1 EUR = 1.95583 BGN)
      if (
        pattern.source.includes("евро") ||
        pattern.source.includes("EUR")
      ) {
        if (!isNaN(val) && val > 0) return Math.round(val * 1.95583);
      }

      if (!isNaN(val) && val > 0) return val;
    }
  }

  return null;
}

/**
 * Extract referenced ordinance/regulation numbers from enforcement text.
 *
 * Finds mentions of "Наредба № NN", "чл. NN" (article NN), and
 * references to specific laws (ЗППЦК, КЗ, КСО).
 */
function extractSourcebookReferences(text: string): string | null {
  const refs: Set<string> = new Set();

  // "Наредба № NN"
  const naredbaPattern = /Наредба\s*№?\s*(\d+[а-яА-Я]?)/gi;
  let m: RegExpExecArray | null;
  while ((m = naredbaPattern.exec(text)) !== null) {
    refs.add(`Наредба ${m[1]}`);
  }

  // Specific Bulgarian financial laws
  const lawAbbreviations: Array<{ pattern: RegExp; name: string }> = [
    { pattern: /ЗППЦК/g, name: "ЗППЦК" }, // Закон за публичното предлагане на ценни книжа
    { pattern: /ЗДКИС(?:ДПКИ)?/g, name: "ЗДКИСДПКИ" }, // Закон за дейността на колективните инвестиционни схеми
    { pattern: /КЗ\b/g, name: "КЗ" }, // Кодекс за застраховането
    { pattern: /КСО\b/g, name: "КСО" }, // Кодекс за социалното осигуряване
    { pattern: /ЗКФН/g, name: "ЗКФН" }, // Закон за Комисията за финансов надзор
    { pattern: /ЗПФИ/g, name: "ЗПФИ" }, // Закон за пазарите на финансови инструменти
    { pattern: /ЗОЗ/g, name: "ЗОЗ" }, // Закон за особените залози
    { pattern: /ЗМИП/g, name: "ЗМИП" }, // Закон за мерките срещу изпирането на пари
  ];

  for (const { pattern, name } of lawAbbreviations) {
    if (pattern.test(text)) {
      refs.add(name);
    }
  }

  if (refs.size === 0) return null;
  return [...refs].join(", ");
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

interface PreparedStatements {
  insertProvision: Database.Statement;
  deleteProvision: Database.Statement;
  insertEnforcement: Database.Statement;
  deleteEnforcement: Database.Statement;
  checkProvisionExists: Database.Statement;
  checkEnforcementExists: Database.Statement;
}

function initDb(): { db: Database.Database; stmts: PreparedStatements } {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  // Ensure sourcebooks exist
  const insertSourcebook = db.prepare(
    "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
  );
  insertSourcebook.run(
    "FSC_NAREDBI",
    "Наредби на КФН (FSC Ordinances)",
    "Binding ordinances (наредби) issued by the Financial Supervision Commission covering capital markets, insurance, and investment funds.",
  );
  insertSourcebook.run(
    "FSC_UKAZANIYA",
    "Указания на КФН (FSC Instructions)",
    "Non-binding guidance instructions (указания) issued by the FSC to supervised entities on compliance expectations.",
  );
  insertSourcebook.run(
    "BNB_NAREDBI",
    "Наредби на БНБ (BNB Ordinances)",
    "Binding ordinances issued by the Bulgarian National Bank (Българска народна банка) covering prudential requirements for credit institutions.",
  );

  const stmts: PreparedStatements = {
    insertProvision: db.prepare(`
      INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    deleteProvision: db.prepare(
      "DELETE FROM provisions WHERE sourcebook_id = ? AND reference = ?",
    ),
    insertEnforcement: db.prepare(`
      INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    deleteEnforcement: db.prepare(
      "DELETE FROM enforcement_actions WHERE firm_name = ? AND date = ?",
    ),
    checkProvisionExists: db.prepare(
      "SELECT 1 FROM provisions WHERE sourcebook_id = ? AND reference = ? LIMIT 1",
    ),
    checkEnforcementExists: db.prepare(
      "SELECT 1 FROM enforcement_actions WHERE firm_name = ? AND date = ? LIMIT 1",
    ),
  };

  return { db, stmts };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== FSC (КФН) Ingestion Crawler ===");
  console.log(`  Database:   ${DB_PATH}`);
  console.log(`  Dry run:    ${dryRun}`);
  console.log(`  Resume:     ${resume}`);
  console.log(`  Force:      ${force}`);
  if (maxPagesOverride) {
    console.log(`  Max pages:  ${maxPagesOverride}`);
  }

  const state = loadState();
  const processedSet = new Set(state.processedUrls);

  let db: Database.Database | null = null;
  let stmts: PreparedStatements | null = null;

  if (!dryRun) {
    const init = initDb();
    db = init.db;
    stmts = init.stmts;
    console.log(`  Database initialised at ${DB_PATH}`);
  }

  let provisionsIngested = 0;
  let enforcementsIngested = 0;
  let errors = 0;
  let skipped = 0;

  // -----------------------------------------------------------------------
  // Step 1: Ingest ordinances
  // -----------------------------------------------------------------------
  console.log("\n--- Step 1: Ordinances (Наредби / Указания) ---");

  for (const source of ORDINANCE_SOURCES) {
    // First: scrape inline ordinances from the listing page itself
    console.log(`\n  Scraping inline entries from: ${source.label}`);
    const inlineProvisions = await scrapeInlineOrdinances(source);
    console.log(`    Found ${inlineProvisions.length} inline ordinance entries`);

    for (const provision of inlineProvisions) {
      const syntheticUrl = `${BASE_URL}/inline/${source.id}/${provision.reference}`;

      if (processedSet.has(syntheticUrl) && resume) {
        skipped++;
        continue;
      }

      if (dryRun) {
        console.log(
          `    PROVISION: ${provision.reference} — ${provision.title.slice(0, 60)}`,
        );
        console.log(
          `      type=${provision.type}, status=${provision.status}, date=${provision.effective_date}`,
        );
      } else {
        try {
          const existing = stmts!.checkProvisionExists.get(
            provision.sourcebook_id,
            provision.reference,
          );

          if (existing && !force) {
            console.log(`    SKIP (exists): ${provision.reference}`);
            skipped++;
          } else {
            if (existing && force) {
              stmts!.deleteProvision.run(provision.sourcebook_id, provision.reference);
            }
            stmts!.insertProvision.run(
              provision.sourcebook_id,
              provision.reference,
              provision.title,
              provision.text,
              provision.type,
              provision.status,
              provision.effective_date,
              provision.chapter,
              provision.section,
            );
            console.log(`    INSERTED provision: ${provision.reference}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`    ERROR inserting ${provision.reference}: ${message}`);
          state.errors.push(`insert_error: ${provision.reference}: ${message}`);
          errors++;
        }
      }

      provisionsIngested++;
      processedSet.add(syntheticUrl);
      state.processedUrls.push(syntheticUrl);
    }

    // Second: follow links to individual ordinance detail pages
    const urls = await discoverOrdinanceUrls(source);

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;

      if (processedSet.has(url)) {
        if (resume) {
          skipped++;
          continue;
        }
      }

      // Skip PDF files for now — they require a different parsing strategy
      if (url.endsWith(".pdf")) {
        console.log(`    SKIP (PDF): ${url}`);
        skipped++;
        processedSet.add(url);
        state.processedUrls.push(url);
        continue;
      }

      console.log(
        `    [${i + 1}/${urls.length}] Fetching: ${url}`,
      );

      const html = await rateLimitedFetch(url);
      if (!html) {
        console.warn(`    [WARN] Could not fetch ${url}`);
        state.errors.push(`fetch_error: ${url}`);
        errors++;
        continue;
      }

      try {
        const provision = parseOrdinancePage(html, url, source.sourcebook_id);

        if (provision) {
          if (dryRun) {
            console.log(
              `    PROVISION: ${provision.reference} — ${provision.title.slice(0, 60)}`,
            );
            console.log(
              `      type=${provision.type}, status=${provision.status}, date=${provision.effective_date}`,
            );
          } else {
            const existing = stmts!.checkProvisionExists.get(
              provision.sourcebook_id,
              provision.reference,
            );

            if (existing && !force) {
              console.log(`    SKIP (exists): ${provision.reference}`);
              skipped++;
            } else {
              if (existing && force) {
                stmts!.deleteProvision.run(provision.sourcebook_id, provision.reference);
              }
              stmts!.insertProvision.run(
                provision.sourcebook_id,
                provision.reference,
                provision.title,
                provision.text,
                provision.type,
                provision.status,
                provision.effective_date,
                provision.chapter,
                provision.section,
              );
              console.log(`    INSERTED provision: ${provision.reference}`);
            }
          }

          provisionsIngested++;
        } else {
          console.log(`    SKIP — could not parse provision data`);
          skipped++;
        }

        processedSet.add(url);
        state.processedUrls.push(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`    ERROR: ${message}`);
        state.errors.push(`parse_error: ${url}: ${message}`);
        errors++;
      }

      // Save state periodically
      if ((i + 1) % 25 === 0) {
        state.provisionsIngested += provisionsIngested;
        saveState(state);
        console.log(`    [checkpoint] State saved after ${i + 1} URLs`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 2: Ingest enforcement actions
  // -----------------------------------------------------------------------
  console.log("\n--- Step 2: Enforcement Actions (Принудителни мерки) ---");

  for (const source of ENFORCEMENT_SOURCES) {
    const urls = await discoverEnforcementUrls(source);

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i]!;

      if (processedSet.has(url)) {
        if (resume) {
          skipped++;
          continue;
        }
      }

      // Skip PDF files
      if (url.endsWith(".pdf")) {
        console.log(`    SKIP (PDF): ${url}`);
        skipped++;
        processedSet.add(url);
        state.processedUrls.push(url);
        continue;
      }

      console.log(
        `    [${i + 1}/${urls.length}] Fetching: ${url}`,
      );

      const html = await rateLimitedFetch(url);
      if (!html) {
        console.warn(`    [WARN] Could not fetch ${url}`);
        state.errors.push(`fetch_error: ${url}`);
        errors++;
        continue;
      }

      try {
        const enforcement = parseEnforcementPage(html, url, source.actionType);

        if (enforcement) {
          if (dryRun) {
            console.log(
              `    ENFORCEMENT: ${enforcement.firm_name} — ${enforcement.action_type}`,
            );
            console.log(
              `      amount=${enforcement.amount}, date=${enforcement.date}, ref=${enforcement.reference_number}`,
            );
          } else {
            try {
              const existing = stmts!.checkEnforcementExists.get(
                enforcement.firm_name,
                enforcement.date,
              );

              if (existing && !force) {
                console.log(`    SKIP (exists): ${enforcement.firm_name}`);
                skipped++;
              } else {
                if (existing && force) {
                  stmts!.deleteEnforcement.run(enforcement.firm_name, enforcement.date);
                }
                stmts!.insertEnforcement.run(
                  enforcement.firm_name,
                  enforcement.reference_number,
                  enforcement.action_type,
                  enforcement.amount,
                  enforcement.date,
                  enforcement.summary,
                  enforcement.sourcebook_references,
                );
                console.log(
                  `    INSERTED enforcement: ${enforcement.firm_name}`,
                );
              }
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error(
                `    ERROR inserting ${enforcement.firm_name}: ${message}`,
              );
              state.errors.push(
                `insert_error: ${enforcement.firm_name}: ${message}`,
              );
              errors++;
            }
          }

          enforcementsIngested++;
        } else {
          // The page might be a year-based sub-listing — try to discover
          // further links from it
          const $ = cheerio.load(html);
          let subUrls = 0;
          $("a[href]").each((_i, el) => {
            const href = $(el).attr("href");
            if (!href) return;
            const fullUrl = href.startsWith("http")
              ? href
              : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

            if (
              fullUrl.includes("fsc.bg") &&
              !processedSet.has(fullUrl) &&
              !urls.includes(fullUrl) &&
              (href.includes("prinuditelni") ||
                href.includes("nakazatelni") ||
                /\/\d{4}(-\d)?\//.test(href))
            ) {
              urls.push(fullUrl);
              subUrls++;
            }
          });
          if (subUrls > 0) {
            console.log(
              `    Sub-listing page — discovered ${subUrls} additional URLs`,
            );
          } else {
            console.log(`    SKIP — could not parse enforcement data`);
            skipped++;
          }
        }

        processedSet.add(url);
        state.processedUrls.push(url);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`    ERROR: ${message}`);
        state.errors.push(`parse_error: ${url}: ${message}`);
        errors++;
      }

      // Save state periodically
      if ((i + 1) % 25 === 0) {
        state.enforcementsIngested += enforcementsIngested;
        saveState(state);
        console.log(`    [checkpoint] State saved after ${i + 1} URLs`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 3: Final state save and summary
  // -----------------------------------------------------------------------
  state.provisionsIngested += provisionsIngested;
  state.enforcementsIngested += enforcementsIngested;
  saveState(state);

  if (!dryRun && db) {
    const provisionCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions").get() as {
        cnt: number;
      }
    ).cnt;
    const sourcebookCount = (
      db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as {
        cnt: number;
      }
    ).cnt;
    const enforcementCount = (
      db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as {
        cnt: number;
      }
    ).cnt;
    const ftsCount = (
      db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as {
        cnt: number;
      }
    ).cnt;

    console.log("\n=== Ingestion Complete ===");
    console.log(`  Sourcebooks in DB:          ${sourcebookCount}`);
    console.log(`  Provisions in DB:           ${provisionCount}`);
    console.log(`  Enforcement actions in DB:  ${enforcementCount}`);
    console.log(`  FTS entries:                ${ftsCount}`);
    console.log(`  New provisions:             ${provisionsIngested}`);
    console.log(`  New enforcement actions:    ${enforcementsIngested}`);
    console.log(`  Errors:                     ${errors}`);
    console.log(`  Skipped:                    ${skipped}`);
    console.log(`  State saved to:             ${STATE_FILE}`);

    db.close();
  } else {
    console.log("\n=== Dry Run Complete ===");
    console.log(`  Provisions found:           ${provisionsIngested}`);
    console.log(`  Enforcement actions found:  ${enforcementsIngested}`);
    console.log(`  Errors:                     ${errors}`);
    console.log(`  Skipped:                    ${skipped}`);
  }

  console.log(`\nDone.`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
