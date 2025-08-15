// script.js (module ESM)

// 1) Import date-fns en ESM depuis CDN
import {
  parse as dfParse,
  format as dfFormat,
  differenceInDays as dfDiff,
  startOfDay as dfStart,
  isSameDay as dfSame
} from 'https://cdn.jsdelivr.net/npm/date-fns@2.29.3/esm/index.js';

// 2) API homogène
const DF = {
  dateParse: (s, fmt, ref = new Date()) => dfParse(s, fmt, ref),
  dateFormat: (d, fmt) =>
    (d instanceof Date && !isNaN(d.getTime()) ? dfFormat(d, fmt) : ''),
  differenceInDays: dfDiff,
  startOfDay: dfStart,
  isSameDay: dfSame,
};

// ================== Données & constantes ==================
const STORAGE_KEY = 'rf_site_state_v5';

// ====== Hiérarchie de classes + contrainte transmission ======
// MISE À JOUR demandée : mdmr<mdar<edmr<edar<cdmr<cdar<idmr<idar<sdah<cfmr<cfar<ifmr<ifar<ifah
const CLASS_CHAIN = ['mdmr','mdar','edmr','edar','cdmr','cdar','idmr','idar','sdah','cfmr','cfar','ifmr','ifar','ifah'];
const CLASS_RANK = Object.fromEntries(CLASS_CHAIN.map((c,i)=>[c,i]));

// --- Helpers d'unité
const ONE_HOUR = 3600 * 1000;
const cleanUnit = (u) => String(u || '').replace(/\s*\(retour\)$/i,'').trim();

let reservationAssignmentsMeta = {}; // { [resNumber]: { source:'available'|'return'|'manual', returnDate:Date|null, upgrade:boolean } }

function normClass(cls){ return String(cls||'').trim().toLowerCase(); }
// 3e lettre = 'a' → AUTO ; sinon MANUEL (ex: mdmr=m, mdar=a, sdah=a, ifah=a)
function isAuto(cls){ return normClass(cls)[2] === 'a'; }

// r = classe demandée, u = classe du véhicule
function canSatisfy(reqCls, unitCls){
  const r = normClass(reqCls), u = normClass(unitCls);
  // Transmission : AUTO demandée => unité doit être AUTO ; MANUEL demandée => MANUEL ou AUTO ok
  if (isAuto(r) && !isAuto(u)) return false;
  // Classe : même rang ou supérieur (upgrade)
  if (!(r in CLASS_RANK) || !(u in CLASS_RANK)) return r === u; // fallback strict si inconnue
  return CLASS_RANK[u] >= CLASS_RANK[r];
}

// ordre d’essai : exact puis upgrades croissantes
function bestUpgradeOrder(reqCls){
  const r = CLASS_RANK[normClass(reqCls)];
  if (r == null) return [normClass(reqCls)];
  return CLASS_CHAIN.slice(r);
}

// ================== Sélecteurs DOM ==================
const fileInput = document.getElementById('fileInput');
const resetButton = document.getElementById('resetButton');
const loadingDiv = document.getElementById('loading');
const errorDiv = document.getElementById('error');
const errorMessageSpan = document.getElementById('errorMessage');
const detailModal = document.getElementById('detailModal');
const detailTitle = document.getElementById('detailTitle');
const detailBody = document.getElementById('detailBody');
const detailClose = document.getElementById('detailClose');

let charts = {};
let processedReservations = [], processedDueIn = [], processedAvailable = [];
let reservationAssignments = {};

// ================== Utils ==================
function makeCheckedDate(y, m, d, hh=0, mi=0, ss=0){
  if (!(m>=1 && m<=12) || !(d>=1 && d<=31)) return null;
  const dt = new Date(y, m-1, d, hh, mi, ss);
  if (dt.getFullYear() !== y || dt.getMonth() !== m-1 || dt.getDate() !== d) return null;
  return dt;
}

function destroyCharts() { Object.values(charts).forEach(c => { try { c && c.destroy && c.destroy(); } catch(_){} }); charts = {}; }
function headersOf(objArr){ if(!objArr || !objArr[0]) return []; return Object.keys(objArr[0]).map(h => String(h)); }
function normHeader(h){ return String(h || '').replace(/[\u00A0]/g,' ').replace(/\s+/g,' ').trim(); }
// Remplace TOUTE la fonction getField par ceci :
function getField(row, aliases){
  for (const a of aliases){
    const k1 = normHeader(a);          // ex: "Kms" -> "Kms", "Unit  # " -> "Unit #"
    if (row[k1] != null && row[k1] !== '') return row[k1];

    const k2 = k1.toLowerCase();       // doublon en minuscules si dispo
    if (row[k2] != null && row[k2] !== '') return row[k2];

    // Fallback: recherche fuzzy sur les clés existantes (utile pour "Kms", "KM(s)", etc.)
    const tryRe = /^(km|kms|km\(s\)|kilom(é|e)trage|od(o|omet(er)?)|mileage)$/i;
    for (const key of Object.keys(row)){
      if (tryRe.test(normHeader(key))) {
        const val = row[key];
        if (val != null && val !== '') return val;
      }
    }
  }
  return undefined;
}


// ================== Parsing Excel ==================
async function parseExcelFile(file) {
  if (!file) return null;
  const fileName = file.name.toLowerCase();
  if (!fileName.endsWith('.xlsx')) throw new Error(`Format de fichier non supporté: ${file.name}. Veuillez utiliser .xlsx`);
  const arrayBuffer = await file.arrayBuffer();
  const workbook = XLSX.read(arrayBuffer, { cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  const asObjectsRaw = XLSX.utils.sheet_to_json(worksheet, { raw: false });
  const asArrays = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false });
  const asObjects = asObjectsRaw.map(row => {
    const out = {};
    Object.keys(row).forEach(k => {
      const nk = normHeader(k);      // clé normalisée (trim + espaces compressés + NBSP -> espace)
      const v  = row[k];
      out[nk] = v;                   // ex: "Kms"
      out[nk.toLowerCase()] = v;     // ex: "kms"  (doublon pour lecture tolérante à la casse)
    });
    return out;
  });
  return { asArrays, asObjects };
}

function detectFileType(data) {
  if (!data || data.length === 0) return 'unknown';
  const headers = headersOf(data).map(normHeader);
  const set = new Set(headers);
  const has = (h) => set.has(normHeader(h));
  const hasAny = (arr) => arr.some(h => has(h));
  const dueCols = ['Expected Return','Expected Return Date','Return Date','Due','Due In'];

  if (has('Res #') && (has('Pickup Date') || has('Pick Up Date'))) return 'reservations';

  // dispo : assoupli pour inclure plaque/odo/fuel
  if (
    (has('Curr Loc') || has('Current Location') || has('Location')) &&
    (has('Vin #') || has('Vin') || has('Unit #') || has('Unit') || has('Plate') || has('Registration'))
  ) return 'available';

  if (hasAny(dueCols) && (has('Unit #') || has('Name') || has('Client'))) return 'dueIn';

  return 'unknown';
}

function parseRobustDate(dateValue) {
  if (dateValue == null || dateValue === '') return null;
  if (typeof dateValue === 'number' && isFinite(dateValue)) {
    const jsDate = new Date(Math.round((dateValue - 25569) * 864e5));
    if (!isNaN(jsDate.getTime())) return jsDate;
  }
  if (dateValue instanceof Date) { return isNaN(dateValue.getTime()) ? null : new Date(dateValue.getTime()); }
  if (typeof dateValue === 'string') {
    const s = dateValue.replace(/[\u00A0]/g,' ').trim();
    let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*(AM|PM|am|pm))?)?$/);
    if (m) {
      let p1 = parseInt(m[1],10), p2 = parseInt(m[2],10), y = parseInt(m[3],10);
      let hh = parseInt(m[4]||'0',10), mm = parseInt(m[5]||'0',10), ss = parseInt(m[6]||'0',10);
      const ap = (m[7]||'').toLowerCase();
      let day, month;
      if (p1>12) { day=p1; month=p2; }
      else if (p2>12) { day=p2; month=p1; }
      else { day=p1; month=p2; }
      if (ap==='pm' && hh<12) hh+=12; if (ap==='am' && hh===12) hh=0;
      const d = makeCheckedDate(y, month, day, hh, mm, ss);
      if (d) return d;
    }
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (m) {
      const y = parseInt(m[1],10), mo = parseInt(m[2],10), da = parseInt(m[3],10);
      const hh = parseInt(m[4]||'0',10), mi = parseInt(m[5]||'0',10), ss = parseInt(m[6]||'0',10);
      const d = makeCheckedDate(y, mo, da, hh, mi, ss);
      if (d) return d;
    }
    m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m){
      const a = parseInt(m[1],10), b = parseInt(m[2],10), y = parseInt(m[3],10);
      let day, month; if (a>12) { day=a; month=b; } else if (b>12) { day=b; month=a; } else { day=a; month=b; }
      const d = makeCheckedDate(y, month, day);
      if (d) return d;
    }
    try {
      const formats = [
        'dd/MM/yyyy HH:mm:ss','dd/MM/yyyy HH:mm','dd/MM/yyyy hh:mm a','dd/MM/yyyy',
        'MM/dd/yyyy HH:mm:ss','MM/dd/yyyy HH:mm','MM/dd/yyyy hh:mm a','MM/dd/yyyy',
        'yyyy-MM-dd HH:mm:ss','yyyy-MM-dd'
      ];
      for (const f of formats) {
        const d = DF.dateParse(s, f, new Date());
        if (d instanceof Date && !isNaN(d.getTime())) return d;
      }
    } catch(_){}
    const iso = new Date(s); if (!isNaN(iso.getTime())) return iso;
  }
  return null;
}

function updateStatusIndicator(type, ok) {
  const id = 'status' + type.charAt(0).toUpperCase() + type.slice(1);
  const el = document.getElementById(id); if (!el) return;
  if (ok) { if(!el.innerText.includes('✅')) el.innerText += ' ✅'; el.classList.remove('text-gray-400'); el.classList.add('text-green-600','font-semibold'); }
}

function saveState(){
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        r: processedReservations,
        d: processedDueIn,
        a: processedAvailable,
        asg: reservationAssignments,
        asgMeta: reservationAssignmentsMeta
      })
    );
  } catch(_){}
}

function loadState(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY); if(!raw) return;
    const s = JSON.parse(raw);
    processedReservations = Array.isArray(s?.r)? s.r : [];
    processedDueIn       = Array.isArray(s?.d)? s.d : [];
    processedAvailable   = Array.isArray(s?.a)? s.a : [];
    reservationAssignments = Object.fromEntries(
      Object.entries(s?.asg || {}).map(([k,v]) => [k, v==='none' ? 'none' : cleanUnit(v)])
    );
    reservationAssignmentsMeta = s?.asgMeta || {};
    if (processedReservations.length) updateStatusIndicator('reservations', true);
    if (processedDueIn.length)       updateStatusIndicator('dueIn', true);
    if (processedAvailable.length)   updateStatusIndicator('available', true);
  } catch(_){}
}

// --- Localisation helpers (CMN -> Casablanca, O=Aéroport, C=City) ---
function mapLocFromCode(code){
  if (!code) return null;
  const s = String(code).trim().toUpperCase();
  const letters = (s.match(/^[A-Z]+/)||[''])[0];
  if (!letters) return null;
  const siteLetter = letters.slice(-1);
  const prefix3 = letters.slice(0,3);
  let city = prefix3 === 'CMN' ? 'Casablanca' : prefix3;
  let site = siteLetter === 'O' ? 'Aéroport' : (siteLetter === 'C' ? 'City' : '');
  if (!city && !site) return null;
  return site ? `${city} - ${site}` : city;
}
function normalizeLoc(raw){
  if (!raw) return null;
  const s = String(raw).trim();
  const fromCode = mapLocFromCode(s);
  return fromCode || s;
}

// ================== Upload & traitement ==================
async function handleFileUpload(event) {
  const files = event.target.files; if (!files || files.length === 0) return;
  loadingDiv.classList.remove('hidden'); errorDiv.classList.add('hidden');
  for (const file of files) {
    try {
      const { asArrays, asObjects } = await parseExcelFile(file);
      if (!asObjects || asObjects.length < 1) { console.warn(`Le fichier ${file.name} est vide.`); continue; }
      const type = detectFileType(asObjects);

      if (type === 'reservations') {
        processedReservations = asObjects.map(r => ({
          resNumber: getField(r, ['Res #','RES #']),
          name: getField(r, ['Name','Client','Customer']),
          class: getField(r, ['Class','Categorie','Category','Car Class']),
          pickupDate: parseRobustDate(getField(r, ['Pickup Date','Pick Up Date'])),
          dropOffDate: parseRobustDate(getField(r, ['Drop Off Date','Return Date'])),
          dailyRate: getField(r, ['Daily Rate','Rate','Prix'])
        })).filter(r => r.name && r.pickupDate);
        updateStatusIndicator('reservations', true);

      } else if (type === 'available') {
        // On récupère aussi KM, Carburant, Matricule (plate)
        const unitAliases  = ['Unit #','Unit#','Unit','VIN','Vin #','Vin'];
        const classAliases = ['Class','Categorie','Category','Car Class'];
        const fuelAliases  = ['Curr Fuel','Current Fuel','Fuel','Fuel Level'];
        // élargi pour capter + de libellés réels
        const odoAliases   = [
          'Odometer','Current Odometer','Curr Odometer','Current Odo','Curr Odo','Cur Odo','Odo',
          'KM','Km','KMS','kms','Kms','Kilométrage','Kilometrage','Mileage',
        ];

        const plateAliases = ['Plate','Registration','Matricule','License','Immatriculation'];


        processedAvailable = asObjects.map(r => ({
          unitNumber: getField(r, unitAliases),
          class: getField(r, classAliases),
          currentFuel: getField(r, fuelAliases),
          currentOdo: (() => {
            // 1) essai par alias exacts
            let raw = getField(r, odoAliases);

            // 2) fallback fuzzy si rien trouvé: on tente des clés qui "ressemblent"
            if (raw == null || raw === '') {
              const tryRe = /^(km|kms|km\(s\)|kilom(é|e)trage|od(o|omet(er)?)|mileage)$/i;
              for (const k of Object.keys(r)) {
                if (tryRe.test(String(k))) { raw = r[k]; break; }
              }
            }

            if (raw == null || raw === '') return null;

            // Nettoyage nombres: supprime espaces, séparateurs, lettres
            const n = Number(String(raw).replace(/[^\d.,-]/g,'').replace(/,/g,'.'));
            return isFinite(n) ? n : null;
          })(),

          plate: getField(r, plateAliases)
        })).filter(r => r.unitNumber);
        updateStatusIndicator('available', true);

      } else if (type === 'dueIn') {
        const unitAliases = ['Unit #','Unit#','Unit','VIN','Vin #','Vin','__EMPTY','__EMPTY_1','Unnamed: 0'];
        const dateAliases = ['Expected Return','Expected Return Date','Return Date','Due','Due In'];
        const nameAliases = ['Name','Client'];
        const classAliases = ['Class','Categorie','Category','Car Class'];
        const locAliases = ['Current Location','Current Location ','Curr Loc','Location'];

        const clean = asObjects.filter(r => (getField(r, unitAliases) || getField(r, nameAliases)) && (getField(r, dateAliases) != null));

        processedDueIn = clean.map(r => ({
          unitNumber: getField(r, unitAliases),
          model: getField(r, ['Model','Vehicle','Vehicule']),
          class: getField(r, classAliases),
          daysLate: parseInt(getField(r, ['Days Late','Days Out']) || '0', 10) || 0,
          name: getField(r, nameAliases),
          location: normalizeLoc(getField(r, locAliases) || getField(r, unitAliases)),
          expectedReturn: parseRobustDate(getField(r, dateAliases))
        }));
        updateStatusIndicator('dueIn', true);

      } else {
        console.warn(`Type de fichier non reconnu: ${file.name}`);
      }
    } catch (err) {
      console.error(`Erreur: ${file.name}`, err);
      errorMessageSpan.textContent = `Erreur avec ${file.name}: ${err && err.message ? err.message : err}`;
      errorDiv.classList.remove('hidden');
    }
  }
  loadingDiv.classList.add('hidden'); fileInput.value = '';
  updateDashboard(); saveState();
}

// ====== Aide: infos unité à partir des buffers ======
function classOfUnit(unit){
  const u = cleanUnit(unit);
  const a = processedAvailable.find(v => String(v.unitNumber)===u);
  if (a) return normClass(a.class);
  const d = processedDueIn.find(v => String(v.unitNumber)===u);
  return d ? normClass(d.class) : null;
}

// Retour éligible (>= 1h avant le pickup) le plus proche avant la résa
function findEligibleReturn(unit, pickupDate){
  const u = cleanUnit(unit);
  const list = processedDueIn
      .filter(v => String(v.unitNumber)===u && v.expectedReturn && (pickupDate - v.expectedReturn) >= ONE_HOUR)
      .sort((a,b)=> b.expectedReturn - a.expectedReturn);
  return list[0] || null;
}

// ====== Sélection manuelle ======
function handleAssignmentChange(e){
  const resNumber = e.target.dataset.resNumber;
  const newUnit = e.target.value;

  if (newUnit === 'none') {
    reservationAssignments[resNumber] = 'none';
    reservationAssignmentsMeta[resNumber] = { source:'manual', returnDate:null, upgrade:false };
    updateDashboard(); saveState();
    return;
  }

  // Déduire source & upgrade
  const unit = String(newUnit);
  const res = processedReservations.find(r => r.resNumber === resNumber);
  const reqCls = res ? normClass(res.class) : null;

  // Source: available par défaut, sinon 'return' si retour valable (≥1h avant pickup)
  let source = 'available';
  let returnDate = null;
  if (res && res.pickupDate){
    const r = processedDueIn
      .filter(v => String(v.unitNumber)===unit && v.expectedReturn && (res.pickupDate - v.expectedReturn) >= 3600*1000)
      .sort((a,b)=> b.expectedReturn - a.expectedReturn)[0];
    if (r){ source = 'return'; returnDate = r.expectedReturn; }
  }

  // Upgrade ?
  const unitCls = (() => {
    const inAvail = processedAvailable.find(v => String(v.unitNumber)===unit);
    if (inAvail) return normClass(inAvail.class);
    const inRet = processedDueIn.find(v => String(v.unitNumber)===unit);
    return inRet ? normClass(inRet.class) : null;
  })();

  const upgrade = (reqCls && unitCls && (CLASS_RANK[unitCls] ?? -1) > (CLASS_RANK[reqCls] ?? -1)) || false;

  reservationAssignments[resNumber] = unit;
  reservationAssignmentsMeta[resNumber] = { source, returnDate, upgrade };

  updateDashboard(); saveState();
}

function resetAll(){
  processedReservations = []; processedDueIn = []; processedAvailable = []; reservationAssignments = {};
  document.querySelectorAll('.status-indicator').forEach(el => {
    el.classList.remove('text-green-600','font-semibold');
    el.classList.add('text-gray-400');
    el.innerText = el.innerText.replace(' ✅','');
  });
  fileInput.value = ''; destroyCharts();
  localStorage.removeItem(STORAGE_KEY);
  updateDashboard();
}

function fmtDh(n){ return isFinite(n)? `${Number(n).toFixed(2)} DH` : 'N/A'; }

// ===========================
//  AUTO-ASSIGNATION (2 passes par jour)
//  - Remplir la 1ère journée avant la suivante
//  - PASS 1 : match exact
//  - PASS 2 : upgrades
//  - Retours éligibles: >= 1h avant pickup
// ===========================
function autoAssignVehicles(){
  const today = new Date();
  const next7 = new Date(today.getTime() + 7*24*3600*1000);

  const upcoming = processedReservations
    .filter(r => r.pickupDate && r.pickupDate >= today && r.pickupDate <= next7)
    .sort((a,b)=> a.pickupDate - b.pickupDate);

  const byDay = new Map();
  for (const r of upcoming){
    const d = new Date(r.pickupDate);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(r);
  }

  const temp = { ...reservationAssignments };
  const tempMeta = { ...reservationAssignmentsMeta };

  const assignedSet = new Set(
    Object.values(temp)
      .filter(v => v && v !== 'none')
      .map(String)
  );

  // corporate à éviter pour retours auto (ex: Global Engines …)
  const CORPORATE_BLOCKED = new Set([
    'GLOBAL ENGINES','GLOBAL CHINESE MOTORS','GLOBAL AUTO TRADE & SERVICE','GLOBAL INTERNATIONAL MOTORS','GLOBAL ASSETS',
    'GROUPE OCP','WAFA IMA ASSISTANCE','DOLIDOL','DATAPROTECT','NEXANS','SODIPOL SARL'
  ].map(s=>s.toUpperCase()));

  const buildPool = (pickupDate) => {
    const poolAvail = processedAvailable
      .filter(v => !assignedSet.has(String(v.unitNumber)))
      .map(v => ({ unitNumber:String(v.unitNumber), class:normClass(v.class), from:'available', returnDate:null }));

    const poolReturnsRaw = processedDueIn
      .filter(v =>
        v.expectedReturn &&
        (pickupDate - v.expectedReturn) >= ONE_HOUR &&
        !CORPORATE_BLOCKED.has(String(v.name||'').trim().toUpperCase())
      )
      .filter(v => !assignedSet.has(String(v.unitNumber)))
      .map(v => ({ unitNumber:String(v.unitNumber), class:normClass(v.class), from:'return', returnDate:v.expectedReturn }));

    const seen = new Set(poolAvail.map(x=>x.unitNumber));
    const poolReturns = poolReturnsRaw.filter(x=> !seen.has(x.unitNumber));

    return [...poolAvail, ...poolReturns];
  };

  const dayKeys = Array.from(byDay.keys()).sort();
  for (const dayKey of dayKeys){
    const dayRes = byDay.get(dayKey).sort((a,b)=> a.pickupDate - b.pickupDate);

    // PASS 1 : exact
    for (const res of dayRes){
      if (temp[res.resNumber]) {
        if (temp[res.resNumber] !== 'none') assignedSet.add(String(temp[res.resNumber]));
        continue;
      }
      const req = normClass(res.class);
      const pool = buildPool(res.pickupDate);
      const exact = pool.find(u => normClass(u.class) === req && canSatisfy(req, u.class));
      if (exact){
        temp[res.resNumber] = exact.unitNumber;
        tempMeta[res.resNumber] = {
          source: exact.from,
          returnDate: exact.returnDate || null,
          upgrade: false
        };
        assignedSet.add(String(exact.unitNumber));
      }
    }

    // PASS 2 : upgrades
    for (const res of dayRes){
      if (temp[res.resNumber]) continue;
      const req = normClass(res.class);
      const prefs = bestUpgradeOrder(req).slice(1);
      const pool = buildPool(res.pickupDate);
      let candidate = null;
      for (const upCls of prefs){
        if (isAuto(req) && !isAuto(upCls)) continue;
        candidate = pool.find(v => normClass(v.class) === upCls && canSatisfy(req, v.class));
        if (candidate) break;
      }
      if (candidate){
        temp[res.resNumber] = candidate.unitNumber;
        tempMeta[res.resNumber] = {
          source: candidate.from,
          returnDate: candidate.returnDate || null,
          upgrade: true
        };
        assignedSet.add(String(candidate.unitNumber));
      }
    }
  }

  reservationAssignments = temp;
  reservationAssignmentsMeta = tempMeta;
}

// ================== KPIs & UI ==================
function updateKPIs(reservations, available, dueIn){
  document.getElementById('totalReservations').textContent = reservations.length;
  document.getElementById('vehiclesAvailable').textContent = available.length;
  document.getElementById('vehiclesOnRent').textContent = dueIn.length;
  document.getElementById('overdueVehicles').textContent = dueIn.filter(v => v.daysLate > 0).length;

  const today = new Date(); const next7 = new Date(today.getTime() + 7*24*3600*1000);
  const upcoming = reservations.filter(r => r.pickupDate >= today && r.pickupDate <= next7);
  const revenue = upcoming.reduce((sum,r)=>{
    if (r.pickupDate && r.dropOffDate && r.dailyRate){
      const dur = Math.max(1, DF.differenceInDays(r.dropOffDate, r.pickupDate));
      const rate = parseFloat(String(r.dailyRate).replace(',','.'));
      if(!isNaN(rate)) return sum + dur*rate;
    }
    return sum;
  },0);
  document.getElementById('upcomingRevenue').textContent = fmtDh(revenue);
}

function updateCharts(reservations, available, dueIn){
  const fleetCanvas = document.getElementById('fleetStatusChart');
  const resCanvas = document.getElementById('reservationsByClassChart');
  const dueCanvas = document.getElementById('dueInByLocationChart');
  const busyDaysCanvas = document.getElementById('busyDaysChart');
  if (!fleetCanvas || !resCanvas || !dueCanvas || !busyDaysCanvas) return;

  const fleetCtx = fleetCanvas.getContext('2d');
  const fleetPh = document.getElementById('fleetStatusPlaceholder');
  if (available.length>0 || dueIn.length>0){
    fleetPh.classList.add('hidden');
    charts.fleet = new Chart(fleetCtx,{ type:'doughnut', data:{ labels:['Disponible','En Location'], datasets:[{ data:[available.length, dueIn.length], backgroundColor:['#10B981','#F59E0B'], borderColor:'#fff', borderWidth:3 }]}, options:{ responsive:true, maintainAspectRatio:false }});
  } else { fleetPh.classList.remove('hidden'); }

  const resCtx = resCanvas.getContext('2d');
  const resPh = document.getElementById('reservationsByClassPlaceholder');
  if (reservations.length>0){
    resPh.classList.add('hidden');
    const counts = reservations.reduce((acc,r)=>{ const k=r.class||'Inconnu'; acc[k]=(acc[k]||0)+1; return acc; },{});
    charts.class = new Chart(resCtx,{ type:'bar', data:{ labels:Object.keys(counts), datasets:[{ label:'Nombre de Réservations', data:Object.values(counts), backgroundColor:'#3B82F6' }]}, options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } } }});
  } else { resPh.classList.remove('hidden'); }

  const dueCtx = dueCanvas.getContext('2d');
  const duePh = document.getElementById('dueInByLocationPlaceholder');
  if (dueIn.length>0){
    duePh.classList.add('hidden');
    const counts = dueIn.reduce((acc,r)=>{ const k=r.location||mapLocFromCode(r.unitNumber)||'Inconnu'; acc[k]=(acc[k]||0)+1; return acc; },{});
    charts.location = new Chart(dueCtx,{ type:'bar', data:{ labels:Object.keys(counts), datasets:[{ label:'Véhicules Attendus', data:Object.values(counts), backgroundColor:'#8B5CF6' }]}, options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } }, onClick: (evt, els)=>{ if (!els || !els.length) return; const idx = els[0].index; const label = charts.location.data.labels[idx]; openLocationDetail(label); } }});
  } else { duePh.classList.remove('hidden'); }

  // Busy Days (next 7 days) — sum of events for hours with >1
  const busyPh = document.getElementById('busyDaysPlaceholder');
  const days = getNextDays(7);
  const dayTotals = days.map(d=> calculateBusyForDay(d));
  const hasData = dayTotals.some(x=> x.totalEvents>0);
  if (hasData){
    busyPh.classList.add('hidden');
    const labels = days.map(d=> formatDayLabel(d));
    const data = dayTotals.map(x=> x.totalEvents);
    const ctx = busyDaysCanvas.getContext('2d');
    charts.busydays = new Chart(ctx, { type:'bar', data:{ labels, datasets:[ { label:'Événements (heures >1)', data } ] }, options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } }, onClick:(evt,els)=>{ if(!els||!els.length) return; const i = els[0].index; openBusyDayDetail(days[i]); } }});
  } else { busyPh.classList.remove('hidden'); }
}

function getNextDays(n){
  const today = new Date(); const start = DF.startOfDay(today); const arr=[];
  for(let i=0;i<n;i++){ const d = new Date(start); d.setDate(d.getDate()+i); arr.push(d); }
  return arr;
}
function formatDayLabel(d){
  const days = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
  return `${days[d.getDay()]} ${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
}

function collectEvents(){
  // {type:'pickup'|'return', when:Date, source:'reservation'|'dueIn', payload:{...}}
  const events = [];
  processedReservations.forEach(r=>{
    if (r.pickupDate) events.push({ type:'pickup', when:r.pickupDate, source:'reservation', payload:r });
    if (r.dropOffDate) events.push({ type:'return', when:r.dropOffDate, source:'reservation', payload:r });
  });
  processedDueIn.forEach(v=>{ if (v.expectedReturn) events.push({ type:'return', when:v.expectedReturn, source:'dueIn', payload:v }); });
  return events;
}

function calculateBusyForDay(day){
  const events = collectEvents().filter(e=> DF.isSameDay(e.when, day));
  const hours = new Array(24).fill(0);
  events.forEach(e=>{ hours[new Date(e.when).getHours()]++; });
  const busyHoursIdx = hours.map((v,i)=> v>1? i : -1).filter(i=> i>=0);
  const totalEvents = busyHoursIdx.reduce((s,i)=> s+hours[i], 0);
  return { busyHoursIdx, totalEvents };
}

function openLocationDetail(label){
  const rows = processedDueIn.filter(r=> (r.location||mapLocFromCode(r.unitNumber)||'Inconnu') === label);
  detailTitle.textContent = `Retours – ${label}`;
  const tbody = rows.map(r=> `<tr class="border-b"><td class="px-3 py-2">${r.unitNumber||'N/A'}</td><td class="px-3 py-2">${r.model||'N/A'}</td><td class="px-3 py-2">${r.class||'N/A'}</td><td class="px-3 py-2">${r.name||'N/A'}</td><td class="px-3 py-2">${r.expectedReturn? DF.dateFormat(r.expectedReturn,'dd/MM/yyyy HH:mm'):'—'}</td><td class="px-3 py-2">${r.daysLate||0}</td></tr>`).join('');
  detailBody.innerHTML = `
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-xs text-gray-700 uppercase bg-gray-50">
          <tr><th class="px-3 py-2">Unit #</th><th class="px-3 py-2">Modèle</th><th class="px-3 py-2">Classe</th><th class="px-3 py-2">Client</th><th class="px-3 py-2">Retour Prévu</th><th class="px-3 py-2">Jours Retard</th></tr>
        </thead>
        <tbody>${tbody||''}</tbody>
      </table>
    </div>`;
  detailModal.classList.add('show');
}

function openBusyDayDetail(day){
  const events = collectEvents().filter(e=> DF.isSameDay(e.when, day));
  const hours = new Array(24).fill(0);
  events.forEach(e=>{ hours[new Date(e.when).getHours()]++; });
  const busyIdx = hours.map((v,i)=> v>1? i : -1).filter(i=> i>=0);
  const labels = busyIdx.map(h=> `${String(h).padStart(2,'0')}:00`);
  const depCounts = busyIdx.map(h=> events.filter(e=> new Date(e.when).getHours()===h && e.type==='pickup').length);
  const retCounts = busyIdx.map(h=> events.filter(e=> new Date(e.when).getHours()===h && e.type==='return').length);

  detailTitle.textContent = `Heures chargées – ${formatDayLabel(day)}`;
  const canvasId = 'detailHourChart';
  detailBody.innerHTML = `
    <div class="chart-container" style="height:260px">
      <canvas id="${canvasId}"></canvas>
    </div>
    <div class="overflow-x-auto mt-4">
      <table class="w-full text-sm">
        <thead class="text-xs text-gray-700 uppercase bg-gray-50">
          <tr><th class="px-3 py-2">Heure</th><th class="px-3 py-2">Type</th><th class="px-3 py-2">Source</th><th class="px-3 py-2">Ref</th><th class="px-3 py-2">Nom/Client</th><th class="px-3 py-2">Classe/Modèle</th></tr>
        </thead>
        <tbody id="detailEventsTbody"></tbody>
      </table>
    </div>`;
  detailModal.classList.add('show');

  const ctx = document.getElementById(canvasId).getContext('2d');
  if (charts.detailHour) { try{ charts.detailHour.destroy(); }catch(_){} }
  charts.detailHour = new Chart(ctx, { type:'bar', data:{ labels, datasets:[ {label:'Départs', data:depCounts}, {label:'Retours', data:retCounts} ] }, options:{ responsive:true, maintainAspectRatio:false, scales:{ x:{ stacked:true }, y:{ beginAtZero:true, stacked:true } } }});

  const tbody = document.getElementById('detailEventsTbody');
  const rows = events
    .filter(e=> busyIdx.includes(new Date(e.when).getHours()))
    .sort((a,b)=> a.when - b.when)
    .map(e=>{
      const h = `${String(new Date(e.when).getHours()).padStart(2,'0')}:00`;
      if (e.source==='reservation'){
        const r = e.payload; const ref = r.resNumber||'Res'; const who = r.name||'—'; const cls = r.class||'—';
        return `<tr class="border-b"><td class="px-3 py-2">${h}</td><td class="px-3 py-2">${e.type==='pickup'?'Départ':'Retour'}</td><td class="px-3 py-2">Réservation</td><td class="px-3 py-2">${ref}</td><td class="px-3 py-2">${who}</td><td class="px-3 py-2">${cls}</td></tr>`;
      } else {
        const v = e.payload; const ref = v.unitNumber||'Unit'; const who = v.name||'—'; const mdl = v.model||'—';
        return `<tr class="border-b"><td class="px-3 py-2">${h}</td><td class="px-3 py-2">Retour</td><td class="px-3 py-2">Due-In</td><td class="px-3 py-2">${ref}</td><td class="px-3 py-2">${who}</td><td class="px-3 py-2">${mdl}</td></tr>`;
      }
    }).join('');
  tbody.innerHTML = rows || `<tr><td colspan="6" class="text-center py-3 text-gray-500">Aucune heure > 1 événement pour ce jour.</td></tr>`;
}

// ---- Résumé assignations (bandeau hors tableau)
function summarizeAssignments(upcoming){
  let assigned = 0, fromReturns = 0, upgrades = 0;
  for (const r of upcoming){
    const raw = reservationAssignments[r.resNumber];
    if (!raw || raw === 'none') continue;
    assigned++;
    const unit = cleanUnit(raw);
    const meta = reservationAssignmentsMeta[r.resNumber] || {};
    const reqCls = normClass(r.class);
    // retours comptés
    const retObj = (meta.source === 'return' && meta.returnDate)
      ? { expectedReturn: meta.returnDate }
      : findEligibleReturn(unit, r.pickupDate);
    if (retObj) fromReturns++;
    // upgrades
    const unitCls = classOfUnit(unit);
    let isUpgrade = false;
    if (unitCls && reqCls && (unitCls in CLASS_RANK) && (reqCls in CLASS_RANK)){
      isUpgrade = CLASS_RANK[unitCls] > CLASS_RANK[reqCls];
    } else if (meta.upgrade === true) {
      isUpgrade = true;
    }
    if (isUpgrade) upgrades++;
  }
  return { assigned, unassigned: upcoming.length - assigned, fromReturns, upgrades };
}

function renderAssignSummary(stats){
  let host = null;
  for (const h of Array.from(document.querySelectorAll('h3'))) {
    if (/Réservations à Venir/i.test(h.textContent)) { host = h; break; }
  }
  if (!host) return;
  let box = document.getElementById('assignSummary');
  if (!box){
    box = document.createElement('div');
    box.id = 'assignSummary';
    host.insertAdjacentElement('afterend', box);
  }
  box.className = 'mt-1 mb-3 flex flex-wrap items-center gap-2 text-[11px] text-gray-600';
  box.innerHTML = `
    <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-50 border">Assignées: ${stats.assigned}</span>
    <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-50 border">Non: ${stats.unassigned}</span>
    <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200">Retours: ${stats.fromReturns}</span>
    <span class="inline-flex items-center px-1.5 py-0.5 rounded bg-yellow-50 border border-yellow-200">Upgrades: ${stats.upgrades}</span>`;
}

// ================== TABLES (inclut Contrôle Véhicules Disponibles) ==================
function updateTables(reservations, dueIn, available){
  const tbodyRes = document.getElementById('upcomingReservationsTable');
  const availDiv = document.getElementById('availabilityByCategory');
  const tbodyReturns = document.getElementById('upcomingReturnsTable');
  const tbodyOver = document.getElementById('overdueVehiclesTable');
  const tbodyAvailCk = document.getElementById('availableCheckTable'); // <- section contrôle

  if (!tbodyRes || !availDiv || !tbodyReturns || !tbodyOver) return;

  tbodyRes.innerHTML=''; availDiv.innerHTML=''; tbodyReturns.innerHTML=''; tbodyOver.innerHTML='';
  if (tbodyAvailCk) tbodyAvailCk.innerHTML = '';

  const today = new Date();
  const next7 = new Date(today.getTime() + 7*24*3600*1000);

  const upcoming = reservations
    .filter(r=> r.pickupDate>=today && r.pickupDate<=next7)
    .sort((a,b)=>a.pickupDate-b.pickupDate);

  // Résumé global (hors tableau)
  const stats = summarizeAssignments(upcoming);
  renderAssignSummary(stats);

  // ---------- Réservations à venir
  if (upcoming.length>0){
    upcoming.forEach((r)=>{
      const assignedRaw  = reservationAssignments[r.resNumber];
      const assignedUnit = assignedRaw && assignedRaw !== 'none' ? cleanUnit(assignedRaw) : null;
      const meta = reservationAssignmentsMeta[r.resNumber] || {};
      const reqCls = normClass(r.class);

      const assignedSetAll = new Set(
        Object.values(reservationAssignments)
          .filter(v => v && v !== 'none')
          .map(cleanUnit)
      );
      const rank = (c)=> CLASS_RANK[normClass(c)] ?? Infinity;

      let pool = available
        .filter(v => {
          const unit = String(v.unitNumber);
          const isAssignedElsewhere = assignedSetAll.has(unit);
          const isCurrentAssigned   = assignedUnit && unit === String(assignedUnit);
          return (isCurrentAssigned || !isAssignedElsewhere) && canSatisfy(reqCls, v.class);
        })
        .sort((a,b)=> rank(a.class) - rank(b.class));

      if (assignedUnit && !pool.some(v=> String(v.unitNumber)===String(assignedUnit))){
        const cls = classOfUnit(assignedUnit) || reqCls;
        pool = [{ unitNumber: String(assignedUnit), class: cls }, ...pool];
      }

      let options = `<option value="none" ${!assignedUnit?'selected':''}>Aucun</option>`;
      // exact
      pool.filter(v=> normClass(v.class)===reqCls).forEach(v=>{
        const unit = String(v.unitNumber||'');
        const selected = unit===assignedUnit;
        const disabled = assignedSetAll.has(unit) && !selected;
        options += `<option value="${unit}" ${selected?'selected':''} ${disabled?'disabled':''}>${unit} (${(v.class||'?').toUpperCase()})</option>`;
      });
      // upgrades
      pool.filter(v=> normClass(v.class)!==reqCls).forEach(v=>{
        const unit = String(v.unitNumber||'');
        const selected = unit===assignedUnit;
        const disabled = assignedSetAll.has(unit) && !selected;
        options += `<option value="${unit}" ${selected?'selected':''} ${disabled?'disabled':''}>${unit} (${(v.class||'?').toUpperCase()} · upgrade)</option>`;
      });

      const price = r.dailyRate ? `${parseFloat(String(r.dailyRate).replace(',','.')).toFixed(2)} DH` : 'N/A';

      // pills sous le select
      const pills = [];
      if (assignedUnit){
        const unitCls = classOfUnit(assignedUnit);
        const labelCls = (unitCls || reqCls || '?').toUpperCase() + (unitCls ? '' : ' ?');
        pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-[10px] border">${labelCls}</span>`);
        const retObj = (meta.source === 'return' && meta.returnDate)
          ? { expectedReturn: meta.returnDate }
          : findEligibleReturn(assignedUnit, r.pickupDate);
        if (retObj){
          const d = new Date(retObj.expectedReturn);
          pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] border border-blue-200">retour du ${DF.dateFormat(d,'dd/MM HH:mm')}</span>`);
        }
        const isUp = (() => {
          const uCls = unitCls;
          if (uCls && reqCls && (uCls in CLASS_RANK) && (reqCls in CLASS_RANK)) {
            return CLASS_RANK[uCls] > CLASS_RANK[reqCls];
          }
          return meta.upgrade === true;
        })();
        if (isUp){
          pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded bg-yellow-50 text-yellow-700 text-[10px] border border-yellow-200">upgrade</span>`);
        }
      }
      const metaRow = pills.length ? `<div class="mt-1 flex flex-wrap gap-1">${pills.join('')}</div>` : '';

      const selectHTML = `
        <div class="min-w-[220px]">
          <div class="flex items-center gap-2">
            <select class="assigned-select w-48" data-res-number="${r.resNumber}">${options}</select>
          </div>
          ${metaRow}
        </div>`;

      tbodyRes.innerHTML += `
        <tr class="border-b hover:bg-gray-50">
          <td class="px-4 py-2 font-medium">${r.resNumber||'N/A'}</td>
          <td class="px-4 py-2">${r.name||'N/A'}</td>
          <td class="px-4 py-2">${r.class||'N/A'}</td>
          <td class="px-4 py-2">${DF.dateFormat(r.pickupDate,'dd/MM/yyyy HH:mm')}</td>
          <td class="px-4 py-2">${price}</td>
          <td class="px-4 py-2">${selectHTML}</td>
        </tr>`;
    });
  } else {
    tbodyRes.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-gray-500">${reservations.length>0? 'Aucune réservation à venir dans les 7 prochains jours.' : 'Veuillez téléverser le fichier des réservations.'}</td></tr>`;
  }

  // ---------- Disponibilité par Catégorie (tags)
  if (available.length>0){
    const byCat = available.reduce((acc,v)=>{ const k=v.class||'Inconnu'; (acc[k] ||= []).push(v.unitNumber); return acc; }, {});
    Object.keys(byCat).sort().forEach(cat=>{
      availDiv.innerHTML += `<h4 class="font-semibold mt-4 mb-2 text-sm">${cat}</h4>`;
      const list = byCat[cat].map(u=>{
        const locked = Object.values(reservationAssignments).filter(v=> v && v !== 'none').map(String).includes(String(u));
        return `<span class="inline-block px-2 py-1 mr-2 mb-2 rounded ${locked?'bg-gray-200 text-gray-500 line-through':'bg-green-100 text-green-800'}">${u||'?'} ${locked?'🔒':''}</span>`;
      }).join('');
      availDiv.innerHTML += `<div>${list}</div>`;
    });
  } else { availDiv.innerHTML = `<p class="text-center py-4 text-gray-500">Veuillez téléverser le fichier des unités disponibles.</p>`; }

  // ---------- Retours à venir
  if (dueIn.length>0){
    const upcomingReturns = dueIn
      .filter(v=> v.expectedReturn && v.expectedReturn>=today && v.expectedReturn<=next7)
      .sort((a,b)=>a.expectedReturn-b.expectedReturn);
    if (upcomingReturns.length>0){
      upcomingReturns.forEach(v=>{
        tbodyReturns.innerHTML += `<tr class="border-b hover:bg-gray-50"><td class="px-4 py-2 font-medium">${v.unitNumber||'N/A'}</td><td class="px-4 py-2">${v.model||'N/A'}</td><td class="px-4 py-2">${v.name||'N/A'}</td><td class="px-4 py-2">${DF.dateFormat(v.expectedReturn,'dd/MM/yyyy HH:mm')}</td></tr>`;
      });
    } else {
      const hasDates = dueIn.some(v=>v.expectedReturn);
      tbodyReturns.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray-500">${hasDates? 'Aucun retour attendu dans les 7 prochains jours.' : 'Fichier chargé, mais impossible de lire les dates de retour.'}</td></tr>`;
    }
  } else { tbodyReturns.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray-500">Veuillez téléverser le fichier des véhicules attendus.</td></tr>`; }

  // ---------- En retard
  if (dueIn.length>0){
    const overdue = dueIn.filter(v=> Number(v.daysLate)>0).sort((a,b)=>Number(b.daysLate)-Number(a.daysLate));
    if (overdue.length>0){
      overdue.forEach(v=>{
        tbodyOver.innerHTML += `<tr class="border-b hover:bg-gray-50"><td class="px-4 py-2 font-medium">${v.unitNumber||'N/A'}</td><td class="px-4 py-2">${v.model||'N/A'}</td><td class="px-4 py-2">${v.name||'N/A'}</td><td class="px-4 py-2 text-red-600 font-semibold">${v.daysLate}</td></tr>`;
      });
    } else {
      tbodyOver.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray-500">Aucun véhicule en retard.</td></tr>`;
    }
  } else { tbodyOver.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray-500">Veuillez téléverser le fichier des véhicules attendus.</td></tr>`; }

  // ---------- Contrôle Véhicules Disponibles (KM & Carburant)
  if (tbodyAvailCk){
    if (available.length === 0){
      tbodyAvailCk.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-gray-500">Veuillez téléverser le fichier des unités disponibles.</td></tr>`;
    } else {
    available.forEach(v => {
      const fuelIcon = (() => {
        const lv = (v.currentFuel || '').toString().trim();
        return (lv && lv.toUpperCase() !== 'F') ? `<span title="Carburant non plein" class="text-red-600">⛽</span>` : '';
      })();

      const odoTxt   = (v.currentOdo != null && isFinite(v.currentOdo))
        ? `${Math.round(v.currentOdo).toLocaleString()}`
        : '—';

      const plateTxt = v.plate ? String(v.plate) : '';

      const tr = document.createElement('tr');
      tr.className = 'border-b hover:bg-gray-50';
      tr.innerHTML = `
        <td class="px-4 py-2 font-medium">${v.unitNumber || 'N/A'}</td>
        <td class="px-4 py-2">${plateTxt}</td>
        <td class="px-4 py-2">${(v.class || '—').toUpperCase()}</td>
        <td class="px-4 py-2">${odoTxt}</td>
        <td class="px-4 py-2">${fuelIcon} <span class="text-xs text-gray-500">${v.currentFuel || ''}</span></td>
        <td class="px-4 py-2">
          <input type="number" class="w-28 border rounded px-2 py-1 text-sm" placeholder="KM réel">
        </td>
        <td class="px-4 py-2">
          <select class="border rounded px-2 py-1 text-sm">
            <option value="">—</option>
            <option>F</option><option>3/4</option><option>1/2</option><option>1/4</option><option>E</option>
          </select>
        </td>
        <td class="px-4 py-2 text-center">
          <input type="checkbox" class="theory-check" data-unit="${v.unitNumber}">
        </td>
        <td class="px-4 py-2 text-xs text-gray-400">—</td>
      `;
      tbodyAvailCk.appendChild(tr);
    });

    }
  }

  // Listeners selects
  document.querySelectorAll('.assigned-select').forEach(sel => sel.addEventListener('change', handleAssignmentChange));
}

// ================== Cycle principal ==================
function updateDashboard(){
  destroyCharts();
  autoAssignVehicles();
  updateKPIs(processedReservations, processedAvailable, processedDueIn);
  updateCharts(processedReservations, processedAvailable, processedDueIn);
  updateTables(processedReservations, processedDueIn, processedAvailable);
}

fileInput.addEventListener('change', handleFileUpload);
resetButton.addEventListener('click', resetAll);
detailClose.addEventListener('click', ()=> detailModal.classList.remove('show'));
detailModal.addEventListener('click', (e)=>{ if(e.target===detailModal) detailModal.classList.remove('show'); });

loadState();
updateDashboard();
