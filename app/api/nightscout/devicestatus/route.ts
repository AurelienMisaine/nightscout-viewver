import { NextRequest, NextResponse } from "next/server";
import { isDemoMode } from "@/lib/demoData";
import type { LoopStatus } from "@/lib/loopView";

/**
 * État de la boucle (Trio / Tai) sur une période courte (un jour) :
 * IOB, COB, cible active, ISF, ratio de sensibilité, glycémie prévue et raison du cycle.
 * Les enregistrements bruts font ~5 Ko chacun : on ne renvoie que les champs utiles.
 */
interface RawStatus {
  created_at?: string;
  mills?: number;
  openaps?: {
    iob?: { iob?: number } | { iob?: number }[];
    suggested?: {
      IOB?: number;
      COB?: number;
      current_target?: number;
      ISF?: number;
      sensitivityRatio?: number;
      eventualBG?: number;
      reason?: string;
      timestamp?: string;
      deliverAt?: string;
    };
  };
}

const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);

export async function POST(request: NextRequest) {
  try {
    const { url, token, from, to } = (await request.json()) as {
      url: string;
      token: string;
      from: number;
      to: number;
    };
    if (isDemoMode(url)) return NextResponse.json([]);
    if (!url || from == null || to == null) {
      return NextResponse.json({ error: "url, from et to sont requis" }, { status: 400 });
    }

    const qs = new URLSearchParams({
      "find[created_at][$gte]": new Date(from).toISOString(),
      "find[created_at][$lte]": new Date(to).toISOString(),
      count: "1500",
    });
    if (token) qs.set("token", token);
    const res = await fetch(`${url.replace(/\/$/, "")}/api/v1/devicestatus.json?${qs}`, {
      headers: { Accept: "application/json", ...(token ? { "API-SECRET": token } : {}) },
      next: { revalidate: 0 },
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Nightscout: ${res.status}` }, { status: res.status });
    }
    const raw = (await res.json()) as RawStatus[];

    const out: LoopStatus[] = [];
    const seen = new Set<number>();
    for (const r of raw) {
      const s = r.openaps?.suggested;
      if (!s) continue;
      const t = new Date(s.deliverAt || s.timestamp || r.created_at || r.mills || 0).getTime();
      // Trio envoie souvent deux enregistrements par cycle : on n'en garde qu'un par minute
      const key = Math.round(t / 60_000);
      if (!t || seen.has(key)) continue;
      seen.add(key);
      const iobObj = Array.isArray(r.openaps?.iob) ? r.openaps?.iob[0] : r.openaps?.iob;
      out.push({
        t,
        iob: num(s.IOB) ?? num(iobObj?.iob),
        cob: num(s.COB),
        target: num(s.current_target),
        isf: num(s.ISF),
        ratio: num(s.sensitivityRatio),
        eventualBG: num(s.eventualBG),
        reason: typeof s.reason === "string"
          ? s.reason.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").slice(0, 600)
          : null,
      });
    }
    out.sort((a, b) => a.t - b.t);
    return NextResponse.json(out);
  } catch (e) {
    console.error("[api/nightscout/devicestatus]", e);
    return NextResponse.json({ error: "Erreur lors de la récupération de l'état de la boucle" }, { status: 500 });
  }
}
