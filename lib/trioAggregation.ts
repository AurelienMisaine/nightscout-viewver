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

// ---------------------------------------------------------------------------
// Évènements de boucle (Tai/Trio) -> repas, sport et remarques MyDiabby
// ---------------------------------------------------------------------------

export interface LoopEvent {
  date: string;
  time: string;
  kind: "meal" | "sport" | "note";
  description: string;
  durationMin?: number;
}

type TT = NightscoutTreatment & { targetBottom?: number; targetTop?: number };
const MIN = 60_000;
const MIN_EVENT_MIN = 5; // en dessous : activations en double / annulées, ignorées
const MEAL_CLUSTER_MIN = 15; // activations successives de la cible 80 = un seul repas
const BUTTON_BOLUS_BEFORE_MIN = 2; // le bolus du bouton part à l'activation de la cible 80
const BUTTON_BOLUS_AFTER_MIN = 3;
const GENERIC_NOTES = /^(temp target|custom target)$/i;

const label = (t: NightscoutTreatment) => (t.notes || "").trim();
const fmtU = (u: number) => `${Number.isInteger(u) ? u : u.toFixed(1)} U`;

export function loopEvents(ts: NightscoutTreatment[]): LoopEvent[] {
  const out: LoopEvent[] = [];
  const at = (ms: number) => localDateTime(ms);
  const byTime = (a: NightscoutTreatment, b: NightscoutTreatment) => tsOf(a) - tsOf(b);

  const targets = ts.filter((t) => t.eventType === "Temporary Target").sort(byTime) as TT[];
  const overrides = ts.filter((t) => t.eventType === "Exercise").sort(byTime);
  const manual = ts.filter((t) => kind(t) === "Bolus" && typeof t.insulin === "number");
  const isMealOverride = (t: NightscoutTreatment) => /repas/i.test(label(t));
  const isSportOverride = (t: NightscoutTreatment) => /sport/i.test(label(t));

  // Durée effective d'une dérogation : jusqu'à la dérogation suivante si elle arrive avant la fin
  const effective = (list: NightscoutTreatment[], i: number) => {
    const start = tsOf(list[i]);
    const next = list.slice(i + 1).find((o) => tsOf(o) > start);
    const end = Math.min(start + (list[i].duration || 0) * MIN, next ? tsOf(next) : Infinity);
    return Math.round((end - start) / MIN);
  };

  // 1. Repas = activation(s) de la cible 80 (bouton raccourci)
  const meals: { start: number; last: number; maxDur: number }[] = [];
  for (const t of targets.filter((t) => t.targetBottom === 80)) {
    const ms = tsOf(t);
    const cur = meals[meals.length - 1];
    if (cur && ms - cur.last <= MEAL_CLUSTER_MIN * MIN) {
      cur.last = ms;
      cur.maxDur = Math.max(cur.maxDur, t.duration || 0);
    } else meals.push({ start: ms, last: ms, maxDur: t.duration || 0 });
  }
  const usedMealOverrides = new Set<string>();
  for (const m of meals.filter((m) => m.maxDur >= MIN_EVENT_MIN)) {
    const bolus = manual
      .filter((b) => tsOf(b) >= m.start - BUTTON_BOLUS_BEFORE_MIN * MIN && tsOf(b) <= m.last + BUTTON_BOLUS_AFTER_MIN * MIN)
      .reduce((s, b) => s + (b.insulin as number), 0);
    const derogIdx = overrides.findIndex(
      (o) => isMealOverride(o) && (o.duration || 0) >= MIN_EVENT_MIN && Math.abs(tsOf(o) - m.start) <= MEAL_CLUSTER_MIN * MIN
    );
    let desc = bolus > 0 ? `Repas – bouton : ${fmtU(bolus)} + cible 80` : "Repas – bouton : cible 80 seule, sans bolus";
    if (derogIdx >= 0) {
      usedMealOverrides.add(overrides[derogIdx]._id);
      desc += ` + dérogation repas (${effective(overrides, derogIdx)} min)`;
    }
    out.push({ ...at(m.start), kind: "meal", description: desc + " – boucle sans annonce de glucides" });
  }

  // 2. Dérogations
  overrides.forEach((o, i) => {
    if ((o.duration || 0) < MIN_EVENT_MIN || usedMealOverrides.has(o._id)) return;
    const dur = effective(overrides, i);
    if (dur < MIN_EVENT_MIN) return;
    if (isSportOverride(o)) {
      out.push({ ...at(tsOf(o)), kind: "sport", description: `Dérogation ${label(o)}`, durationMin: dur });
    } else if (isMealOverride(o)) {
      out.push({ ...at(tsOf(o)), kind: "meal", description: `Repas – dérogation repas seule (${dur} min) – boucle sans annonce de glucides` });
    } else {
      out.push({ ...at(tsOf(o)), kind: "note", description: `Dérogation ${label(o) || "sans nom"} (${dur} min)` });
    }
  });

  // 3. Autres cibles temporaires -> remarques
  targets.forEach((t, i) => {
    if (t.targetBottom === 80 || (t.duration || 0) < MIN_EVENT_MIN) return;
    const dur = effective(targets, i);
    if (dur < MIN_EVENT_MIN) return;
    const name = label(t) && !GENERIC_NOTES.test(label(t)) ? ` – ${label(t)}` : "";
    out.push({ ...at(tsOf(t)), kind: "note", description: `Cible temporaire ${t.targetBottom} mg/dL${name} (${dur} min)` });
  });

  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}
