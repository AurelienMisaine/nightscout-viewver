/**
 * Agrégation des traitements Trio pour l'envoi vers MyDiabby.
 * - Bolus manuels (eventType "Bolus") : envoyés tels quels, glucides rattachés (±30 min)
 * - SMB : sommés par heure locale -> 1 bolus de correction par heure
 * - Temp Basal : insuline réellement délivrée par heure (débits intégrés),
 *   trous comblés par le profil basal programmé
 * Trio n'envoie pas de champ `date` : on utilise created_at.
 */
import { NightscoutTreatment } from "@/types/nightscout";

export interface AggItem {
  date: string; // AAAA-MM-JJ (heure locale)
  time: string; // HH:MM (heure locale)
  units: number;
  isCorrection?: boolean;
  carbs?: number;
}

/** Profil basal programmé (U/h), heure de début -> débit. Export Trio du 05/10/2026. */
export const SCHEDULED_BASAL: [number, number][] = [
  [0, 0.6], [4, 0.85], [6, 0.8], [12, 0.85], [16, 0.75], [20, 0.85],
];

const H = 3600_000;
const MIN_CARB_MATCH = 30 * 60_000;

/** Type d'origine Trio (conservé par normalizeTrio). */
export const kind = (t: NightscoutTreatment) =>
  (t as NightscoutTreatment & { trioEventType?: string }).trioEventType ?? t.eventType;

export function tsOf(t: Partial<NightscoutTreatment>): number {
  return new Date(t.date || t.created_at || t.timestamp || "").getTime();
}

const pad = (n: number) => String(n).padStart(2, "0");
/** Date et heure LOCALES (corrige le mélange date UTC / heure locale d'origine). */
export function localDateTime(ms: number) {
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

function scheduledRate(ms: number): number {
  const h = new Date(ms).getHours();
  let r = SCHEDULED_BASAL[0][1];
  for (const [start, rate] of SCHEDULED_BASAL) if (h >= start) r = rate;
  return r;
}

const startOfHour = (ms: number) => { const d = new Date(ms); d.setMinutes(0, 0, 0); return d.getTime(); };
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Glucides saisis par l'utilisateur (exclut les équivalents FPU générés par Trio, sans clé foodType). */
function userCarbs(ts: NightscoutTreatment[]) {
  return ts.filter((t) => typeof t.carbs === "number" && t.carbs > 0 &&
    !["Bolus", "SMB", "Temp Basal", "Meal Bolus", "Correction Bolus"].includes(kind(t)) &&
    "foodType" in (t as object));
}

export function manualBoluses(ts: NightscoutTreatment[]): { items: AggItem[]; unmatchedCarbs: number; mealIds: Set<string> } {
  const boluses = ts
    .filter((t) => ["Bolus", "Meal Bolus", "Correction Bolus"].includes(kind(t)) &&
      typeof t.insulin === "number" && t.insulin > 0)
    .sort((a, b) => tsOf(a) - tsOf(b));
  const carbs = userCarbs(ts).map((c) => ({ ms: tsOf(c), g: c.carbs as number }));
  // Appariement global : paires bolus/glucides triées par écart, la plus proche d'abord
  const pairs: [number, number, number][] = [];
  boluses.forEach((b, i) => carbs.forEach((c, j) => {
    const d = Math.abs(c.ms - tsOf(b));
    if (d <= MIN_CARB_MATCH) pairs.push([d, i, j]);
  }));
  pairs.sort((a, b) => a[0] - b[0]);
  const carbOf = new Map<number, number>(), usedCarb = new Set<number>();
  for (const [, i, j] of pairs) {
    if (carbOf.has(i) || usedCarb.has(j)) continue;
    carbOf.set(i, j); usedCarb.add(j);
  }
  const items = boluses.map((b, i) => {
    const j = carbOf.get(i);
    return {
      ...localDateTime(tsOf(b)),
      units: r2(b.insulin as number),
      carbs: j === undefined ? undefined : carbs[j].g,
      isCorrection: kind(b) === "Correction Bolus" || (j === undefined && kind(b) !== "Meal Bolus"),
    };
  });
  const mealIds = new Set([...carbOf.keys()].map((i) => boluses[i]._id));
  return { items, unmatchedCarbs: carbs.length - usedCarb.size, mealIds };
}

/** Bornes des heures complètes couvertes par les données (exclut l'heure en cours). */
function completeHours(ts: NightscoutTreatment[], nowMs: number): number[] {
  const times = ts.map(tsOf).filter(Number.isFinite);
  if (!times.length) return [];
  const first = startOfHour(Math.min(...times)) + H; // 1re heure partielle exclue
  const last = Math.min(startOfHour(Math.max(...times)), startOfHour(nowMs));
  const hours: number[] = [];
  for (let h = first; h < last; h += H) hours.push(h);
  return hours;
}

export function hourlySMB(ts: NightscoutTreatment[], nowMs = Date.now()): AggItem[] {
  const hours = new Set(completeHours(ts, nowMs));
  const sums = new Map<number, number>();
  for (const t of ts) {
    if (kind(t) !== "SMB" || typeof t.insulin !== "number") continue;
    const h = startOfHour(tsOf(t));
    if (hours.has(h)) sums.set(h, (sums.get(h) || 0) + t.insulin);
  }
  return [...sums].filter(([, u]) => u >= 0.05).sort((a, b) => a[0] - b[0])
    .map(([h, u]) => ({ ...localDateTime(h), units: r2(u), isCorrection: true }));
}

export function hourlyBasal(ts: NightscoutTreatment[], nowMs = Date.now()): AggItem[] {
  const temps = ts
    .filter((t) => t.eventType === "Temp Basal" && typeof t.rate === "number")
    .map((t) => ({ start: tsOf(t), end: tsOf(t) + (t.duration || 0) * 60_000, rate: t.rate as number }))
    .sort((a, b) => a.start - b.start);
  // Un temp basal se termine au début du suivant
  for (let i = 0; i < temps.length - 1; i++) temps[i].end = Math.min(temps[i].end, temps[i + 1].start);

  return completeHours(ts, nowMs).map((h) => {
    const hEnd = h + H;
    let units = 0, covered = 0;
    for (const tb of temps) {
      const s = Math.max(tb.start, h), e = Math.min(tb.end, hEnd);
      if (e > s) { units += (tb.rate * (e - s)) / H; covered += e - s; }
    }
    // Trous sans temp basal -> basal programmé (approximation par minute)
    if (covered < H - 60_000) {
      for (let m = h; m < hEnd; m += 60_000) {
        if (!temps.some((tb) => tb.start <= m && m < tb.end)) units += scheduledRate(m) / 60;
      }
    }
    return { ...localDateTime(h), units: r2(units) };
  });
}

/**
 * Adapte les traitements Trio au format attendu par l'affichage DiabExplorer :
 * - `date` <- created_at ; `identifier` <- id
 * - Bolus -> "Meal Bolus" (glucides à ±30 min) ou "Correction Bolus" ; SMB -> "Correction Bolus"
 *   (type d'origine conservé dans `trioEventType`)
 * - glucides FPU générés par Trio retirés de l'affichage (gardés dans `fpuCarbs`)
 * - durée des Temp Basal ramenée à leur durée effective (Trio en relance un toutes les ~5 min)
 */
export function normalizeTrio(ts: NightscoutTreatment[]): NightscoutTreatment[] {
  const { mealIds } = manualBoluses(ts);
  const out = ts.map((t) => {
    const raw = t as NightscoutTreatment & { id?: string; trioEventType?: string; fpuCarbs?: number };
    const n = { ...raw, date: t.date || t.created_at || t.timestamp, identifier: t.identifier ?? raw.id ?? t._id };
    if (t.eventType === "Bolus") {
      n.trioEventType = "Bolus";
      n.eventType = mealIds.has(t._id) ? "Meal Bolus" : "Correction Bolus";
    } else if (t.eventType === "SMB") {
      n.trioEventType = "SMB";
      n.eventType = "Correction Bolus";
    }
    if (typeof t.carbs === "number" && t.carbs > 0 && t.eventType === "Carb Correction" && !("foodType" in raw)) {
      n.fpuCarbs = t.carbs;
      n.carbs = undefined;
    }
    if (t.eventType === "Bolus" || t.eventType === "SMB") n.carbs = undefined;
    return n;
  });
  const temps = out.filter((t) => t.eventType === "Temp Basal").sort((a, b) => tsOf(a) - tsOf(b));
  for (let i = 0; i < temps.length - 1; i++) {
    const gapMin = (tsOf(temps[i + 1]) - tsOf(temps[i])) / 60_000;
    temps[i].duration = Math.max(0, Math.min(temps[i].duration || 0, gapMin));
  }
  return out;
}
