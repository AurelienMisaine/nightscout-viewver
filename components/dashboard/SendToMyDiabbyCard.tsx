// app/components/dashboard/SendToMyDiabbyCard.tsx
import React, { useState, useEffect, useRef } from "react";
import { NightscoutEntry, NightscoutTreatment } from "@/types/nightscout";
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import Image from "next/image";
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { manualBoluses, hourlySMB, hourlyBasal, localDateTime, AggItem } from "@/lib/trioAggregation";

// Ajout du type pour les entrées MyDiabby
interface MyDiabbyGlycemiaEntry {
  date: string;
  time: string;
  glycemia?: {
    value?: string;
    typemeal?: string;
    pp?: string;
    idsurvey?: string;
  };
  insulin?: {
    bolus?: string;
    bolus_corr?: string;
    basal?: string;
  };
  meal?: {
    carb?: string;
  };
  // Ajoutez d'autres champs si besoin
}

export function SendToMyDiabbyCard({ data, treatments, isDemo = false }: { data: NightscoutEntry[], treatments: NightscoutTreatment[], isDemo?: boolean }) {
  const { t } = useTranslation('common');
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelRef = useRef(false);

  // État pour la modale d'envoi groupé
  const [openSendModal, setOpenSendModal] = useState(false);
  const [sendGlycemia, setSendGlycemia] = useState(true);
  const [sendBolus, setSendBolus] = useState(true);
  const [sendBasal, setSendBasal] = useState(false);

  // Charger depuis localStorage au montage
  useEffect(() => {
    const savedToken = localStorage.getItem("mydiabbyToken") || "";
    setToken(savedToken);
    setIsLoggedIn(!!savedToken);
  }, []);

  // Sauvegarder dans localStorage à chaque changement
  useEffect(() => {
    if (token) {
      localStorage.setItem("mydiabbyToken", token);
      setIsLoggedIn(true);
    }
  }, [token]);

  useEffect(() => {
    cancelRef.current = cancelRequested;
  }, [cancelRequested]);

  async function loginToMyDiabby(e: React.FormEvent) {
    e.preventDefault();
    setStatus(null);
    setLoading(true);
    try {
      const url = "https://app.mydiabby.com/api/getToken";
      const body = new URLSearchParams({
        username: email,
        password: password,
        platform: "dt",
      });
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json, text/plain, */*",
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-locale": "fr",
        },
        credentials: "include", // important pour le cookie PHPSESSID
        body: body.toString(),
      });
      if (!response.ok) {
        throw new Error(t('SendToMyDiabbyCard.login_error'));
      }
      const data = await response.json();
      if (!data.token) {
        throw new Error(t('SendToMyDiabbyCard.token_error'));
      }
      setToken(data.token);
      setStatus(t('SendToMyDiabbyCard.login_success'));
    } catch (e: unknown) {
      setStatus(
        t('SendToMyDiabbyCard.login_error_prefix') +
          ' ' +
          (e instanceof Error ? e.message : String(e))
      );
    }
    setLoading(false);
  }

  async function sendGlycemiaToMyDiabby({
    token,
    glycemia,
    date,
    time,
  }: {
    token: string;
    glycemia: string;
    date: string;
    time: string;
  }) {
    const url = "https://app.mydiabby.com/api/data";
    const body = new URLSearchParams({
      time,
      date,
      add: "true",
      dgnew: "false",
      "glycemia[value]": glycemia,
      "glycemia[typemeal]": "1",
      "glycemia[pp]": "false",
      "glycemia[idsurvey]": "2",
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-locale": "fr",
      },
      credentials: "include",
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error(t('SendToMyDiabbyCard.send_api_error'));
    }
    return response.json();
  }

  // Fonction d'envoi d'un bolus (repas ou correction)
  async function sendBolusToMyDiabby({
    token,
    bolus,
    date,
    time,
    isCorrection,
    carbs
  }: {
    token: string;
    bolus: string;
    date: string;
    time: string;
    isCorrection?: boolean;
    carbs?: string;
  }) {

    console.log(carbs);
    const url = "https://app.mydiabby.com/api/data";
    const body = new URLSearchParams({
      time,
      date,
      add: "true",
      dgnew: "false",
      ...(isCorrection
        ? { "insulin[bolus_corr]": bolus }
        : { "insulin[bolus]": bolus }),
      ...(carbs ? { "meal[carb]": carbs } : {})
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-locale": "fr",
      },
      credentials: "include",
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error("Erreur lors de l'envoi du bolus à MyDiabby");
    }
    return response.json();
  }

  // Fonction pour récupérer les bolus déjà présents sur MyDiabby
  async function fetchMyDiabbyBolus(token: string) {
    const url = "https://app.mydiabby.com/api/data";
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${token}`,
        "X-locale": "fr",
      },
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error("Erreur lors de la récupération des bolus MyDiabby");
    }
    const data = await response.json();
    // On ne garde que les bolus
    return (data.data?.glycemia || []).filter(
      (g: MyDiabbyGlycemiaEntry) => g.insulin && (g.insulin.bolus || g.insulin.bolus_corr)
    );
  }

  // Fonction de comparaison (bolus local <-> bolus MyDiabby)


  // Fonction pour récupérer les basals déjà présents sur MyDiabby
  async function fetchMyDiabbyBasal(token: string) {
    const url = "https://app.mydiabby.com/api/data";
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${token}`,
        "X-locale": "fr",
      },
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error("Erreur lors de la récupération des basals MyDiabby");
    }
    const data = await response.json();
    // On ne garde que les basals
    return (data.data?.glycemia || []).filter(
      (g: MyDiabbyGlycemiaEntry) => g.insulin && g.insulin.basal
    );
  }

  // Fonction de comparaison (basal local <-> basal MyDiabby)


  // Fonction pour récupérer les glycémies déjà présentes sur MyDiabby
  async function fetchMyDiabbyGlycemia(token: string) {
    const url = "https://app.mydiabby.com/api/data";
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${token}`,
        "X-locale": "fr",
      },
      credentials: "include",
    });
    if (!response.ok) {
      throw new Error("Erreur lors de la récupération des glycémies MyDiabby");
    }
    const data = await response.json();
    // On ne garde que les glycémies
    return (data.data?.glycemia || []).filter(
      (g: MyDiabbyGlycemiaEntry) => g.glycemia && g.glycemia.value
    );
  }

  // Fonction de comparaison (glycémie locale <-> glycémie MyDiabby)
  function isSameGlycemia(local: NightscoutEntry, remote: MyDiabbyGlycemiaEntry) {
    const { date: localDateStr, time: localTimeStr } = localDateTime(new Date(local.date).getTime());
    const localValue = (local.sgv / 100).toFixed(4);
    const remoteValue = remote.glycemia?.value ? Number(remote.glycemia.value) : NaN;
    return (
      remote.date === localDateStr &&
      remote.time === localTimeStr &&
      Math.abs(remoteValue - Number(localValue)) < 0.0001
    );
  }

  // Pool de concurrence : exécute `worker` sur chaque item avec au plus `limit` tâches simultanées
  async function runWithConcurrency<T>(
    items: T[],
    limit: number,
    worker: (item: T, index: number) => Promise<void>
  ) {
    let nextIndex = 0;
    const runWorker = async () => {
      while (nextIndex < items.length) {
        const current = nextIndex++;
        await worker(items[current], current);
      }
    };
    const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
    await Promise.all(workers);
  }

  // Fonction d'envoi d'un basal temporaire
  async function sendBasalToMyDiabby({
    token,
    basal,
    date,
    time
  }: {
    token: string;
    basal: string;
    date: string;
    time: string;
  }) {
    const url = "https://app.mydiabby.com/api/data";
    const body = new URLSearchParams({
      time,
      date,
      add: "true",
      dgnew: "false",
      "insulin[basal]": basal
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-locale": "fr",
      },
      credentials: "include",
      body: body.toString(),
    });
    if (!response.ok) {
      throw new Error("Erreur lors de l'envoi du basal temporaire à MyDiabby");
    }
    return response.json();
  }

  // Handler global pour l'envoi groupé
  // Concurrence mesurée : le serveur MyDiabby encaisse 20 POST simultanés sans erreur.
  const CONCURRENCY = 20;

  const handleSendAll = async () => {
    setStatus(null);
    setLoading(true);
    setProgress(0);
    setCancelRequested(false);
    cancelRef.current = false;
    setOpenSendModal(false);
    try {
      let totalSteps = 0;
      let doneSteps = 0;
      const bumpProgress = () => {
        doneSteps++;
        setProgress(Math.round((doneSteps / totalSteps) * 100));
      };

      // Récupère l'existant UNE seule fois (au lieu de 2x par type avant)
      const [mydiabbyGlycemiaList, mydiabbyBolusList, mydiabbyBasalList] =
        await Promise.all([
          sendGlycemia ? fetchMyDiabbyGlycemia(token) : Promise.resolve([] as MyDiabbyGlycemiaEntry[]),
          sendBolus ? fetchMyDiabbyBolus(token) : Promise.resolve([] as MyDiabbyGlycemiaEntry[]),
          sendBasal ? fetchMyDiabbyBasal(token) : Promise.resolve([] as MyDiabbyGlycemiaEntry[]),
        ]);

      // Pré-filtrage : ne garder que ce qui n'existe pas déjà côté MyDiabby
      const glycemiaToSend = sendGlycemia && data
        ? data.filter(
            (entry) => !mydiabbyGlycemiaList.some((remote: MyDiabbyGlycemiaEntry) => isSameGlycemia(entry, remote))
          )
        : [];
      // Trio : bolus manuels tels quels, SMB sommés par heure, basal délivrée par heure
      const sameAs = (item: AggItem, r: MyDiabbyGlycemiaEntry, field: "bolus" | "basal") => {
        const v = field === "basal" ? r.insulin?.basal : (r.insulin?.bolus ?? r.insulin?.bolus_corr);
        return r.date === item.date && r.time === item.time && Math.abs(Number(v) - item.units) < 0.001;
      };
      const manual = sendBolus && treatments ? manualBoluses(treatments) : { items: [], unmatchedCarbs: 0 };
      const smbHourly = sendBolus && treatments ? hourlySMB(treatments) : [];
      const bolusToSend = [...manual.items, ...smbHourly].filter(
        (item) => !mydiabbyBolusList.some((r: MyDiabbyGlycemiaEntry) => sameAs(item, r, "bolus"))
      );
      const basalToSend = (sendBasal && treatments ? hourlyBasal(treatments) : []).filter(
        (item) => !mydiabbyBasalList.some((r: MyDiabbyGlycemiaEntry) => sameAs(item, r, "basal"))
      );

      totalSteps = glycemiaToSend.length + bolusToSend.length + basalToSend.length;
      if (totalSteps === 0) {
        setStatus("Aucune donnée à envoyer (tout est déjà synchronisé).");
        setLoading(false);
        return;
      }

      // 1. Glycémies (dédupliquées, envoyées individuellement en concurrence — le batch multi-valeurs n'est pas supporté par l'API)
      if (glycemiaToSend.length > 0) {
        await runWithConcurrency(glycemiaToSend, CONCURRENCY, async (entry) => {
          if (cancelRef.current) throw new Error("Envoi interrompu par l'utilisateur.");
          const { date, time } = localDateTime(new Date(entry.date).getTime());
          const glycemia = (entry.sgv / 100).toFixed(4);
          await sendGlycemiaToMyDiabby({ token, glycemia, date, time });
          bumpProgress();
        });
      }

      // 2. Bolus (avec déduplication + concurrence)
      if (bolusToSend.length > 0) {
        await runWithConcurrency(bolusToSend, CONCURRENCY, async (item) => {
          if (cancelRef.current) throw new Error("Envoi interrompu par l'utilisateur.");
          await sendBolusToMyDiabby({
            token,
            bolus: item.units.toFixed(4),
            date: item.date,
            time: item.time,
            isCorrection: item.isCorrection,
            carbs: item.carbs !== undefined ? String(item.carbs) : undefined,
          });
          bumpProgress();
        });
      }

      // 3. Basals temporaires (avec déduplication + concurrence)
      if (basalToSend.length > 0) {
        await runWithConcurrency(basalToSend, CONCURRENCY, async (item) => {
          if (cancelRef.current) throw new Error("Envoi interrompu par l'utilisateur.");
          await sendBasalToMyDiabby({ token, basal: item.units.toFixed(4), date: item.date, time: item.time });
          bumpProgress();
        });
      }
      setStatus(
        "Envoi terminé !" +
          (manual.unmatchedCarbs > 0
            ? ` (${manual.unmatchedCarbs} saisie(s) de glucides sans bolus à ±30 min, non envoyée(s))`
            : "")
      );
      setCancelRequested(false);
      cancelRef.current = false;
    } catch (e: unknown) {
      setStatus(
        (e instanceof Error ? e.message : String(e))
      );
    }
    setLoading(false);
  };

  const handleStop = () => {
    setCancelRequested(true);
    cancelRef.current = true;
  };

  // NOTE (testé en réel août 2026) : l'import CSV Glooko de MyDiabby
  // (POST /api/upload-data/glooko) n'importe PAS les glycémies pures.
  // Il ne crée que les repas/insuline (lignes avec bolus). Le `nb` renvoyé
  // compte les lignes du fichier, pas les valeurs réellement importées.
  // → L'envoi des glycémies passe par l'API directe (pool de concurrence),
  // c'est la seule voie fiable. Le CSV Glooko a été retiré de l'UI.

  const handleLogout = () => {
    setToken("");
    setIsLoggedIn(false);
    localStorage.removeItem("mydiabbyToken");
    setStatus(null);
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Image src="/mydiabby.png" alt="MyDiabby" width={20} height={20} />
          {t('SendToMyDiabbyCard.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isDemo ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">
            {t('Demo.mydiabbyDisabled')}
          </p>
        ) : (
          <>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          {t('SendToMyDiabbyCard.description')}
        </p>
        {!isLoggedIn ? (
          <form onSubmit={loginToMyDiabby} className="space-y-3">
            <Input
              type="email"
              placeholder={t('SendToMyDiabbyCard.email')}
              value={email}
              onChange={e => setEmail(e.target.value)}
              required
              disabled={loading}
            />
            <Input
              type="password"
              placeholder={t('SendToMyDiabbyCard.password')}
              value={password}
              onChange={e => setPassword(e.target.value)}
              required
              disabled={loading}
            />
            <Button
              type="submit"
              className="w-full"
              disabled={loading}
            >
              {loading ? t('SendToMyDiabbyCard.connecting') : t('SendToMyDiabbyCard.login')}
            </Button>
          </form>
        ) : (
          <>
            <div className="flex justify-end items-center mb-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleLogout}
                className="text-teal-700 hover:text-teal-900 px-2 py-1"
                disabled={loading}
              >
                {t('SendToMyDiabbyCard.logout')}
              </Button>
            </div>
            {isLoggedIn && (
              <>
                {loading ? (
                  <Button
                    onClick={handleStop}
                    className="w-full bg-red-600 hover:bg-red-700"
                    disabled={cancelRequested}
                  >
                    {t('SendToMyDiabbyCard.stop')}
                  </Button>
                ) : (
                  <>
                    <Button
                      onClick={() => setOpenSendModal(true)}
                      className="w-full bg-teal-600 hover:bg-teal-700"
                      disabled={loading}
                    >
                      {t('SendToMyDiabbyCard.send')}
                    </Button>
                    <Dialog open={openSendModal} onOpenChange={setOpenSendModal}>
                      <DialogContent>
                        <DialogHeader>
                          <DialogTitle>{t('SendToMyDiabbyCard.modalTitle')}</DialogTitle>
                        </DialogHeader>
                        <div className="flex flex-col gap-2 py-2">
                          <label className="flex items-center gap-2">
                            <Checkbox checked={sendGlycemia} onCheckedChange={v => setSendGlycemia(!!v)} /> {t('SendToMyDiabbyCard.glycemiaLabel')}
                          </label>
                          <label className="flex items-center gap-2">
                            <Checkbox checked={sendBolus} onCheckedChange={v => setSendBolus(!!v)} /> {t('SendToMyDiabbyCard.bolusLabel')}
                          </label>
                          <label className="flex items-center gap-2">
                            <Checkbox checked={sendBasal} onCheckedChange={v => setSendBasal(!!v)} /> {t('SendToMyDiabbyCard.basalLabel')}
                          </label>
                        </div>
                        <DialogFooter>
                          <Button onClick={handleSendAll} className="w-full bg-teal-600 hover:bg-teal-700" disabled={loading}>
                            {t('SendToMyDiabbyCard.sendSelected')}
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                  </>
                )}
              </>
            )}
            {loading && (
              <>
                <div className="w-full bg-gray-200 rounded h-4 mb-2 mt-2 overflow-hidden">
                  <div
                    className="bg-teal-500 h-4 rounded"
                    style={{ width: `${progress}%`, transition: 'width 0.2s' }}
                  ></div>
                </div>
                <div className="text-sm text-teal-700 mb-2">
                  {t('SendToMyDiabbyCard.sending')}<br />
                  {progress}% ({Math.round((progress/100)*data.length)}/{data.length} {t('SendToMyDiabbyCard.sent_count')})
                </div>
              </>
            )}
          </>
        )}
        {status && <div className="mt-2 text-sm text-center">{status}</div>}
          </>
        )}
      </CardContent>
      <CardFooter />
    </Card>
  );
}