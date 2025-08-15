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
  dateFormat: (d, fmt) => (d instanceof Date && !isNaN(d.getTime()) ? dfFormat(d, fmt) : ''),
  differenceInDays: dfDiff,
  startOfDay: dfStart,
  isSameDay: dfSame,
};

// ================== Données & constantes ==================
const STORAGE_KEY = 'rf_site_state_v5';
const VERIF_KEY   = 'rf_avail_verif_v1';

// ====== Hiérarchie de classes + contrainte transmission ======
// mdmr<mdar<edmr<edar<cdmr<cdar<idmr<idar<sdah<cfmr<cfar<ifmr<ifar<ifah
const CLASS_CHAIN = ['mdmr','mdar','edmr','edar','cdmr','cdar','idmr','idar','sdah','cfmr','cfar','ifmr','ifar','ifah'];
const CLASS_RANK  = Object.fromEntries(CLASS_CHAIN.map((c,i)=>[c,i]));

// --- Helpers d'unité / carburant / km
const ONE_HOUR = 3600 * 1000;
const cleanUnit = (u) => String(u || '').replace(/\s*\(retour\)$/i,'').trim();
function normClass(cls){ return String(cls||'').trim().toLowerCase(); }
function isAuto(cls){ return normClass(cls)[2] === 'a'; }

function toNumber(val){
  if (val == null || val === '') return null;
  const s = String(val).replace(/\s+/g,'').replace(/,/g,'');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

// carburant → true si PAS plein (affiche ⛽)
function isFuelNotFull(val){
  if (val == null) return false;
  const s = String(val).trim();
  if (!s) return false;
  const u = s.toUpperCase();
  if (u === 'F' || u === 'FULL' || u === '8/8' || u === '1' || u === '1.0' || u === '100' || u === '100%') return false;
  const frac = u.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (frac){
    const num = parseFloat(frac[1]), den = parseFloat(frac[2]);
    if (den > 0) return (num/den) < 0.98;
  }
  const perc = u.match(/^(\d+(?:\.\d+)?)%$/);
  if (perc) return parseFloat(perc[1]) < 98;
  if (u === 'E' || u === 'EMPTY' || u === '0' || u === '0%') return true;
  return false;
}

// Carburant → ratio [0..1] (pour comparer réel vs fichier)
function fuelToRatio(val){
  if (val == null || val === '') return null;
  const u = String(val).trim().toUpperCase();
  if (u === 'F' || u === 'FULL' || u === '8/8' || u === '1' || u === '100' || u === '100%') return 1;
  if (u === 'E' || u === 'EMPTY' || u === '0' || u === '0%') return 0;
  const frac = u.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (frac){
    const num = parseFloat(frac[1]), den = parseFloat(frac[2]);
    if (den>0) return Math.max(0, Math.min(1, num/den));
  }
  const perc = u.match(/^(\d+(?:\.\d+)?)%$/);
  if (perc) return Math.max(0, Math.min(1, parseFloat(perc[1])/100));
  const num = toNumber(u);
  if (num!=null){
    if (num>1) return Math.max(0, Math.min(1, num/100));
    return Math.max(0, Math.min(1, num));
  }
  return null;
}

// r = classe demandée, u = classe du véhicule
function canSatisfy(reqCls, unitCls){
  const r = normClass(reqCls), u = normClass(unitCls);
  if (isAuto(r) && !isAuto(u)) return false;
  if (!(r in CLASS_RANK) || !(u in CLASS_RANK)) return r === u;
  return CLASS_RANK[u] >= CLASS_RANK[r];
}

// ordre d’essai : exact puis upgrades croissantes
function bestUpgradeOrder(reqCls){
  const r = CLASS_RANK[normClass(reqCls)];
  if (r == null) return [normClass(reqCls)];
  return CLASS_CHAIN.slice(r);
}

// ================== Sélecteurs DOM ==================
const fileInput        = document.getElementById('fileInput');
const resetButton      = document.getElementById('resetButton');
const loadingDiv       = document.getElementById('loading');
const errorDiv         = document.getElementById('error');
const errorMessageSpan = document.getElementById('errorMessage');
const detailModal      = document.getElementById('detailModal');
const detailTitle      = document.getElementById('detailTitle');
const detailBody       = document.getElementById('detailBody');
const detailClose      = document.getElementById('detailClose');

let charts = {};
let processedReservations = [], processedDueIn = [], processedAvailable = [];
let reservationAssignments = {};
let reservationAssignmentsMeta = {};
let availVerif = {}; // { [unit]: { checked:boolean, realKm:number|null, realFuel:string|null, ts:number } }

// ================== Utils ==================
function makeCheckedDate(y, m, d, hh=0, mi=0, ss=0){
  if (!(m>=1 && m<=12) || !(d>=1 && d<=31)) return null;
  const dt = new Date(y, m-1, d, hh, mi, ss);
  if (dt.getFullYear() !== y || dt.getMonth() !== m-1 || dt.getDate() !== d) return null;
  return dt;
}
function destroyCharts(){ Object.values(charts).forEach(c=>{ try{ c?.destroy?.(); }catch(_){}}); charts={}; }
function headersOf(objArr){ if(!objArr || !objArr[0]) return []; return Object.keys(objArr[0]).map(h=> String(h)); }
function normHeader(h){ return String(h||'').replace(/[\u00A0]/g,' ').replace(/\s+/g,' ').trim(); }
function getField(row, aliases){ for (const a of aliases){ if (row[a] != null && row[a] !== '') return row[a]; } return undefined; }

function saveVerif(){
  try{ localStorage.setItem(VERIF_KEY, JSON.stringify(availVerif)); }catch(_){}
}
function loadVerif(){
  try{ const raw = localStorage.getItem(VERIF_KEY); availVerif = raw ? JSON.parse(raw) : {}; }catch(_){ availVerif = {}; }
}

// ================== Parsing Excel ==================
async function parseExcelFile(file) {
  if (!file) return null;
  const fileName = file.name.toLowerCase();
  if (!fileName.endsWith('.xlsx')) throw new Error(`Format de fichier non supporté: ${file.name}. Veuillez utiliser .xlsx`);
  const arrayBuffer   = await file.arrayBuffer();
  const workbook      = XLSX.read(arrayBuffer, { cellDates: false });
  const firstSheet    = workbook.SheetNames[0];
  const worksheet     = workbook.Sheets[firstSheet];
  const asObjectsRaw  = XLSX.utils.sheet_to_json(worksheet, { raw: false });
  const asArrays      = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false });
  const asObjects     = asObjectsRaw.map(r => { const out={}; Object.keys(r).forEach(k=> out[normHeader(k)] = r[k]); return out;});
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
  if (has('Curr Loc') && (has('Vin #') || has('Vin') || has('Unit #'))) return 'available';
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
  if (ok) {
    if(!el.innerText.includes('✅')) el.innerText += ' ✅';
    el.classList.remove('text-gray-400');
    el.classList.add('text-green-600','font-semibold');
  }
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
    processedReservations       = Array.isArray(s?.r)? s.r : [];
    processedDueIn              = Array.isArray(s?.d)? s.d : [];
    processedAvailable          = Array.isArray(s?.a)? s.a : [];
    reservationAssignments      = Object.fromEntries(Object.entries(s?.asg || {}).map(([k,v]) => [k, v==='none' ? 'none' : cleanUnit(v)]));
    reservationAssignmentsMeta  = s?.asgMeta || {};
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
          resNumber:  getField(r, ['Res #','RES #']),
          name:       getField(r, ['Name','Client','Customer']),
          class:      getField(r, ['Class','Categorie','Category','Car Class']),
          pickupDate: parseRobustDate(getField(r, ['Pickup Date','Pick Up Date'])),
          dropOffDate:parseRobustDate(getField(r, ['Drop Off Date','Return Date'])),
          dailyRate:  getField(r, ['Daily Rate','Rate','Prix'])
        })).filter(r => r.name && r.pickupDate);
        updateStatusIndicator('reservations', true);

      } else if (type === 'available') {
        processedAvailable = asObjects.map(r => ({
          unitNumber: getField(r, ['Unit #','Unit#','Unit','VIN','Vin #','Vin']),
          class:      getField(r, ['Class','Categorie','Category','Car Class']),
          fuel:       getField(r, ['Curr Fuel','CurrFuel','Fuel','Fuel Level']),
          odometer:   toNumber(getField(r, ['Curr Odo','Current Odo','Current Odometer','Odometer','Odo','KM','Km','Kilometrage','Mileage','Current Mileage']))
        })).filter(r => r.unitNumber);
        updateStatusIndicator('available', true);

      } else if (type === 'dueIn') {
        const unitAliases  = ['Unit #','Unit#','Unit','VIN','Vin #','Vin','__EMPTY','__EMPTY_1','Unnamed: 0'];
        const dateAliases  = ['Expected Return','Expected Return Date','Return Date','Due','Due In'];
        const nameAliases  = ['Name','Client'];
        const classAliases = ['Class','Categorie','Category','Car Class'];
        const locAliases   = ['Current Location','Current Location ','Curr Loc','Location'];

        const clean = asObjects.filter(r => (getField(r, unitAliases) || getField(r, nameAliases)) && (getField(r, dateAliases) != null));

        processedDueIn = clean.map(r => ({
          unitNumber:     getField(r, unitAliases),
          model:          getField(r, ['Model','Vehicle','Vehicule']),
          class:          getField(r, classAliases),
          daysLate:       parseInt(getField(r, ['Days Late','Days Out']) || '0', 10) || 0,
          name:           getField(r, nameAliases),
          location:       normalizeLoc(getField(r, locAliases) || getField(r, unitAliases)),
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

  loadingDiv.classList.add('hidden');
  fileInput.value = '';
  updateDashboard(); saveState();
}

// ====== Sélection manuelle (assignation) ======
function handleAssignmentChange(e){
  const resNumber = e.target.dataset.resNumber;
  const newUnit   = e.target.value;

  if (newUnit === 'none') {
    reservationAssignments[resNumber] = 'none';
    reservationAssignmentsMeta[resNumber] = { source:'manual', returnDate:null, upgrade:false };
    updateDashboard(); saveState();
    return;
  }

  const unit = String(newUnit);
  const res  = processedReservations.find(r => r.resNumber === resNumber);
  const reqCls = res ? normClass(res.class) : null;

  let source = 'available';
  let returnDate = null;
  if (res && res.pickupDate){
    const r = processedDueIn
      .filter(v => String(v.unitNumber)===unit && v.expectedReturn && (res.pickupDate - v.expectedReturn) >= ONE_HOUR)
      .sort((a,b)=> b.expectedReturn - a.expectedReturn)[0];
    if (r){ source = 'return'; returnDate = r.expectedReturn; }
  }

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
  processedReservations = []; processedDueIn = []; processedAvailable = [];
  reservationAssignments = {}; reservationAssignmentsMeta = {};
  availVerif = {}; saveVerif();
  document.querySelectorAll('.status-indicator').forEach(el=>{
    el.classList.remove('text-green-600','font-semibold');
    el.classList.add('text-gray-400');
    el.innerText = el.innerText.replace(' ✅','');
  });
  fileInput.value = ''; destroyCharts();
  localStorage.removeItem(STORAGE_KEY);
  updateDashboard();
}

function fmtDh(n){ return isFinite(n)? `${Number(n).toFixed(2)} DH` : 'N/A'; }

// =========================== AUTO-ASSIGNATION ===========================
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
  const assignedSet = new Set(Object.values(temp).filter(v => v && v !== 'none').map(cleanUnit));

  const buildPool = (pickupDate) => {
    const poolAvail = processedAvailable
      .filter(v => !assignedSet.has(String(v.unitNumber)))
      .map(v => ({ unitNumber:String(v.unitNumber), class:normClass(v.class), from:'available', returnDate:null }));

    const poolReturnsRaw = processedDueIn
      .filter(v => v.expectedReturn && (pickupDate - v.expectedReturn) >= ONE_HOUR)
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
        if (temp[res.resNumber] !== 'none') assignedSet.add(cleanUnit(temp[res.resNumber]));
        continue;
      }
      const req  = normClass(res.class);
      const pool = buildPool(res.pickupDate);
      const exact = pool.find(u => normClass(u.class) === req && canSatisfy(req, u.class));
      if (exact){
        temp[res.resNumber] = exact.unitNumber;
        tempMeta[res.resNumber] = { source: exact.from, returnDate: exact.returnDate || null, upgrade:false };
        assignedSet.add(String(exact.unitNumber));
      }
    }

    // PASS 2 : upgrades
    for (const res of dayRes){
      if (temp[res.resNumber]) continue;
      const req   = normClass(res.class);
      const prefs = bestUpgradeOrder(req).slice(1);
      const pool  = buildPool(res.pickupDate);
      let candidate = null;

      for (const upCls of prefs){
        if (isAuto(req) && !isAuto(upCls)) continue;
        candidate = pool.find(v => normClass(v.class) === upCls && canSatisfy(req, v.class));
        if (candidate) break;
      }
      if (candidate){
        temp[res.resNumber] = candidate.unitNumber;
        tempMeta[res.resNumber] = { source: candidate.from, returnDate: candidate.returnDate || null, upgrade:true };
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
  const resCanvas   = document.getElementById('reservationsByClassChart');
  const dueCanvas   = document.getElementById('dueInByLocationChart');
  const busyDaysCanvas = document.getElementById('busyDaysChart');
  if (!fleetCanvas || !resCanvas || !dueCanvas || !busyDaysCanvas) return;

  const fleetCtx = fleetCanvas.getContext('2d');
  const fleetPh  = document.getElementById('fleetStatusPlaceholder');
  if (available.length>0 || dueIn.length>0){
    fleetPh.classList.add('hidden');
    charts.fleet = new Chart(fleetCtx,{ type:'doughnut', data:{ labels:['Disponible','En Location'], datasets:[{ data:[available.length, dueIn.length], backgroundColor:['#10B981','#F59E0B'], borderColor:'#fff', borderWidth:3 }]}, options:{ responsive:true, maintainAspectRatio:false }});
  } else { fleetPh.classList.remove('hidden'); }

  const resCtx = resCanvas.getContext('2d');
  const resPh  = document.getElementById('reservationsByClassPlaceholder');
  if (reservations.length>0){
    resPh.classList.add('hidden');
    const counts = reservations.reduce((acc,r)=>{ const k=r.class||'Inconnu'; acc[k]=(acc[k]||0)+1; return acc; },{});
    charts.class = new Chart(resCtx,{ type:'bar', data:{ labels:Object.keys(counts), datasets:[{ label:'Nombre de Réservations', data:Object.values(counts), backgroundColor:'#3B82F6' }]}, options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } } }});
  } else { resPh.classList.remove('hidden'); }

  const dueCtx = dueCanvas.getContext('2d');
  const duePh  = document.getElementById('dueInByLocationPlaceholder');
  if (dueIn.length>0){
    duePh.classList.add('hidden');
    const counts = dueIn.reduce((acc,r)=>{ const k=r.location||mapLocFromCode(r.unitNumber)||'Inconnu'; acc[k]=(acc[k]||0)+1; return acc; },{});
    charts.location = new Chart(dueCtx,{ type:'bar', data:{ labels:Object.keys(counts), datasets:[{ label:'Véhicules Attendus', data:Object.values(counts), backgroundColor:'#8B5CF6' }]}, options:{ responsive:true, maintainAspectRatio:false, scales:{ y:{ beginAtZero:true } }, onClick: (evt, els)=>{ if (!els || !els.length) return; const idx = els[0].index; const label = charts.location.data.labels[idx]; openLocationDetail(label); } }});
  } else { duePh.classList.remove('hidden'); }

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
  if (charts.detailHour) { try{ charts.detailHour.destroy(); }catch(_){}} 
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

// ===== Résumé assignations (bandeau sous le titre) =====
function summarizeAssignments(upcoming){
  let assigned = 0, fromReturns = 0, upgrades = 0;
  for (const r of upcoming){
    const raw = reservationAssignments[r.resNumber];
    if (!raw || raw === 'none') continue;
    assigned++;
    const unit  = cleanUnit(raw);
    const meta  = reservationAssignmentsMeta[r.resNumber] || {};
    const reqCls = normClass(r.class);

    const retObj = (meta.source === 'return' && meta.returnDate)
      ? { expectedReturn: meta.returnDate }
      : processedDueIn
          .filter(v => String(v.unitNumber)===unit && v.expectedReturn && (r.pickupDate - v.expectedReturn) >= ONE_HOUR)
          .sort((a,b)=> b.expectedReturn - a.expectedReturn)[0];
    if (retObj) fromReturns++;

    const unitCls = (() => {
      const a = processedAvailable.find(v => String(v.unitNumber)===unit);
      if (a) return normClass(a.class);
      const d = processedDueIn.find(v => String(v.unitNumber)===unit);
      return d ? normClass(d.class) : null;
    })();

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

// ================== Tables & rendu ==================
function updateTables(reservations, dueIn, available){
  const tbodyRes     = document.getElementById('upcomingReservationsTable');
  const availDiv     = document.getElementById('availabilityByCategory');
  const tbodyReturns = document.getElementById('upcomingReturnsTable');
  const tbodyOver    = document.getElementById('overdueVehiclesTable');
  const tbodyAvailCk = document.getElementById('availableCheckTable');
  if (!tbodyRes || !availDiv || !tbodyReturns || !tbodyOver || !tbodyAvailCk) return;

  tbodyRes.innerHTML=''; availDiv.innerHTML=''; tbodyReturns.innerHTML=''; tbodyOver.innerHTML=''; tbodyAvailCk.innerHTML='';

  const today = new Date();
  const next7 = new Date(today.getTime() + 7*24*3600*1000);

  const upcoming = reservations
    .filter(r=> r.pickupDate>=today && r.pickupDate<=next7)
    .sort((a,b)=>a.pickupDate-b.pickupDate);

  // Résumé global (hors tableau)
  const stats = summarizeAssignments(upcoming);
  renderAssignSummary(stats);

  // ===== Réservations à venir
  if (upcoming.length>0){
    const assignedSetAll = new Set(Object.values(reservationAssignments).filter(v => v && v !== 'none').map(cleanUnit));

    upcoming.forEach((r)=>{
      const assignedRaw  = reservationAssignments[r.resNumber];
      const assignedUnit = assignedRaw && assignedRaw !== 'none' ? cleanUnit(assignedRaw) : null;
      const meta = reservationAssignmentsMeta[r.resNumber] || {};
      const reqCls = normClass(r.class);

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
        const cls = (() => {
          const a = processedAvailable.find(v => String(v.unitNumber)===String(assignedUnit));
          if (a) return normClass(a.class);
          const d = processedDueIn.find(v => String(v.unitNumber)===String(assignedUnit));
          return d ? normClass(d.class) : reqCls;
        })();
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

      const pills = [];
      if (assignedUnit){
        const unitCls = (() => {
          const a = processedAvailable.find(v => String(v.unitNumber)===assignedUnit);
          if (a) return normClass(a.class);
          const d = processedDueIn.find(v => String(v.unitNumber)===assignedUnit);
          return d ? normClass(d.class) : null;
        })();
        const labelCls = (unitCls || reqCls || '?').toUpperCase() + (unitCls ? '' : ' ?');
        pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-[10px] border">${labelCls}</span>`);

        const retObj = (meta.source === 'return' && meta.returnDate)
          ? { expectedReturn: meta.returnDate }
          : processedDueIn
              .filter(v => String(v.unitNumber)===assignedUnit && v.expectedReturn && (r.pickupDate - v.expectedReturn) >= ONE_HOUR)
              .sort((a,b)=> b.expectedReturn - a.expectedReturn)[0];
        if (retObj){
          const d = new Date(retObj.expectedReturn);
          pills.push(`<span class="inline-flex items-center px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] border border-blue-200">retour du ${DF.dateFormat(d,'dd/MM HH:mm')}</span>`);
        }

        const isUp = (unitCls && reqCls && (unitCls in CLASS_RANK) && (reqCls in CLASS_RANK)) ? (CLASS_RANK[unitCls] > CLASS_RANK[reqCls]) : (meta.upgrade === true);
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

  // ===== Disponibilité par catégorie (⛽ si pas plein)
  if (available.length>0){
    const byCat = available.reduce((acc,v)=>{ const k=v.class||'Inconnu'; (acc[k] ||= []).push(v); return acc; }, {});
    const assignedUnits = new Set(Object.values(reservationAssignments).filter(v=> v && v!=='none').map(cleanUnit));

    Object.keys(byCat).sort().forEach(cat=>{
      availDiv.innerHTML += `<h4 class="font-semibold mt-4 mb-2 text-sm">${cat}</h4>`;
      const list = byCat[cat].map(v=>{
        const u = String(v.unitNumber||'?');
        const locked = assignedUnits.has(u);
        const needFuel = isFuelNotFull(v.fuel);
        return `
          <span class="inline-flex items-center px-2 py-1 mr-2 mb-2 rounded ${locked?'bg-gray-200 text-gray-500 line-through':'bg-green-100 text-green-800'}">
            ${u} ${locked?'🔒':''}${needFuel? `<span class="fuel-icon" title="Carburant: ${String(v.fuel||'?')}">⛽</span>`:''}
          </span>`;
      }).join('');
      availDiv.innerHTML += `<div class="flex flex-wrap">${list}</div>`;
    });
  } else {
    availDiv.innerHTML = `<p class="text-center py-4 text-gray-500">Veuillez téléverser le fichier des unités disponibles.</p>`;
  }

  // ===== NOUVEAU : Contrôle Véhicules Disponibles (table)
  if (available.length>0){
    const rows = [...available].sort((a,b)=>{
      const ca = String(a.class||'').localeCompare(String(b.class||'')); if (ca!==0) return ca;
      return String(a.unitNumber||'').localeCompare(String(b.unitNumber||''));
    });

    rows.forEach(v=>{
      const u = String(v.unitNumber||'');
      const rec = availVerif[u] || {};
      const tsText = rec.ts ? DF.dateFormat(new Date(rec.ts),'dd/MM HH:mm') : '—';

      // badges différence si réels saisis
      const kmDiff = rec.realKm!=null && v.odometer!=null && Math.round(rec.realKm)!==Math.round(v.odometer);
      const fRealR = fuelToRatio(rec.realFuel);
      const fFileR = fuelToRatio(v.fuel);
      const fuelDiff = (fRealR!=null && fFileR!=null) ? (Math.abs(fRealR - fFileR) > 0.02) : false;

      const kmBadge   = rec.realKm!=null ? (kmDiff ? `<span class="badge-diff text-[10px] px-1 py-0.5 ml-2 rounded">diff</span>` : `<span class="badge-ok text-[10px] px-1 py-0.5 ml-2 rounded">ok</span>`) : '';
      const fuelBadge = rec.realFuel? (fuelDiff ? `<span class="badge-diff text-[10px] px-1 py-0.5 ml-2 rounded">diff</span>` : `<span class="badge-ok text-[10px] px-1 py-0.5 ml-2 rounded">ok</span>`) : '';

      tbodyAvailCk.innerHTML += `
        <tr class="border-b hover:bg-gray-50 align-middle">
          <td class="px-4 py-2 font-medium">${u}</td>
          <td class="px-4 py-2">${v.class||'—'}</td>
          <td class="px-4 py-2">${v.odometer!=null ? Math.round(v.odometer) : '—'}</td>
          <td class="px-4 py-2">${v.fuel!=null ? String(v.fuel) : '—'}</td>
          <td class="px-4 py-2">
            <input type="number" step="1" class="verif-km w-28 border rounded px-2 py-1 text-sm" data-unit="${u}" value="${rec.realKm!=null ? rec.realKm : ''}" placeholder="ex: 45210" />
            ${kmBadge}
          </td>
          <td class="px-4 py-2">
            <input type="text" class="verif-fuel w-28 border rounded px-2 py-1 text-sm" data-unit="${u}" value="${rec.realFuel? rec.realFuel : ''}" placeholder="F, 7/8, 90%" />
            ${fuelBadge}
          </td>
          <td class="px-4 py-2">
            <input type="checkbox" class="verif-check w-5 h-5" data-unit="${u}" ${rec.checked ? 'checked':''} />
          </td>
          <td class="px-4 py-2 text-gray-500">${tsText}</td>
        </tr>`;
    });
  } else {
    tbodyAvailCk.innerHTML = `<tr><td colspan="8" class="text-center py-4 text-gray-500">Veuillez téléverser le fichier des unités disponibles.</td></tr>`;
  }

  // Listeners pour la table de contrôle
  document.querySelectorAll('.verif-check').forEach(cb=>{
    cb.addEventListener('change', e=>{
      const unit = e.target.dataset.unit;
      const rec = availVerif[unit] || {};
      rec.checked = e.target.checked;
      rec.ts = Date.now();
      availVerif[unit] = rec;
      saveVerif();
      updateTables(processedReservations, processedDueIn, processedAvailable); // rafraîchit badges & horodatage
    });
  });
  document.querySelectorAll('.verif-km').forEach(inp=>{
    inp.addEventListener('change', e=>{
      const unit = e.target.dataset.unit;
      const rec = availVerif[unit] || {};
      rec.realKm = toNumber(e.target.value);
      rec.ts = Date.now();
      availVerif[unit] = rec;
      saveVerif();
      updateTables(processedReservations, processedDueIn, processedAvailable);
    });
  });
  document.querySelectorAll('.verif-fuel').forEach(inp=>{
    inp.addEventListener('change', e=>{
      const unit = e.target.dataset.unit;
      const rec = availVerif[unit] || {};
      rec.realFuel = String(e.target.value || '');
      rec.ts = Date.now();
      availVerif[unit] = rec;
      saveVerif();
      updateTables(processedReservations, processedDueIn, processedAvailable);
    });
  });

  // ===== Retours attendus
  if (dueIn.length>0){
    const upcomingReturns = dueIn.filter(v=> v.expectedReturn && v.expectedReturn>=today && v.expectedReturn<=next7).sort((a,b)=>a.expectedReturn-b.expectedReturn);
    if (upcomingReturns.length>0){
      upcomingReturns.forEach(v=>{
        tbodyReturns.innerHTML += `<tr class="border-b hover:bg-gray-50"><td class="px-4 py-2 font-medium">${v.unitNumber||'N/A'}</td><td class="px-4 py-2">${v.model||'N/A'}</td><td class="px-4 py-2">${v.name||'N/A'}</td><td class="px-4 py-2">${DF.dateFormat(v.expectedReturn,'dd/MM/yyyy HH:mm')}</td></tr>`;
      });
    } else {
      const hasDates = dueIn.some(v=>v.expectedReturn);
      tbodyReturns.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray-500">${hasDates? 'Aucun retour attendu dans les 7 prochains jours.' : 'Fichier chargé, mais impossible de lire les dates de retour.'}</td></tr>`;
    }
  } else {
    tbodyReturns.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray-500">Veuillez téléverser le fichier des véhicules attendus.</td></tr>`;
  }

  // ===== Retards
  if (dueIn.length>0){
    const overdue = dueIn.filter(v=> Number(v.daysLate)>0).sort((a,b)=>Number(b.daysLate)-Number(a.daysLate));
    if (overdue.length>0){
      overdue.forEach(v=>{
        tbodyOver.innerHTML += `<tr class="border-b hover:bg-gray-50"><td class="px-4 py-2 font-medium">${v.unitNumber||'N/A'}</td><td class="px-4 py-2">${v.model||'N/A'}</td><td class="px-4 py-2">${v.name||'N/A'}</td><td class="px-4 py-2 text-red-600 font-semibold">${v.daysLate}</td></tr>`;
      });
    } else {
      tbodyOver.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray-500">Aucun véhicule en retard.</td></tr>`;
    }
  } else {
    tbodyOver.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-gray-500">Veuillez téléverser le fichier des véhicules attendus.</td></tr>`;
  }

  // Listeners assignation
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
loadVerif();
updateDashboard();
