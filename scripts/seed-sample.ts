/**
 * Seed the FSC (КФН) database with sample provisions for testing.
 *
 * Inserts Bulgarian FSC ordinances and BNB regulations so MCP tools
 * can be tested without a full ingestion pipeline.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # drop and recreate
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["FSC_DB_PATH"] ?? "data/fsc.db";
const force = process.argv.includes("--force");

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

console.log(`Database initialised at ${DB_PATH}`);

// Sourcebooks

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
  {
    id: "FSC_NAREDBI",
    name: "Наредби на КФН (FSC Ordinances)",
    description:
      "Binding ordinances (наредби) issued by the Financial Supervision Commission covering capital markets, insurance, and investment funds.",
  },
  {
    id: "FSC_UKAZANIYA",
    name: "Указания на КФН (FSC Instructions)",
    description:
      "Non-binding guidance instructions (указания) issued by the FSC to supervised entities on compliance expectations.",
  },
  {
    id: "BNB_NAREDBI",
    name: "Наредби на БНБ (BNB Ordinances)",
    description:
      "Binding ordinances issued by the Bulgarian National Bank (Българска народна банка) covering prudential requirements for credit institutions.",
  },
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inserted ${sourcebooks.length} sourcebooks`);

// Sample provisions

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // FSC Ordinances on capital markets
  {
    sourcebook_id: "FSC_NAREDBI",
    reference: "Наредба 38",
    title: "Наредба № 38 относно изискванията към дейността на инвестиционните посредници",
    text: "Наредба № 38 от 2007 г. на Комисията за финансов надзор относно изискванията към дейността на инвестиционните посредници. Инвестиционните посредници са длъжни да действат честно, справедливо и професионално в съответствие с интересите на своите клиенти. Те трябва да въведат и поддържат ефективни механизми за управление на конфликта на интереси и да осигурят висококачествено изпълнение на нарежданията на клиентите при най-добрите условия.",
    type: "Наредба",
    status: "in_force",
    effective_date: "2007-07-01",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "FSC_NAREDBI",
    reference: "Наредба 44",
    title: "Наредба № 44 относно изискванията към дейността на колективните инвестиционни схеми",
    text: "Наредба № 44 от 2011 г. регулира дейността на колективните инвестиционни схеми (КИС) и управляващите дружества. Управляващите дружества са задължени да действат единствено в интерес на инвеститорите, да поддържат адекватно ниво на собствен капитал и да прилагат подходящи политики за управление на риска, включително пазарен риск, кредитен риск и риск от ликвидност.",
    type: "Наредба",
    status: "in_force",
    effective_date: "2011-11-04",
    chapter: "2",
    section: "2.1",
  },
  {
    sourcebook_id: "FSC_NAREDBI",
    reference: "Наредба 50",
    title: "Наредба № 50 относно капиталовата адекватност и ликвидността на инвестиционните посредници",
    text: "Наредба № 50 установява изискванията за капиталова адекватност на инвестиционните посредници съгласно Регламент (ЕС) № 575/2013. Инвестиционните посредници са длъжни да поддържат по всяко време достатъчно собствен капитал за покриване на кредитния риск, пазарния риск и операционния риск. Минималният размер на собствения капитал не може да бъде по-малко от 730 000 евро за инвестиционни посредници с пълен лиценз.",
    type: "Наредба",
    status: "in_force",
    effective_date: "2014-01-01",
    chapter: "3",
    section: "3.1",
  },
  {
    sourcebook_id: "FSC_NAREDBI",
    reference: "Наредба 48",
    title: "Наредба № 48 за изискванията към инвестиционните посредници при сключване на сделки с финансови инструменти",
    text: "Наредба № 48 урежда изискванията за изпълнение на нарежданията при най-добри условия (best execution). Инвестиционните посредници са длъжни да вземат всички необходими мерки за постигане на най-добрия резултат за своите клиенти при изпълнение на техните нареждания, отчитайки цена, разходи, скорост, вероятност за изпълнение и сетълмент, обем, естество или всички други съображения, свързани с изпълнението на нареждането.",
    type: "Наредба",
    status: "in_force",
    effective_date: "2017-01-03",
    chapter: "4",
    section: "4.2",
  },
  {
    sourcebook_id: "FSC_NAREDBI",
    reference: "Наредба 53",
    title: "Наредба № 53 за изискванията към съдържанието на проспекта при публично предлагане",
    text: "Наредба № 53 определя минималното съдържание на проспектите при публично предлагане на ценни книжа и допускане до търговия на регулиран пазар. Проспектът трябва да съдържа пълна, точна и актуална информация за емитента, финансовото му положение, перспективите и свързаните с тях рискове, необходима за вземане на информирано инвестиционно решение.",
    type: "Наредба",
    status: "in_force",
    effective_date: "2019-07-21",
    chapter: "5",
    section: "5.1",
  },
  // FSC Instructions
  {
    sourcebook_id: "FSC_UKAZANIYA",
    reference: "Указание 2",
    title: "Указание относно прилагането на изискванията за подходящост и пригодност",
    text: "Настоящото указание на КФН пояснява прилагането на изискванията за оценка на подходящост (suitability) и пригодност (appropriateness) при предоставяне на инвестиционни услуги. Инвестиционните посредници следва да събират достатъчна информация за знанията и опита на клиента в съответната инвестиционна област, финансовото му положение и инвестиционните му цели, за да определят дали конкретна услуга или продукт е подходяща за него.",
    type: "Указание",
    status: "in_force",
    effective_date: "2018-05-15",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "FSC_UKAZANIYA",
    reference: "Указание 5",
    title: "Указание относно предотвратяване на пазарните злоупотреби",
    text: "Указанието конкретизира задълженията на поднадзорните лица по Регламент (ЕС) № 596/2014 (MAR) за предотвратяване на пазарните злоупотреби. Включва изисквания за разкриване на вътрешна информация, забрана за търговия с вътрешна информация, забрана за манипулиране на пазара, задължения за уведомяване на компетентния орган и водене на списък на лицата с достъп до вътрешна информация.",
    type: "Указание",
    status: "in_force",
    effective_date: "2020-03-01",
    chapter: "2",
    section: "2.1",
  },
  // BNB Ordinances
  {
    sourcebook_id: "BNB_NAREDBI",
    reference: "Наредба 7",
    title: "Наредба № 7 на БНБ за организацията и управлението на рисковете в банките",
    text: "Наредба № 7 на Управителния съвет на БНБ установява изисквания към кредитните институции за организацията и управлението на рисковете. Банките са длъжни да разполагат с надеждни, ефективни и цялостни стратегии, политики, процедури и системи за установяване, измерване, управление и наблюдение на кредитния риск, пазарния риск, операционния риск и риска от ликвидност на текуща и бъдеща основа.",
    type: "Наредба",
    status: "in_force",
    effective_date: "2014-04-01",
    chapter: "1",
    section: "1.1",
  },
  {
    sourcebook_id: "BNB_NAREDBI",
    reference: "Наредба 11",
    title: "Наредба № 11 на БНБ относно управлението и надзора върху ликвидността на банките",
    text: "Наредба № 11 регламентира управлението на ликвидния риск в кредитните институции. Банките са задължени да поддържат ниво на ликвидност, достатъчно за изпълнение на задълженията им по всяко време. Изискването за покритие на ликвидността (LCR) е 100%, а коефициентът на нетно стабилно финансиране (NSFR) трябва да е не по-малко от 100%.",
    type: "Наредба",
    status: "in_force",
    effective_date: "2015-10-01",
    chapter: "2",
    section: "2.1",
  },
  {
    sourcebook_id: "BNB_NAREDBI",
    reference: "Наредба 22",
    title: "Наредба № 22 на БНБ относно централния кредитен регистър",
    text: "Наредба № 22 урежда реда и условията за предоставяне, съхранение и предоставяне на информация от Централния кредитен регистър (ЦКР). Кредитните институции са задължени да подават ежемесечно информация за кредитните задължения на своите клиенти в ЦКР. Информацията се използва за оценка на кредитоспособността на кредитополучателите и за надзорни цели.",
    type: "Наредба",
    status: "in_force",
    effective_date: "2009-01-01",
    chapter: "3",
    section: "3.1",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
      p.sourcebook_id,
      p.reference,
      p.title,
      p.text,
      p.type,
      p.status,
      p.effective_date,
      p.chapter,
      p.section,
    );
  }
});

insertAll();

console.log(`Inserted ${provisions.length} sample provisions`);

// Sample enforcement actions

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "БКС Финансова Група ЕАД",
    reference_number: "2023-FSC-0147",
    action_type: "fine",
    amount: 150_000,
    date: "2023-06-15",
    summary:
      "КФН наложи имуществена санкция на БКС Финансова Група ЕАД в размер на 150 000 лева за нарушения на изискванията за капиталова адекватност по Наредба № 50. Установено е, че дружеството е поддържало собствен капитал под минимално изискуемото ниво за период от три последователни месеца без своевременно уведомяване на регулатора.",
    sourcebook_references: "Наредба 50",
  },
  {
    firm_name: "Медиана Инвест АД",
    reference_number: "2022-FSC-0089",
    action_type: "restriction",
    amount: 0,
    date: "2022-11-30",
    summary:
      "КФН издаде заповед за ограничаване на дейността на Медиана Инвест АД поради системни нарушения на правилата за оценка на подходящост на клиентите по Наредба № 38. Дружеството е предоставяло инвестиционни услуги на клиенти без извършване на изискуемата оценка на подходящостта и е разпространявало подвеждащи инвестиционни препоръки.",
    sourcebook_references: "Наредба 38, Указание 2",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();

console.log(`Inserted ${enforcements.length} sample enforcement actions`);

// Summary

const provisionCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }
).cnt;
const sourcebookCount = (
  db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }
).cnt;
const enforcementCount = (
  db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }
).cnt;
const ftsCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }
).cnt;

console.log(`\nDatabase summary:`);
console.log(`  Sourcebooks:          ${sourcebookCount}`);
console.log(`  Provisions:           ${provisionCount}`);
console.log(`  Enforcement actions:  ${enforcementCount}`);
console.log(`  FTS entries:          ${ftsCount}`);
console.log(`\nDone. Database ready at ${DB_PATH}`);

db.close();
