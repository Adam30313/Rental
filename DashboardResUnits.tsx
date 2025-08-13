import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, FileUp, Link as LinkIcon, Download, RefreshCw } from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  Legend,
} from "recharts";

// ------------------------------------------------------------
// Constantes (persistance locale)
// ------------------------------------------------------------
const STORAGE_KEY = "rf_dash_state_v1";

// ------------------------------------------------------------
// Utilitaires de détection & calcul
// ------------------------------------------------------------
const isDateLike = (v: any): v is Date => v instanceof Date && !isNaN(v.getTime());
const isNumeric = (v: any) => typeof v === "number" && isFinite(v);
const isBlank = (v: any) => v === null || v === undefined || v === "";

function detectColumnType(values: any[]): "date" | "number" | "string" {
  const sample = values.slice(0, 200).filter((v) => !isBlank(v));
  if (sample.length === 0) return "string";
  const dateRatio = sample.filter((v) => isDateLike(v) || (!isNaN(Date.parse(v)) && typeof v === "string" && v.length >= 6)).length / sample.length;
  if (dateRatio > 0.7) return "date";
  const numRatio = sample
    .filter((v) => {
      if (isNumeric(v)) return true;
      if (typeof v === "string") {
        const cleaned = v.replace(/[.,]/g, "");
        return cleaned.trim() !== "" && !Number.isNaN(Number(cleaned));
      }
      return false;
    }).length / sample.length;
  if (numRatio > 0.8) return "number";
  return "string";
}

function toDate(v: any): Date | null {
  if (isDateLike(v)) return new Date(v.getTime());
  if (typeof v === "number") {
    // Excel serial (jours depuis 1899-12-30)
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const ms = v * 24 * 3600 * 1000;
    const d = new Date(excelEpoch.getTime() + ms);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof v === "string") {
    // Essayer ISO/US
    const d1 = new Date(v);
    if (!isNaN(d1.getTime())) return d1;
    // Essayer format FR/EU dd/mm/yyyy (optionnel hh:mm)
    const m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?$/);
    if (m) {
      const dd = parseInt(m[1], 10);
      const mm = parseInt(m[2], 10) - 1;
      const yyyy = parseInt(m[3].length === 2 ? (Number(m[3]) + 2000).toString() : m[3], 10);
      const t = m[4] || "00:00:00";
      const d = new Date(`${yyyy}-${String(mm + 1).padStart(2, "0")}-${String(dd).padStart(2, "0") }T${t}`);
      return isNaN(d.getTime()) ? null : d;
    }
  }
  return null;
}

function fmt(n: number) {
  return new Intl.NumberFormat().format(n);
}

function toNumber(v: any): number {
  if (typeof v === "number" && isFinite(v)) return v;
  if (v === null || v === undefined) return 0;
  const s = String(v).trim();
  if (s === "") return 0;
  const cleaned = s.replace(/[^0-9.\-]/g, "");
  const num = parseFloat(cleaned);
  return isFinite(num) ? num : 0;
}

function valueCounts(values: any[], topN = 10) {
  const m = new Map<string, number>();
  for (const v of values) {
    if (isBlank(v)) continue;
    const key = String(v);
    m.set(key, (m.get(key) || 0) + 1);
  }
  const arr = Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, topN);
  return arr.map(([name, count]) => ({ name, count }));
}

function numericStats(values: any[]) {
  const nums = values
    .map((v) => (isNumeric(v) ? v : typeof v === "string" && !Number.isNaN(Number(v)) ? Number(v) : null))
    .filter((x) => x !== null) as number[];
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  const avg = sum / nums.length;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { count: nums.length, sum, avg, min, max };
}

function intersect<T>(a: T[], b: T[]) {
  const setB = new Set(b);
  return a.filter((x) => setB.has(x));
}

// ------------------------------------------------------------
// Détection de colonnes + utilitaires semaine
// ------------------------------------------------------------
function norm(s: string) { return s.toLowerCase().replace(/\s+/g, "").replace(/[^a-z0-9_]/g, ""); }
function findCol(cols: string[], names: string[], prefer: "any" | "date" | "number" = "any", sampleRows: any[] = []) {
  const ncols = cols.map((c) => ({ raw: c, n: norm(c) }));
  const preferNames = names.map(norm);
  for (const cand of preferNames) {
    const hit = ncols.find((c) => c.n.includes(cand));
    if (hit) return hit.raw;
  }
  if (prefer === "date") {
    for (const c of cols) {
      const vals = sampleRows.slice(0, 50).map((r) => r[c]);
      if (detectColumnType(vals) === "date") return c;
    }
  }
  if (prefer === "number") {
    for (const c of cols) {
      const vals = sampleRows.slice(0, 50).map((r) => r[c]);
      if (detectColumnType(vals) === "number") return c;
    }
  }
  return undefined;
}
function startOfISOWeek(d = new Date()) {
  const dt = new Date(d);
  const day = (dt.getDay() + 6) % 7; // Monday=0
  dt.setHours(0,0,0,0);
  dt.setDate(dt.getDate() - day);
  return dt;
}
const WEEK_LABELS = ["Lun","Mar","Mer","Jeu","Ven","Sam","Dim"];

function getWeekCounts(dates: Date[], monday: Date) {
  const counts = [0,0,0,0,0,0,0];
  for (const d of dates) {
    const di = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diff = Math.floor((+di - +monday)/(24*3600*1000));
    if (diff>=0 && diff<7) counts[diff]++;
  }
  return counts;
}

// ------------------------------------------------------------
// CSV helpers + tests rapides
// ------------------------------------------------------------
function csvCell(v: any): string {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}
let _csvTestsDone = false;
function runCsvTests() {
  if (_csvTestsDone) return; _csvTestsDone = true;
  const t = (name: string, cond: boolean) => { if (!cond) throw new Error("CSV test failed: " + name); };
  t("plain", csvCell("abc") === "abc");
  t("comma", csvCell("a,b") === '"a,b"');
  t("quote", csvCell('He said "Hi"') === '"He said ""Hi"""');
  t("newline", csvCell("a\nb") === '"a\nb"');
  t("week labels", WEEK_LABELS.length === 7);
}

// ------------------------------------------------------------
// Types
// ------------------------------------------------------------
interface Dataset {
  key: "ResManifest" | "UnitsAvailable" | "UnitsDueIn";
  display: string;
  file?: File | null;
  fileName?: string;
  workbook?: XLSX.WorkBook | null;
  sheetName?: string;
  sheetNames?: string[];
  rows: any[];
  columns: string[];
}

// ------------------------------------------------------------
// Composant d'import MULTI (une seule zone)
// ------------------------------------------------------------
function FilePickerMulti({ onFiles }: { onFiles: (files: File[]) => void }) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={`border-2 border-dashed rounded-2xl p-6 md:p-8 transition ${drag ? "border-primary bg-primary/5" : "border-muted"}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const list = Array.from(e.dataTransfer.files || []).filter((f) => /\.xls(x)?$/i.test(f.name));
        if (list.length) onFiles(list);
      }}
    >
      <div className="flex flex-col md:flex-row md:items-center gap-4">
        <div className="flex items-center gap-3">
          <FileUp className="w-6 h-6" />
          <div>
            <div className="font-semibold text-lg">Importer vos fichiers Excel</div>
            <div className="text-sm text-muted-foreground">Jusqu'à 3 fichiers: ResManifest, UnitsAvailable, UnitsDueIn. Un seul fichier suffit.</div>
          </div>
        </div>
        <div className="md:ml-auto">
          <Input
            type="file"
            multiple
            accept=".xlsx,.xls"
            className="w-full md:w-auto"
            onChange={(e) => {
              const list = Array.from(e.target.files || []);
              if (list.length) onFiles(list);
              (e.target as HTMLInputElement).value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
      {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

function DataPreviewTable({ rows, max = 50 }: { rows: any[]; max?: number }) {
  const columns = useMemo(() => (rows[0] ? Object.keys(rows[0]) : []), [rows]);
  const sliced = rows.slice(0, max);
  return (
    <div className="overflow-auto rounded-xl border">
      <table className="w-full text-sm">
        <thead className="bg-muted/50">
          <tr>
            {columns.map((c) => (
              <th key={c} className="text-left p-2 whitespace-nowrap font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sliced.map((r, i) => (
            <tr key={i} className="odd:bg-muted/10">
              {columns.map((c) => (
                <td key={c} className="p-2 whitespace-nowrap">
                  {String(r[c] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------
// App principale
// ------------------------------------------------------------
export default function DashboardResUnits() {
  const [datasets, setDatasets] = useState<Dataset[]>([
    { key: "ResManifest", display: "ResManifest (optionnel)", rows: [], columns: [] },
    { key: "UnitsAvailable", display: "UnitsAvailable (optionnel)", rows: [], columns: [] },
    { key: "UnitsDueIn", display: "UnitsDueIn (optionnel)", rows: [], columns: [] },
  ]);
  const [joinKey, setJoinKey] = useState<string | null>(null);
  const [selAvail, setSelAvail] = useState<{ placeType: string; loc: string; category: string } | null>(null);
  const [activeTab, setActiveTab] = useState<string>("general");

  // --- Persistance (charger au démarrage)
  useEffect(() => {
    try {
      runCsvTests();
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved?.datasets) setDatasets(saved.datasets);
      if (saved?.joinKey) setJoinKey(saved.joinKey);
      if (saved?.activeTab) setActiveTab(saved.activeTab);
    } catch { /* ignore */ }
  }, []);

  // --- Persistance (sauver)
  useEffect(() => {
    const state = { datasets, joinKey, activeTab };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }, [datasets, joinKey, activeTab]);

  const loaded = datasets.filter((d) => d.rows.length > 0);

  const commonColumns = useMemo(() => {
    if (loaded.length < 2) return [] as string[];
    const cols = loaded.map((d) => d.columns.map((c) => c.toLowerCase()));
    return cols.reduce((acc, cur) => intersect(acc, cur)) || [];
  }, [datasets]);

  const mergedRows = useMemo(() => {
    if (loaded.length === 0) return [] as any[];
    if (!joinKey || commonColumns.length === 0) return [] as any[];
    const [first, ...rest] = loaded;
    const idx = new Map<any, any>();
    for (const r of first.rows) {
      const k = r[joinKey] ?? r[joinKey.toLowerCase()] ?? r[joinKey.toUpperCase()];
      idx.set(String(k), { ...r });
    }
    for (const ds of rest) {
      for (const r of ds.rows) {
        const k = r[joinKey] ?? r[joinKey.toLowerCase()] ?? r[joinKey.toUpperCase()];
        const id = String(k);
        if (!idx.has(id)) idx.set(id, {});
        Object.assign(idx.get(id), r);
      }
    }
    return Array.from(idx.values());
  }, [datasets, joinKey, commonColumns]);

  async function readFileToDataset(file: File, index: number) {
    const ab = await file.arrayBuffer();
    const wb = XLSX.read(ab, { type: "array", cellDates: true, raw: false });
    const sheetName = wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null });
    const columns = rows[0] ? Object.keys(rows[0]) : [];

    setDatasets((prev) => {
      const next = [...prev];
      next[index] = {
        ...next[index],
        fileName: file.name,
        workbook: undefined, // éviter de stocker le workbook en mémoire locale
        sheetName,
        sheetNames: wb.SheetNames,
        rows,
        columns,
      } as Dataset;
      return next;
    });
  }

  function changeSheet(index: number, newSheet: string) {
    // (option avancée inactive ici pour simplicité)
  }

  function clearDataset(index: number) {
    const next = [...datasets];
    next[index] = { key: next[index].key as any, display: next[index].display, rows: [], columns: [] };
    setDatasets(next);
  }

  function autoDatasetIndex(name: string): number | null {
    const n = name.toLowerCase();
    if (n.includes("resmanifest")) return 0;
    if (n.includes("unitsavailable")) return 1;
    if (n.includes("unitsduein")) return 2;
    return 0; // défaut: ResManifest
  }

  function onFilesSelected(files: FileList | File[]) {
    const arr = Array.from(files as any as File[]);
    arr.forEach((f) => {
      const idx = autoDatasetIndex(f.name);
      readFileToDataset(f, idx ?? 0);
    });
  }

  // -------------- VUES -----------------
  const availView = useMemo(() => {
    const ds = datasets.find((d) => d.key === "UnitsAvailable");
    if (!ds || ds.rows.length === 0) return null;
    const cols = ds.columns; const rows = ds.rows;

    const colCMNO = findCol(cols, ["cmno"]);
    const colCMNC = findCol(cols, ["cmnc"]);
    const colCurrLoc = findCol(cols, ["curr loc","current loc","current location","currloc"]);
    const colOwnLoc = findCol(cols, ["own loc","ownloc"]);
    const colLoc = colCurrLoc || colOwnLoc || findCol(cols, ["loc","location"]);

    const colCategory = findCol(cols, ["category","categorie","carclass","group","car group","class","type","cartype"]);
    const colUnit = findCol(cols, ["unite","unit","unitid","unitnumber","unit#","id"]);
    const colPlate = findCol(cols, ["matricule","plaque","plate","registration","license"]);
    const colVehicle = findCol(cols, ["vehicule","vehicle","model","make","description","car"]);
    const colKM = findCol(cols, ["km","kilometrage","odometer","mileage","odo","kms"], "number", rows);
    const colFuel = findCol(cols, ["carburant","fuel","fuellevel","fuel level","niveau carburant","curr fuel"]);

    function getPlace(r: any): { placeType: string; loc: string } | null {
      const locAirport = colCMNO ? r[colCMNO] : undefined;
      const locCity = colCMNC ? r[colCMNC] : undefined;
      if (!isBlank(locAirport)) return { placeType: "Aéroport", loc: String(locAirport) };
      if (!isBlank(locCity)) return { placeType: "City", loc: String(locCity) };
      const anyLoc = colLoc ? r[colLoc] : undefined;
      if (!isBlank(anyLoc)) {
        const val = String(anyLoc);
        const up = val.toUpperCase();
        if (up.startsWith("CMNO")) return { placeType: "Aéroport", loc: val };
        if (up.startsWith("CMNC")) return { placeType: "City", loc: val };
      }
      return null;
    }

    const agg = new Map<string, { placeType: string; loc: string; category: string; count: number }>();
    for (const r of rows) {
      const place = getPlace(r);
      const cat = colCategory ? String(r[colCategory] ?? "") : "";
      if (!place || !place.loc || !cat) continue;
      const key = `${place.placeType}|${place.loc}|${cat}`;
      const cur = agg.get(key) || { placeType: place.placeType, loc: place.loc, category: cat, count: 0 };
      cur.count += 1; agg.set(key, cur);
    }
    const list = Array.from(agg.values()).sort((a,b)=> a.placeType.localeCompare(b.placeType) || a.loc.localeCompare(b.loc) || a.category.localeCompare(b.category));

    function detailsFor(sel: { placeType: string; loc: string; category: string }) {
      const mats: Record<string, Array<{unit:any;plate:any;vehicle:any;km:any;fuel:any}>> = {};
      for (const r of rows) {
        const place = getPlace(r);
        const cat = colCategory ? String(r[colCategory] ?? "") : "";
        if (!place || place.placeType !== sel.placeType || place.loc !== sel.loc || cat !== sel.category) continue;
        const unit = colUnit ? r[colUnit] : "";
        const plate = colPlate ? r[colPlate] : "";
        const vehicle = colVehicle ? r[colVehicle] : "";
        const km = colKM ? r[colKM] : "";
        const fuel = colFuel ? r[colFuel] : "";
        mats[place.loc] = mats[place.loc] || []; mats[place.loc].push({ unit, plate, vehicle, km, fuel });
      }
      return mats;
    }
    return { list, detailsFor };
  }, [datasets]);

  const dueInWeek = useMemo(() => {
    const ds = datasets.find((d) => d.key === "UnitsDueIn");
    if (!ds || ds.rows.length === 0) return null;
    const cols = ds.columns; const rows = ds.rows;
    const colDate = findCol(cols, ["expected return","expectedreturn","due","duein","return","retour","date"], "date", rows);
    if (!colDate) return { data: [], info: "Colonne date non détectée" };

    const allDates = rows.map((r) => toDate(r[colDate])).filter((d): d is Date => !!d);
    if (allDates.length === 0) return { data: [], info: "Aucune date valide" };

    const mondayNow = startOfISOWeek(new Date());
    let counts = getWeekCounts(allDates, mondayNow);
    let weekStart = mondayNow; let isCurrentWeek = true;

    if (counts.reduce((a,b)=>a+b,0) === 0) {
      // Fallback: semaine de la dernière date présente
      const maxD = allDates.reduce((a,b)=> a > b ? a : b);
      const m = startOfISOWeek(maxD);
      counts = getWeekCounts(allDates, m);
      weekStart = m; isCurrentWeek = false;
    }
    const data = counts.map((count,i)=>({day: WEEK_LABELS[i], count}));
    const rangeLabel = `${weekStart.toLocaleDateString()} → ${new Date(weekStart.getTime()+6*24*3600*1000).toLocaleDateString()}`;
    return { data, colUsed: colDate, parsedCount: allDates.length, isCurrentWeek, rangeLabel };
  }, [datasets]);

  const resWeekAndCats = useMemo(() => {
    const ds = datasets.find((d) => d.key === "ResManifest");
    if (!ds || ds.rows.length === 0) return null;
    const cols = ds.columns; const rows = ds.rows;
    const colDate = findCol(cols, ["pickup date","pickupdate","pickup","reservation","date","created"], "date", rows);
    const colCat = findCol(cols, ["requestedcategory","categoryrequested","categorie","category","carclass","class","group"]);
    const colPrice = findCol(cols, ["daily rate","price","prix","tarif","rate","amount","total"], "number", rows);

    const dates = (colDate ? rows.map((r)=>toDate(r[colDate])) : []).filter((d): d is Date => !!d);
    let monday = startOfISOWeek(new Date());
    let counts = getWeekCounts(dates, monday);
    let isCurrentWeek = true; let weekStart = monday;
    if (counts.reduce((a,b)=>a+b,0) === 0 && dates.length>0) {
      const maxD = dates.reduce((a,b)=> a>b?a:b);
      monday = startOfISOWeek(maxD);
      counts = getWeekCounts(dates, monday);
      isCurrentWeek = false; weekStart = monday;
    }
    const perDay = counts.map((count,i)=>({day: WEEK_LABELS[i], count}));

    const cats = new Map<string, { count: number; total: number }>();
    if (colCat) {
      for (const r of rows) {
        const cat = String(r[colCat] ?? ""); if (!cat) continue;
        const price = colPrice ? toNumber(r[colPrice]) : 0;
        const cur = cats.get(cat) || { count: 0, total: 0 }; cur.count += 1; cur.total += price; cats.set(cat, cur);
      }
    }
    const catRows = Array.from(cats.entries()).map(([category,v])=>({category,count:v.count,total:v.total,avg:v.count? v.total/v.count:0})).sort((a,b)=>b.count-a.count);
    const rangeLabel = dates.length ? `${weekStart.toLocaleDateString()} → ${new Date(weekStart.getTime()+6*24*3600*1000).toLocaleDateString()}` : "";
    return { perDay, catRows, meta: { colDate: colDate || "", colCat: colCat || "", colPrice: colPrice || "", parsedCount: dates.length, isCurrentWeek, rangeLabel } };
  }, [datasets]);

  const globalRowCount = loaded.reduce((acc, ds) => acc + ds.rows.length, 0);

  return (
    <div className="p-6 md:p-10 max-w-[1400px] mx-auto">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-semibold">Dashboard — Réservations & Unités</h1>
          <p className="text-muted-foreground">Importez 1, 2 ou 3 fichiers Excel (ResManifest, UnitsAvailable, UnitsDueIn). Le tableau de bord s’adapte automatiquement. Les données sont mémorisées localement.</p>
        </div>
        <div className="flex gap-2">
          {loaded.length > 0 && (
            <Badge variant="secondary" className="text-sm">{loaded.length} fichier(s) chargé(s)</Badge>
          )}
          <Button variant="outline" size="sm" className="gap-2" onClick={() => {
            setDatasets([
              { key: "ResManifest", display: "ResManifest (optionnel)", rows: [], columns: [] },
              { key: "UnitsAvailable", display: "UnitsAvailable (optionnel)", rows: [], columns: [] },
              { key: "UnitsDueIn", display: "UnitsDueIn (optionnel)", rows: [], columns: [] },
            ]); localStorage.removeItem(STORAGE_KEY); setJoinKey(null); setSelAvail(null); setActiveTab("general");
          }}>
            <RefreshCw className="w-4 h-4"/> Réinitialiser
          </Button>
        </div>
      </div>

      {/* Zone d’import */}
      <Card className="mb-8">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><FileUp className="w-5 h-5"/> Import des fichiers</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FilePickerMulti onFiles={onFilesSelected as any} />
          {loaded.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {datasets.map((ds) => (
                ds.rows.length > 0 && (
                  <Badge key={ds.key} variant="secondary" className="px-3 py-1">
                    {ds.key}: <span className="ml-1 opacity-80">{ds.fileName}</span>
                  </Badge>
                )
              ))}
            </div>
          )}
          <div className="text-xs text-muted-foreground">Astuce: détection par nom de fichier (« ResManifest*.xlsx », « UnitsAvailable*.xlsx », « UnitsDueIn*.xlsx »). Les données sont sauvegardées dans votre navigateur (localStorage).</div>
        </CardContent>
      </Card>

      {/* NAVIGATION */}
      <Tabs value={activeTab} onValueChange={(v)=>setActiveTab(v)} className="mb-10">
        <TabsList className="flex flex-wrap gap-2">
          <TabsTrigger value="general">Général</TabsTrigger>
          {datasets.find((d) => d.key === "ResManifest" && d.rows.length > 0) && (
            <TabsTrigger value="ResManifest">ResManifest</TabsTrigger>
          )}
          {datasets.find((d) => d.key === "UnitsAvailable" && d.rows.length > 0) && (
            <TabsTrigger value="UnitsAvailable">UnitsAvailable</TabsTrigger>
          )}
          {datasets.find((d) => d.key === "UnitsDueIn" && d.rows.length > 0) && (
            <TabsTrigger value="UnitsDueIn">UnitsDueIn</TabsTrigger>
          )}
          {loaded.length >= 2 && <TabsTrigger value="fusion">Fusion</TabsTrigger>}
        </TabsList>

        {/* Général */}
        <TabsContent value="general">
          <div className="grid md:grid-cols-3 gap-4 mb-8">
            <Card>
              <CardHeader><CardTitle className="text-base">Fichiers chargés</CardTitle></CardHeader>
              <CardContent>
                <div className="text-3xl font-semibold">{loaded.length}</div>
                <div className="text-sm text-muted-foreground">0 à 3 — fonctionne même avec un seul</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Total lignes</CardTitle></CardHeader>
              <CardContent>
                <div className="text-3xl font-semibold">{fmt(globalRowCount)}</div>
                <div className="text-sm text-muted-foreground">Somme de toutes les lignes importées</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Colonnes communes</CardTitle></CardHeader>
              <CardContent>
                {loaded.length >= 2 ? (
                  commonColumns.length > 0 ? (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <Label className="text-xs">Clé de jointure</Label>
                        <Select value={joinKey ?? undefined} onValueChange={(v) => setJoinKey(v)}>
                          <SelectTrigger className="h-8 w-[220px]">
                            <SelectValue placeholder="Choisir une colonne" />
                          </SelectTrigger>
                          <SelectContent>
                            {commonColumns.map((c) => (
                              <SelectItem key={c} value={c}>{c}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {joinKey && (
                        <div className="text-sm text-muted-foreground">Jointure potentielle sur <strong className="text-foreground">{joinKey}</strong>. Consultez l’onglet « Fusion ».</div>
                      )}
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground flex items-center gap-2"><AlertCircle className="w-4 h-4"/>Aucune colonne commune détectée.</div>
                  )
                ) : (
                  <div className="text-sm text-muted-foreground">Importez au moins 2 fichiers pour détecter des colonnes communes.</div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ResManifest */}
        <TabsContent value="ResManifest" className="space-y-6 pt-4">
          {!resWeekAndCats ? (
            <Card><CardContent className="p-6 text-sm text-muted-foreground">Aucun fichier ResManifest chargé.</CardContent></Card>
          ) : (
            <>
              <Card>
                <CardHeader><CardTitle className="text-base">Réservations par jour ({resWeekAndCats.meta.isCurrentWeek ? "semaine en cours" : "semaine la plus récente avec données"})</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer>
                      <LineChart data={resWeekAndCats.perDay}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="day" />
                        <YAxis allowDecimals={false} />
                        <Tooltip />
                        <Legend />
                        <Line type="monotone" dataKey="count" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="text-xs text-muted-foreground mt-2">Colonne date: <strong className="text-foreground">{resWeekAndCats.meta.colDate || '—'}</strong> — {fmt(resWeekAndCats.meta.parsedCount)} dates lues. Semaine: {resWeekAndCats.meta.rangeLabel}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-base">Catégories demandées & prix</CardTitle></CardHeader>
                <CardContent>
                  {resWeekAndCats.meta.colCat ? (
                    <div className="overflow-auto rounded-xl border">
                      <table className="w-full text-sm">
                        <thead className="bg-muted/50">
                          <tr>
                            <th className="text-left p-2">Catégorie</th>
                            <th className="text-right p-2">Nb</th>
                            <th className="text-right p-2">Total</th>
                            <th className="text-right p-2">Moyenne</th>
                          </tr>
                        </thead>
                        <tbody>
                          {resWeekAndCats.catRows.map((r, i) => (
                            <tr key={i} className="odd:bg-muted/10">
                              <td className="p-2">{r.category}</td>
                              <td className="p-2 text-right">{fmt(r.count)}</td>
                              <td className="p-2 text-right">{fmt(Math.round(r.total))}</td>
                              <td className="p-2 text-right">{fmt(Math.round(r.avg))}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="text-xs text-muted-foreground mt-2">Colonnes — Catégorie: <strong className="text-foreground">{resWeekAndCats.meta.colCat || '—'}</strong>{resWeekAndCats.meta.colPrice ? (<span>, Prix: <strong className="text-foreground">{resWeekAndCats.meta.colPrice}</strong></span>) : null}</div>
                    </div>
                  ) : (
                    <div className="text-sm text-muted-foreground">Impossible de détecter la colonne Catégorie dans ResManifest. Donne-moi le nom exact et je l’ajoute.</div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* UnitsAvailable */}
        <TabsContent value="UnitsAvailable" className="space-y-6 pt-4">
          {!availView ? (
            <Card><CardContent className="p-6 text-sm text-muted-foreground">Aucun fichier UnitsAvailable chargé.</CardContent></Card>
          ) : (
            <>
              <Card>
                <CardHeader><CardTitle className="text-base">Catégories par emplacement</CardTitle></CardHeader>
                <CardContent>
                  <div className="overflow-auto rounded-xl border">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/50">
                        <tr>
                          <th className="text-left p-2">Type</th>
                          <th className="text-left p-2">Emplacement</th>
                          <th className="text-left p-2">Catégorie</th>
                          <th className="text-right p-2">Nombre</th>
                        </tr>
                      </thead>
                      <tbody>
                        {availView.list.map((row, i) => (
                          <tr key={i} className="odd:bg-muted/10">
                            <td className="p-2 whitespace-nowrap">{row.placeType}</td>
                            <td className="p-2 whitespace-nowrap">{row.loc}</td>
                            <td className="p-2 whitespace-nowrap">
                              <button className="underline" onClick={() => setSelAvail(row)} title="Voir le détail par unités">{row.category}</button>
                            </td>
                            <td className="p-2 text-right">{fmt(row.count)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {selAvail && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Détail — {selAvail.category} ({selAvail.placeType} · {selAvail.loc})</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {(() => {
                      const mats = availView.detailsFor(selAvail);
                      const locs = Object.keys(mats).sort();
                      if (locs.length === 0) return <div className="text-sm text-muted-foreground">Aucune unité trouvée.</div>;
                      return (
                        <div className="space-y-6">
                          {locs.map((loc) => (
                            <div key={loc}>
                              <div className="text-sm font-medium mb-2">Emplacement: {loc}</div>
                              <div className="overflow-auto rounded-xl border">
                                <table className="w-full text-sm">
                                  <thead className="bg-muted/50">
                                    <tr>
                                      <th className="text-left p-2">Unité</th>
                                      <th className="text-left p-2">Matricule</th>
                                      <th className="text-left p-2">Véhicule</th>
                                      <th className="text-right p-2">KM</th>
                                      <th className="text-right p-2">Carburant</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {mats[loc].map((u, idx) => (
                                      <tr key={idx} className="odd:bg-muted/10">
                                        <td className="p-2">{String(u.unit ?? "")}</td>
                                        <td className="p-2">{String(u.plate ?? "")}</td>
                                        <td className="p-2">{String(u.vehicle ?? "")}</td>
                                        <td className="p-2 text-right">{String(u.km ?? "")}</td>
                                        <td className="p-2 text-right">{String(u.fuel ?? "")}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </TabsContent>

        {/* UnitsDueIn */}
        <TabsContent value="UnitsDueIn" className="space-y-6 pt-4">
          {!dueInWeek ? (
            <Card><CardContent className="p-6 text-sm text-muted-foreground">Aucun fichier UnitsDueIn chargé.</CardContent></Card>
          ) : dueInWeek.info ? (
            <Card><CardContent className="p-6 text-sm text-muted-foreground">{dueInWeek.info}</CardContent></Card>
          ) : (
            <>
              <Card>
                <CardHeader><CardTitle className="text-base">Retours par jour ({dueInWeek.isCurrentWeek ? "semaine en cours" : "semaine la plus récente avec données"})</CardTitle></CardHeader>
                <CardContent>
                  <div className="h-64">
                    <ResponsiveContainer>
                      <BarChart data={dueInWeek.data}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="day" />
                        <YAxis allowDecimals={false} />
                        <Tooltip />
                        <Bar dataKey="count" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="text-xs text-muted-foreground mt-2">Colonne: <strong className="text-foreground">{dueInWeek.colUsed}</strong> — {fmt(dueInWeek.parsedCount)} dates lues. Semaine: {dueInWeek.rangeLabel}</div>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        {/* Fusion */}
        <TabsContent value="fusion">
          <Card className="mb-8">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><LinkIcon className="w-5 h-5"/> Fusion des données</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {loaded.length < 2 ? (
                <div className="text-sm text-muted-foreground">Importez au moins 2 fichiers pour fusionner.</div>
              ) : commonColumns.length === 0 ? (
                <div className="text-sm text-muted-foreground flex items-center gap-2"><AlertCircle className="w-4 h-4"/>Aucune colonne commune détectée.</div>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <Label className="text-xs">Clé de jointure</Label>
                    <Select value={joinKey ?? undefined} onValueChange={(v) => setJoinKey(v)}>
                      <SelectTrigger className="h-8 w-[220px]">
                        <SelectValue placeholder="Choisir une colonne" />
                      </SelectTrigger>
                      <SelectContent>
                        {commonColumns.map((c) => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="ml-auto">
                      <Button
                        variant="secondary"
                        disabled={!joinKey || mergedRows.length === 0}
                        onClick={() => {
                          const cols = mergedRows[0] ? Object.keys(mergedRows[0]) : [];
                          const csv = [cols.join(",")]
                            .concat(
                              mergedRows.map((r) => cols.map((c) => csvCell(r[c])).join(","))
                            )
                            .join("\n");
                          const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `merge_${joinKey}.csv`;
                          a.click();
                          URL.revokeObjectURL(url);
                        }}
                        className="flex items-center gap-2"
                      >
                        <Download className="w-4 h-4"/> Export CSV
                      </Button>
                    </div>
                  </div>

                  <div className="grid md:grid-cols-3 gap-4 mt-2">
                    <Stat label="Lignes fusionnées (approx.)" value={fmt(mergedRows.length)} />
                    <Stat label="Colonnes totales" value={fmt(mergedRows[0] ? Object.keys(mergedRows[0]).length : 0)} />
                    <div />
                  </div>

                  <div>
                    <div className="text-sm font-medium mb-2">Aperçu (max 100 lignes)</div>
                    <DataPreviewTable rows={mergedRows.slice(0, 100)} />
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <div className="text-center text-xs text-muted-foreground pb-10">
        Conçu pour fonctionner entièrement côté navigateur. Données mémorisées localement (aucune remontée serveur).
      </div>
    </div>
  );
}

