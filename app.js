'use strict';

/* ================================================================
   Annas Glubschis
   Daten: daten.json (nur status "bestätigt" wird angezeigt)
   Alles Persönliche bleibt auf dem Gerät (IndexedDB):
     fotos       {id, blob, geaendert}   – max. 800 px, JPEG
     bewertungen {id, herzen}            – 1..5
     wunsch      {id}                    – Wunschliste
     doppelte    {id, anzahl}            – zum Tauschen
   Sicherung: Export/Import als JSON-Datei (Fotos als data-URL)
   ================================================================ */

const MAX_KANTE = 800;
const JPEG_QUALITAET = 0.85;
const MAX_DOPPELTE = 20;
const ERINNERUNG_TAGE = 14;       // Punkt am ⚙️-Knopf, wenn so lange nicht gesichert
const EXPORT_KENNUNG = 'annas-glubschis';

// Farben pro Serie / Ansicht (nur für die Optik)
const FARBEN = {
  1: ['#a35cff', '#f1e4ff'], // Glitzer
  2: ['#ff4f8b', '#ffe1ec'], // Herz
  3: ['#22b55f', '#dcf7e8'], // Glücks
  4: ['#14a8b8', '#d8f5f8'], // Muschel
  5: ['#f29a00', '#fff0d1'], // Stern
  6: ['#ff6a3d', '#ffe6dc'], // Rainbow
  7: ['#c99700', '#fff4c7'], // Gold
  extra: ['#3f8cff', '#e0edff'],
  suche: ['#7a5cff', '#ece6ff'],
  wunsch: ['#e2559f', '#fde4f1'],
  tausch: ['#1f9e6a', '#d9f5e8'],
};

const TYP_NAME = { standard: 'Standard', limitiert: 'Takki', magazin: 'Magazin' };
const SELTEN_TEXT = { selten: 'Selten', super_selten: 'Super selten' };

const HERZ_SVG = (voll) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 3 4.5 6.7 4.5c2.2 0 3.7 1.2 5.3 3.1 1.6-1.9 3.1-3.1 5.3-3.1 3.7 0 5.8 3.9 4.3 7.3C19.5 16.4 12 21 12 21z"
    fill="${voll ? '#ff4f8b' : '#fff'}" stroke="${voll ? '#d92f6c' : '#f3a6c4'}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
const HERZ_TEXT = ['', 'Geht so', 'Ganz okay', 'Mag ich', 'Mag ich sehr', 'Absoluter Liebling!'];

const STERN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#f5b800" stroke="#c98a00" stroke-width="1.2" stroke-linejoin="round" d="M12 2.5l2.9 6 6.6.8-4.9 4.6 1.3 6.5L12 17.2l-5.9 3.2 1.3-6.5L2.5 9.3l6.6-.8z"/></svg>';

/* ---------- kleine Helfer ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function merken(key, wert) { try { localStorage.setItem(key, wert); } catch (_) {} }
function holen(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }

const anzahl = (n, eins, viele) => `${n} ${n === 1 ? eins : viele}`;
const basisTier = (f) => f.tier.split('(')[0].trim();
const klein = (s) => s.toLocaleLowerCase('de');

/* ---------- Speicher (IndexedDB) ---------- */
const FAECHER = ['fotos', 'bewertungen', 'wunsch', 'doppelte'];
let dbPromise;
function dbOeffnen() {
  if (!dbPromise) {
    dbPromise = new Promise((ok, fehler) => {
      const r = indexedDB.open('glubschis', 3);
      r.onupgradeneeded = () => {
        const db = r.result;
        for (const name of FAECHER) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fehler(r.error);
      r.onblocked = () => zeigeMeldung('Bitte die App in anderen Fenstern schließen.');
    });
  }
  return dbPromise;
}
async function auftrag(name, modus, arbeit) {
  const db = await dbOeffnen();
  return new Promise((ok, fehler) => {
    const t = db.transaction(name, modus);
    const anfrage = arbeit(t.objectStore(name));
    t.oncomplete = () => ok(anfrage && anfrage.result);
    t.onerror = () => fehler(t.error);
    t.onabort = () => fehler(t.error || new Error('Abgebrochen'));
  });
}
function fach(name) {
  return {
    alle: () => auftrag(name, 'readonly', (s) => s.getAll()),
    speichern: (eintrag) => auftrag(name, 'readwrite', (s) => s.put(eintrag)),
    loeschen: (id) => auftrag(name, 'readwrite', (s) => s.delete(id)),
  };
}
const DB = fach('fotos');
const BEWERTUNG_DB = fach('bewertungen');
const WUNSCH_DB = fach('wunsch');
const DOPPELT_DB = fach('doppelte');

/* ---------- Zustand ---------- */
let figuren = [];                // alle sichtbaren Figuren
let figurNachId = new Map();
const fotos = new Map();         // id -> { blob, url }
const bewertungen = new Map();   // id -> 1..5
const wuensche = new Set();      // ids
const doppelte = new Map();      // id -> Anzahl
let gruppen = [];                // Reiter
let aktiveGruppe = holen('reiter') || '1';
let detailListe = [];            // Figuren der aktuellen Ansicht (zum Blättern)
let detailIndex = -1;
let suchText = '';
let tierFilter = '';
let tierarten = [];              // [[Tier, Anzahl], …]

/* ---------- Start ---------- */
async function start() {
  try {
    const antwort = await fetch('daten.json');
    const daten = await antwort.json();
    figuren = daten.filter((f) => f.status === 'bestätigt');
    figurNachId = new Map(figuren.map((f) => [f.id, f]));
  } catch (e) {
    $('inhalt').innerHTML = '<p class="leer">Die Figurenliste konnte nicht geladen werden.</p>';
    return;
  }

  await allesAusSpeicherLaden();

  const zaehlung = new Map();
  for (const f of figuren) zaehlung.set(basisTier(f), (zaehlung.get(basisTier(f)) || 0) + 1);
  tierarten = [...zaehlung].sort((a, b) => a[0].localeCompare(b[0], 'de'));

  gruppenBauen();
  if (!gruppen.some((g) => g.key === aktiveGruppe)) aktiveGruppe = '1';
  allesZeichnen();

  // Den Browser bitten, die Fotos nicht automatisch wegzuräumen
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

async function allesAusSpeicherLaden() {
  for (const { url } of fotos.values()) URL.revokeObjectURL(url);
  fotos.clear(); bewertungen.clear(); wuensche.clear(); doppelte.clear();
  try {
    for (const e of await DB.alle()) fotos.set(e.id, { blob: e.blob, url: URL.createObjectURL(e.blob) });
  } catch (e) {
    zeigeMeldung('Fotos konnten nicht geladen werden.');
  }
  try {
    for (const e of await BEWERTUNG_DB.alle()) bewertungen.set(e.id, e.herzen);
    for (const e of await WUNSCH_DB.alle()) wuensche.add(e.id);
    for (const e of await DOPPELT_DB.alle()) doppelte.set(e.id, e.anzahl);
  } catch (e) { /* ohne Zusatzinfos weitermachen */ }
}

function gruppenBauen() {
  const serien = [...new Set(figuren.filter((f) => f.typ === 'standard').map((f) => f.serie))].sort((a, b) => a - b);
  gruppen = [{ key: 'suche', kurz: '🔍 Suchen', titel: 'Suchen', farbe: FARBEN.suche, spezial: true }];
  for (const s of serien) {
    const liste = figuren.filter((f) => f.typ === 'standard' && f.serie === s);
    gruppen.push({
      key: String(s),
      kurz: `Serie ${s}`,
      titel: `Serie ${s} · ${liste[0].edition}`,
      farbe: FARBEN[s] || FARBEN.extra,
      figuren: sortiert(liste),
    });
  }
  const extras = figuren.filter((f) => f.typ !== 'standard');
  if (extras.length) {
    gruppen.push({ key: 'extra', kurz: 'Extras', titel: 'Extras', farbe: FARBEN.extra, figuren: sortiert(extras) });
  }
  gruppen.push(
    { key: 'wunsch', kurz: '💭 Wünsche', titel: 'Meine Wunschliste', farbe: FARBEN.wunsch, spezial: true },
    { key: 'tausch', kurz: '🔁 Tauschen', titel: 'Doppelte zum Tauschen', farbe: FARBEN.tausch, spezial: true },
  );
}

function sortiert(liste) {
  return [...liste].sort((a, b) => a.name.localeCompare(b.name, 'de'));
}
// Für Listen über alle Serien: erst Serie, dann Name
function nachSerie(liste) {
  return [...liste].sort((a, b) => (a.serie || 99) - (b.serie || 99) || a.name.localeCompare(b.name, 'de'));
}

const hatFoto = (f) => fotos.has(f.id);
const gezaehlt = (liste) => liste.filter(hatFoto).length;
const gruppeVon = (f) => gruppen.find((g) => !g.spezial && g.figuren.some((x) => x.id === f.id));
const summeDoppelte = () => [...doppelte.values()].reduce((a, b) => a + b, 0);

function suchTreffer() {
  const q = klein(suchText.trim());
  if (!q && !tierFilter) return [];
  return nachSerie(figuren.filter((f) =>
    (!tierFilter || basisTier(f) === tierFilter) &&
    (!q || klein(f.name).includes(q) || klein(f.tier).includes(q))));
}

// Figuren in der Reihenfolge, in der die aktuelle Ansicht sie zeigt
function aktuelleListe() {
  switch (aktiveGruppe) {
    case 'suche': return suchTreffer();
    case 'wunsch': return nachSerie(figuren.filter((f) => wuensche.has(f.id)));
    case 'tausch': return nachSerie(figuren.filter((f) => doppelte.get(f.id) > 0));
    case 'extra': {
      const g = gruppen.find((x) => x.key === 'extra');
      return ['limitiert', 'magazin'].flatMap((t) => g.figuren.filter((f) => f.typ === t));
    }
    default: return gruppen.find((x) => x.key === aktiveGruppe).figuren;
  }
}

/* ---------- Zeichnen ---------- */
function allesZeichnen() {
  zaehlerZeichnen();
  reiterZeichnen();
  inhaltZeichnen();
  erinnerungZeichnen();
}

function zaehlerZeichnen() {
  const teile = [];
  for (const typ of ['standard', 'limitiert', 'magazin']) {
    const liste = figuren.filter((f) => f.typ === typ);
    if (!liste.length) continue;
    teile.push(`<span class="zahl">${TYP_NAME[typ]}: <b>${gezaehlt(liste)}</b> von ${liste.length}</span>`);
  }
  $('zaehler').innerHTML = teile.join('');
}

function reiterZahl(g) {
  if (g.key === 'suche') return 'Name · Tier';
  if (g.key === 'wunsch') return String(wuensche.size);
  if (g.key === 'tausch') return String(summeDoppelte());
  return `${gezaehlt(g.figuren)} / ${g.figuren.length}`;
}

function reiterZeichnen() {
  $('reiter').innerHTML = gruppen.map((g) => {
    const fertig = !g.spezial && gezaehlt(g.figuren) === g.figuren.length ? ' fertig' : '';
    return `<button type="button" role="tab" data-key="${g.key}" class="${fertig}${g.spezial ? ' spezial' : ''}"
      aria-selected="${g.key === aktiveGruppe}" style="--rf:${g.farbe[0]}">
      <span class="r-name">${esc(g.kurz)}</span>
      <span class="r-zahl">${esc(reiterZahl(g))}</span>
    </button>`;
  }).join('');
}

function farbenSetzen(farbe) {
  document.documentElement.style.setProperty('--farbe', farbe[0]);
  document.documentElement.style.setProperty('--farbe-hell', farbe[1]);
}

function inhaltZeichnen() {
  const g = gruppen.find((x) => x.key === aktiveGruppe);
  farbenSetzen(g.farbe);
  if (g.key === 'suche') return sucheZeichnen();
  if (g.key === 'wunsch') return wunschZeichnen();
  if (g.key === 'tausch') return tauschZeichnen();

  const n = gezaehlt(g.figuren);
  const prozent = Math.round((n / g.figuren.length) * 100);
  let html = `<section class="serie-kopf">
      <h2>${esc(g.titel)}</h2>
      <div class="balken" role="progressbar" aria-valuemin="0" aria-valuemax="${g.figuren.length}" aria-valuenow="${n}">
        <div style="width:${prozent}%"></div>
      </div>
      <div class="fortschritt"><b>${n}</b> von ${g.figuren.length} gesammelt${n === g.figuren.length ? ' – komplett! 🎉' : ''}</div>
    </section>`;

  if (g.key === 'extra') {
    // Takki und Magazin getrennt zeigen
    for (const typ of ['limitiert', 'magazin']) {
      const liste = g.figuren.filter((f) => f.typ === typ);
      if (!liste.length) continue;
      html += `<h3 class="unterkopf">${TYP_NAME[typ]} (${gezaehlt(liste)} von ${liste.length})</h3>`;
      html += gitter(liste);
    }
  } else {
    html += gitter(g.figuren);
  }
  $('inhalt').innerHTML = html;
}

function wunschZeichnen() {
  const liste = aktuelleListe();
  let html = `<section class="serie-kopf">
      <h2>💭 Meine Wunschliste</h2>
      <div class="fortschritt">${liste.length
        ? `<b>${liste.length}</b> ${liste.length === 1 ? 'Glubschi wünschst' : 'Glubschis wünschst'} du dir`
        : 'Noch keine Wünsche'}</div>
    </section>`;
  html += liste.length
    ? gitter(liste, { serieZeigen: true })
    : `<p class="leer">Tipp auf eine Figur mit <b>?</b> und dann auf<br><b>„💭 Wünsche ich mir“</b>.</p>`;
  $('inhalt').innerHTML = html;
}

function tauschZeichnen() {
  const liste = aktuelleListe();
  const summe = summeDoppelte();
  let html = `<section class="serie-kopf">
      <h2>🔁 Doppelte zum Tauschen</h2>
      <div class="fortschritt">${summe
        ? `<b>${summe}</b> ${summe === 1 ? 'Figur' : 'Figuren'} zum Tauschen`
        : 'Noch nichts zum Tauschen'}</div>
    </section>`;
  html += liste.length
    ? gitter(liste, { serieZeigen: true })
    : `<p class="leer">Hast du einen Glubschi doppelt? Öffne ihn und<br>tipp bei <b>„Doppelte zum Tauschen“</b> auf <b>+</b>.</p>`;
  $('inhalt').innerHTML = html;
}

function sucheZeichnen() {
  $('inhalt').innerHTML = `<section class="serie-kopf such-kopf">
      <h2>🔍 Glubschi suchen</h2>
      <input type="search" id="suchfeld" class="suchfeld" placeholder="Name oder Tier, z. B. Katze"
        value="${esc(suchText)}" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search"
        aria-label="Glubschi suchen">
    </section>
    <div id="such-ergebnis"></div>`;
  sucheErgebnisZeichnen();
}

function sucheErgebnisZeichnen() {
  const ziel = $('such-ergebnis');
  if (!ziel) return;
  let html = '';
  if (tierFilter) {
    html += `<div class="filter-aktiv">Tierart: <button type="button" class="chip an" data-tier="">
      ${esc(tierFilter)} <span aria-hidden="true">✕</span><span class="sr">Filter entfernen</span></button></div>`;
  }
  if (!suchText.trim() && !tierFilter) {
    html += '<h3 class="unterkopf">Oder tipp auf eine Tierart:</h3><div class="chips">';
    html += tierarten.map(([tier, n]) =>
      `<button type="button" class="chip" data-tier="${esc(tier)}">${esc(tier)} <span class="chip-zahl">${n}</span></button>`).join('');
    html += '</div>';
  } else {
    const treffer = suchTreffer();
    html += `<p class="treffer">${treffer.length ? `<b>${treffer.length}</b> Treffer` : 'Nichts gefunden 🙈'}</p>`;
    html += gitter(treffer, { serieZeigen: true });
  }
  ziel.innerHTML = html;
}

function sterne(f) {
  if (f.seltenheit === 'super_selten') return STERN_SVG + STERN_SVG;
  if (f.seltenheit === 'selten' || f.sonderfigur === 'ja') return STERN_SVG;
  return '';
}

function serieKurz(f) {
  return f.typ === 'standard' ? `Serie ${f.serie}` : TYP_NAME[f.typ];
}

function gitter(liste, { serieZeigen = false } = {}) {
  return '<div class="gitter">' + liste.map((f) => {
    const foto = fotos.get(f.id);
    const st = sterne(f);
    const n2 = doppelte.get(f.id) || 0;
    const wunsch = wuensche.has(f.id);
    const klasse = ['kachel', foto ? 'hat' : 'fehlt', f.seltenheit !== 'normal' ? f.seltenheit : (f.sonderfigur === 'ja' ? 'selten' : '')].join(' ');
    const bild = foto
      ? `<img src="${foto.url}" alt="" loading="lazy">`
      : '<span class="fragezeichen" aria-hidden="true">?</span>';
    const farbe = (FARBEN[f.serie] || FARBEN.extra)[0];
    const label = [f.name, foto ? 'gesammelt' : 'fehlt noch', SELTEN_TEXT[f.seltenheit], wunsch && 'auf der Wunschliste',
      n2 && `${n2} doppelt`, bewertungen.has(f.id) && `${bewertungen.get(f.id)} Herzen`].filter(Boolean).join(', ');
    return `<button type="button" class="${klasse}" data-id="${f.id}" aria-label="${esc(label)}">
      ${st ? `<span class="sterne">${st}</span>` : ''}
      ${foto ? '<span class="haken" aria-hidden="true">✓</span>' : ''}
      <span class="bild">${bild}
        ${wunsch && !foto ? '<span class="k-wunsch" aria-hidden="true">💭</span>' : ''}
        ${n2 ? `<span class="k-doppelt" aria-hidden="true">🔁 ${n2}</span>` : ''}
      </span>
      <span class="name">${esc(f.name)}</span>
      ${serieZeigen ? `<span class="k-serie" style="--sf:${farbe}">${esc(serieKurz(f))}</span>` : ''}
      ${bewertungen.has(f.id) ? `<span class="k-herzen" aria-hidden="true">${HERZ_SVG(true)}<b>${bewertungen.get(f.id)}</b></span>` : ''}
    </button>`;
  }).join('') + '</div>';
}

/* ---------- Detailansicht ---------- */
function detailOeffnen(id) {
  detailListe = aktuelleListe();
  detailIndex = detailListe.findIndex((f) => f.id === id);
  if (detailIndex < 0) return;
  detailZeichnen();
  const d = $('detail');
  if (!d.open) d.showModal();
}

function detailZeichnen() {
  const f = detailListe[detailIndex];
  const foto = fotos.get(f.id);
  // In Sonder-Ansichten bekommt die Detailkarte die Farbe der Serie der Figur
  const g = gruppen.find((x) => x.key === aktiveGruppe);
  $('detail').style.setProperty('--farbe', (g.spezial ? (FARBEN[f.serie] || FARBEN.extra) : g.farbe)[0]);
  $('detail').style.setProperty('--farbe-hell', (g.spezial ? (FARBEN[f.serie] || FARBEN.extra) : g.farbe)[1]);

  $('d-bild').innerHTML = foto
    ? `<img src="${foto.url}" alt="Foto von ${esc(f.name)}">`
    : '<span class="fragezeichen" aria-hidden="true">?</span>';
  $('d-name').textContent = f.name;

  const abz = [];
  abz.push(foto
    ? '<span class="abzeichen gesammelt">✓ Gesammelt</span>'
    : '<span class="abzeichen fehlt">Fehlt noch</span>');
  if (f.seltenheit === 'super_selten') abz.push(`<span class="abzeichen super_selten">${STERN_SVG}${STERN_SVG} Super selten</span>`);
  if (f.seltenheit === 'selten') abz.push(`<span class="abzeichen selten">${STERN_SVG} Selten</span>`);
  if (f.sonderfigur === 'ja') abz.push('<span class="abzeichen sonder">✨ Sonderfigur</span>');
  $('d-abzeichen').innerHTML = abz.join('');
  herzenZeichnen(f);
  extraZeichnen(f);

  const infos = [['Tierart', f.tier]];
  if (f.typ === 'standard') infos.push(['Serie', `Serie ${f.serie}`], ['Edition', f.edition]);
  else infos.push(['Art', TYP_NAME[f.typ] + '-Figur'], ['Edition', f.edition]);
  $('d-infos').innerHTML = infos.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  $('d-loeschen').hidden = !foto;
  $('d-kamera').previousElementSibling.textContent = foto ? 'Neues Foto' : 'Foto machen';
  $('d-sicher').hidden = true;
  $('d-knoepfe').hidden = false;
  $('d-zurueck').disabled = detailIndex <= 0;
  $('d-weiter').disabled = detailIndex >= detailListe.length - 1;
}

// Wunschliste (ohne Foto) bzw. Doppelte (mit Foto)
function extraZeichnen(f) {
  if (!fotos.has(f.id)) {
    const an = wuensche.has(f.id);
    $('d-extra').innerHTML = `<button type="button" class="knopf wunsch-knopf${an ? ' an' : ''}" id="d-wunsch" aria-pressed="${an}">
        <span aria-hidden="true">💭</span> ${an ? 'Steht auf meiner Wunschliste ✓' : 'Wünsche ich mir'}
      </button>`;
  } else {
    const n = doppelte.get(f.id) || 0;
    $('d-extra').innerHTML = `<div class="doppelt-zeile">
        <span class="doppelt-text">🔁 Doppelte zum Tauschen</span>
        <span class="zaehlwerk">
          <button type="button" class="rund" data-schritt="-1" aria-label="Eine weniger" ${n ? '' : 'disabled'}>−</button>
          <b aria-live="polite">${n}</b>
          <button type="button" class="rund" data-schritt="1" aria-label="Eine mehr" ${n >= MAX_DOPPELTE ? 'disabled' : ''}>+</button>
        </span>
      </div>`;
  }
}

function blaettern(schritt) {
  const neu = detailIndex + schritt;
  if (neu < 0 || neu >= detailListe.length) return;
  detailIndex = neu;
  detailZeichnen();
}

/* ---------- Fotos ---------- */
function bildLaden(datei) {
  return new Promise((ok, fehler) => {
    const url = URL.createObjectURL(datei);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); fehler(new Error('Bild unlesbar')); };
    img.src = url;
  });
}

const istHeic = (datei) =>
  /hei[cf]/i.test(datei.type || '') || /\.hei[cf]$/i.test(datei.name || '');

// HEIC-Umwandler (heic-to, aktuelles libheif) nur laden, wenn er gebraucht wird.
// Liegt lokal neben der App (heic-to.js), klappt also auch offline.
let heicLader;
function heicUmwandlerLaden() {
  if (!heicLader) {
    heicLader = new Promise((ok, fehler) => {
      const s = document.createElement('script');
      s.src = 'heic-to.js';
      s.onload = () => (window.HeicTo ? ok(window.HeicTo) : fehler(new Error('HeicTo fehlt')));
      s.onerror = () => { heicLader = null; fehler(new Error('heic-to nicht ladbar')); };
      document.head.appendChild(s);
    });
  }
  return heicLader;
}

async function bildLesen(datei) {
  try {
    return await bildLaden(datei); // Safari kann HEIC direkt
  } catch (e) {
    const heicTo = await heicUmwandlerLaden().catch(() => null);
    const heic = istHeic(datei) || (heicTo && (await heicTo.isHeic(datei).catch(() => false)));
    if (!heic || !heicTo) throw e;
    zeigeMeldung('⏳ iPhone-Foto wird umgewandelt …', 15000);
    const jpeg = await heicTo({ blob: datei, type: 'image/jpeg', quality: 0.92 });
    return bildLaden(jpeg);
  }
}

async function verkleinern(datei) {
  const img = await bildLesen(datei); // Browser drehen das Bild dabei richtig herum (EXIF)
  const w0 = img.naturalWidth, h0 = img.naturalHeight;
  const faktor = Math.min(1, MAX_KANTE / Math.max(w0, h0));
  const w = Math.round(w0 * faktor), h = Math.round(h0 * faktor);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  const blob = await new Promise((ok) => canvas.toBlob(ok, 'image/jpeg', JPEG_QUALITAET));
  if (!blob) throw new Error('Bild konnte nicht gespeichert werden');
  return blob;
}

async function fotoSetzen(datei) {
  if (!datei) return;
  const f = detailListe[detailIndex];
  const karte = document.querySelector('#detail .d-karte');
  karte.classList.add('d-arbeitet');
  try {
    const war = fotos.get(f.id);
    const blob = await verkleinern(datei);
    await DB.speichern({ id: f.id, blob, geaendert: Date.now() });
    if (war) URL.revokeObjectURL(war.url);
    fotos.set(f.id, { blob, url: URL.createObjectURL(blob) });

    // Wunsch erfüllt → von der Wunschliste streichen
    const warGewuenscht = wuensche.delete(f.id);
    if (warGewuenscht) await WUNSCH_DB.loeschen(f.id).catch(() => {});

    allesZeichnen();
    detailZeichnen();

    if (!war) {
      const g = gruppeVon(f);
      if (g && gezaehlt(g.figuren) === g.figuren.length) zeigeMeldung(`🎉 Juhu! ${g.titel} ist komplett!`, 4000);
      else if (warGewuenscht) zeigeMeldung(`🎉 Wunsch erfüllt! ${f.name} ist jetzt in deiner Sammlung!`, 3500);
      else zeigeMeldung(`🎉 ${f.name} ist jetzt in deiner Sammlung!`);
    } else {
      zeigeMeldung('📷 Neues Foto gespeichert');
    }
  } catch (e) {
    console.error(e);
    zeigeMeldung('😕 Das Foto hat nicht geklappt. Versuch es nochmal!');
  } finally {
    karte.classList.remove('d-arbeitet');
  }
}

async function fotoLoeschen() {
  const f = detailListe[detailIndex];
  try {
    await DB.loeschen(f.id);
    const war = fotos.get(f.id);
    if (war) URL.revokeObjectURL(war.url);
    fotos.delete(f.id);
    allesZeichnen();
    detailZeichnen();
    zeigeMeldung('Foto gelöscht');
  } catch (e) {
    zeigeMeldung('😕 Löschen hat nicht geklappt.');
  }
}

/* ---------- Bewertung, Wunsch, Doppelte ---------- */
function herzenZeichnen(f) {
  const wert = bewertungen.get(f.id) || 0;
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += `<button type="button" class="herz" data-wert="${i}" role="radio"
      aria-checked="${i === wert}" aria-label="${i} ${i === 1 ? 'Herz' : 'Herzen'}">${HERZ_SVG(i <= wert)}</button>`;
  }
  $('d-herzen').innerHTML = html;
  $('d-herz-text').textContent = wert ? HERZ_TEXT[wert] : 'Wie lieb hast du ihn? Tipp auf ein Herz!';
}

async function bewerten(wert) {
  const f = detailListe[detailIndex];
  const alt = bewertungen.get(f.id) || 0;
  const neu = wert === alt ? 0 : wert; // gleiches Herz nochmal = Bewertung weg
  try {
    if (neu) {
      await BEWERTUNG_DB.speichern({ id: f.id, herzen: neu });
      bewertungen.set(f.id, neu);
    } else {
      await BEWERTUNG_DB.loeschen(f.id);
      bewertungen.delete(f.id);
    }
    herzenZeichnen(f);
    inhaltZeichnen();
    if (neu) $('d-herzen').querySelector(`[data-wert="${neu}"]`).classList.add('hopp');
  } catch (e) {
    zeigeMeldung('😕 Bewertung hat nicht geklappt.');
  }
}

async function wunschUmschalten() {
  const f = detailListe[detailIndex];
  try {
    if (wuensche.has(f.id)) {
      await WUNSCH_DB.loeschen(f.id);
      wuensche.delete(f.id);
    } else {
      await WUNSCH_DB.speichern({ id: f.id });
      wuensche.add(f.id);
      zeigeMeldung(`💭 ${f.name} steht jetzt auf deiner Wunschliste`);
    }
    extraZeichnen(f);
    reiterZeichnen();
    inhaltZeichnen();
  } catch (e) {
    zeigeMeldung('😕 Das hat nicht geklappt.');
  }
}

async function doppelteAendern(schritt) {
  const f = detailListe[detailIndex];
  const neu = Math.max(0, Math.min(MAX_DOPPELTE, (doppelte.get(f.id) || 0) + schritt));
  try {
    if (neu) {
      await DOPPELT_DB.speichern({ id: f.id, anzahl: neu });
      doppelte.set(f.id, neu);
    } else {
      await DOPPELT_DB.loeschen(f.id);
      doppelte.delete(f.id);
    }
    extraZeichnen(f);
    reiterZeichnen();
    inhaltZeichnen();
  } catch (e) {
    zeigeMeldung('😕 Das hat nicht geklappt.');
  }
}

/* ---------- Sichern & Laden (Export / Import) ---------- */
function blobZuDataUrl(blob) {
  return new Promise((ok, fehler) => {
    const r = new FileReader();
    r.onload = () => ok(r.result);
    r.onerror = () => fehler(r.error);
    r.readAsDataURL(blob);
  });
}

async function dataUrlZuBlob(url) {
  const [kopf, daten] = url.split(',');
  const typ = (kopf.match(/^data:([^;]+)/) || [])[1] || 'image/jpeg';
  const bytes = atob(daten);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: typ });
}

function datumHeute() {
  const d = new Date();
  const zwei = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${zwei(d.getMonth() + 1)}-${zwei(d.getDate())}`;
}

async function exportieren() {
  const knopf = $('m-export');
  knopf.disabled = true;
  try {
    const eintraege = [];
    for (const f of figuren) {
      const e = { id: f.id, name: f.name };
      if (fotos.has(f.id)) e.foto = await blobZuDataUrl(fotos.get(f.id).blob);
      if (bewertungen.has(f.id)) e.herzen = bewertungen.get(f.id);
      if (wuensche.has(f.id)) e.wunsch = true;
      if (doppelte.has(f.id)) e.doppelte = doppelte.get(f.id);
      if (Object.keys(e).length > 2) eintraege.push(e);
    }
    const inhalt = {
      app: EXPORT_KENNUNG,
      format: 1,
      erstellt: new Date().toISOString(),
      anzahlFotos: fotos.size,
      figuren: eintraege,
    };
    const name = `glubschis-sicherung-${datumHeute()}.json`;
    const datei = new File([JSON.stringify(inhalt)], name, { type: 'application/json' });

    // Auf Tablet/Handy: Teilen-Menü („In Dateien sichern“, AirDrop …); sonst normaler Download
    const touch = window.matchMedia('(pointer: coarse)').matches;
    let geteilt = false;
    if (touch && navigator.canShare && navigator.canShare({ files: [datei] })) {
      try {
        await navigator.share({ files: [datei], title: 'Glubschi-Sicherung' });
        geteilt = true;
      } catch (e) {
        if (e.name === 'AbortError') return; // abgebrochen → nichts tun
      }
    }
    if (!geteilt) {
      const url = URL.createObjectURL(datei);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    }
    merken('letzteSicherung', String(Date.now()));
    menueInfoZeichnen();
    erinnerungZeichnen();
    zeigeMeldung(`💾 Gesichert: ${fotos.size} ${fotos.size === 1 ? 'Foto' : 'Fotos'}`);
  } catch (e) {
    console.error(e);
    zeigeMeldung('😕 Sichern hat nicht geklappt.');
  } finally {
    knopf.disabled = false;
  }
}

let importBereit = null; // geprüfter Inhalt, wartet auf „Ja, laden“

async function importPruefen(datei) {
  if (!datei) return;
  try {
    const inhalt = JSON.parse(await datei.text());
    if (!inhalt || inhalt.app !== EXPORT_KENNUNG || !Array.isArray(inhalt.figuren)) throw new Error('fremd');
    const bekannt = inhalt.figuren.filter((e) => figurNachId.has(e.id));
    const z = {
      fotos: bekannt.filter((e) => typeof e.foto === 'string' && e.foto.startsWith('data:image/')).length,
      herzen: bekannt.filter((e) => e.herzen >= 1 && e.herzen <= 5).length,
      wunsch: bekannt.filter((e) => e.wunsch === true).length,
      doppelte: bekannt.filter((e) => e.doppelte > 0).length,
      unbekannt: inhalt.figuren.length - bekannt.length,
    };
    importBereit = bekannt;
    const ueberschreibt = bekannt.filter((e) => e.foto && fotos.has(e.id)).length;
    const datum = inhalt.erstellt ? new Date(inhalt.erstellt).toLocaleDateString('de-DE') : '?';
    $('m-frage-text').innerHTML = `Sicherung vom <b>${esc(datum)}</b>:<br>
      ${anzahl(z.fotos, 'Foto', 'Fotos')} · ${anzahl(z.herzen, 'Bewertung', 'Bewertungen')} ·
      ${anzahl(z.wunsch, 'Wunsch', 'Wünsche')} · ${anzahl(z.doppelte, 'Figur', 'Figuren')} mit Doppelten
      ${ueberschreibt ? `<br><small>${ueberschreibt === 1 ? '1 Foto hier wird' : `${ueberschreibt} Fotos hier werden`} durch die aus der Sicherung ersetzt.</small>` : ''}
      ${z.unbekannt ? `<br><small>${anzahl(z.unbekannt, 'Eintrag passt', 'Einträge passen')} zu keiner Figur und ${z.unbekannt === 1 ? 'wird' : 'werden'} übersprungen.</small>` : ''}
      <br><small>Alles andere auf diesem Gerät bleibt erhalten.</small>`;
    $('m-frage').hidden = false;
    $('m-aktionen').hidden = true;
  } catch (e) {
    importBereit = null;
    zeigeMeldung('😕 Das ist keine Glubschi-Sicherung.', 3500);
  }
}

async function importAusfuehren() {
  if (!importBereit) return;
  const liste = importBereit;
  importBereit = null;
  $('m-ja').disabled = true;
  let n = 0;
  try {
    for (const e of liste) {
      if (typeof e.foto === 'string' && e.foto.startsWith('data:image/')) {
        await DB.speichern({ id: e.id, blob: await dataUrlZuBlob(e.foto), geaendert: Date.now() });
        await WUNSCH_DB.loeschen(e.id);
        n++;
      }
      if (e.herzen >= 1 && e.herzen <= 5) await BEWERTUNG_DB.speichern({ id: e.id, herzen: Math.round(e.herzen) });
      if (e.wunsch === true && !e.foto && !fotos.has(e.id)) await WUNSCH_DB.speichern({ id: e.id });
      if (e.doppelte > 0) await DOPPELT_DB.speichern({ id: e.id, anzahl: Math.min(MAX_DOPPELTE, Math.round(e.doppelte)) });
    }
    await allesAusSpeicherLaden();
    allesZeichnen();
    menueInfoZeichnen();
    zeigeMeldung(`📂 Sicherung geladen: ${n} ${n === 1 ? 'Foto' : 'Fotos'}`, 3500);
    $('menue').close();
  } catch (err) {
    console.error(err);
    await allesAusSpeicherLaden();
    allesZeichnen();
    zeigeMeldung('😕 Laden hat nicht ganz geklappt.', 3500);
  } finally {
    $('m-ja').disabled = false;
    $('m-frage').hidden = true;
    $('m-aktionen').hidden = false;
  }
}

function letzteSicherung() {
  const t = Number(holen('letzteSicherung'));
  return t > 0 ? t : null;
}

function erinnerungZeichnen() {
  const t = letzteSicherung();
  const faellig = fotos.size > 0 && (!t || Date.now() - t > ERINNERUNG_TAGE * 864e5);
  $('menue-punkt').hidden = !faellig;
}

async function menueInfoZeichnen() {
  const t = letzteSicherung();
  let text = `Auf diesem Gerät: <b>${fotos.size}</b> ${fotos.size === 1 ? 'Foto' : 'Fotos'}<br>
    Letzte Sicherung: <b>${t ? new Date(t).toLocaleDateString('de-DE') : 'noch nie'}</b>`;
  try {
    const s = await navigator.storage.estimate();
    if (s && s.usage) text += `<br>Belegter Speicher: ${(s.usage / 1048576).toFixed(1).replace('.', ',')} MB`;
  } catch (_) { /* egal */ }
  $('m-info').innerHTML = text;
}

/* ---------- Meldung ---------- */
let meldungTimer;
function zeigeMeldung(text, dauer = 2800) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('zeigen');
  clearTimeout(meldungTimer);
  meldungTimer = setTimeout(() => t.classList.remove('zeigen'), dauer);
}

/* ---------- Ereignisse ---------- */
$('reiter').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-key]');
  if (!b) return;
  aktiveGruppe = b.dataset.key;
  merken('reiter', aktiveGruppe);
  reiterZeichnen();
  inhaltZeichnen();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  $('reiter').querySelector(`[data-key="${aktiveGruppe}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
});

$('inhalt').addEventListener('click', (e) => {
  const k = e.target.closest('.kachel');
  if (k) return detailOeffnen(Number(k.dataset.id));
  const chip = e.target.closest('.chip');
  if (chip) {
    // Tierart antippen ersetzt den Suchtext (und umgekehrt) – nie beides gleichzeitig
    tierFilter = chip.dataset.tier;
    if (tierFilter) { suchText = ''; $('suchfeld').value = ''; }
    sucheErgebnisZeichnen();
  }
});

$('inhalt').addEventListener('input', (e) => {
  if (e.target.id !== 'suchfeld') return;
  suchText = e.target.value;
  if (suchText.trim()) tierFilter = '';
  sucheErgebnisZeichnen();
});
$('inhalt').addEventListener('keydown', (e) => {
  if (e.target.id === 'suchfeld' && e.key === 'Enter') e.target.blur(); // Tastatur zu
});

$('d-zu').addEventListener('click', () => $('detail').close());
$('d-zurueck').addEventListener('click', () => blaettern(-1));
$('d-weiter').addEventListener('click', () => blaettern(1));
$('detail').addEventListener('click', (e) => { if (e.target === $('detail')) $('detail').close(); });
$('detail').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') blaettern(-1);
  if (e.key === 'ArrowRight') blaettern(1);
});

for (const id of ['d-kamera', 'd-datei']) {
  $(id).addEventListener('change', (e) => {
    const datei = e.target.files && e.target.files[0];
    e.target.value = '';
    fotoSetzen(datei);
  });
}

$('d-herzen').addEventListener('click', (e) => {
  const b = e.target.closest('.herz');
  if (b) bewerten(Number(b.dataset.wert));
});

$('d-extra').addEventListener('click', (e) => {
  if (e.target.closest('#d-wunsch')) return wunschUmschalten();
  const b = e.target.closest('[data-schritt]');
  if (b) doppelteAendern(Number(b.dataset.schritt));
});

$('d-loeschen').addEventListener('click', () => {
  $('d-knoepfe').hidden = true;
  $('d-sicher').hidden = false;
});
$('d-nein').addEventListener('click', () => {
  $('d-sicher').hidden = true;
  $('d-knoepfe').hidden = false;
});
$('d-ja').addEventListener('click', fotoLoeschen);

// Menü „Sichern & Laden“
$('menue-knopf').addEventListener('click', () => {
  farbenSetzen(FARBEN.suche);
  $('m-frage').hidden = true;
  $('m-aktionen').hidden = false;
  menueInfoZeichnen();
  $('menue').showModal();
});
$('menue').addEventListener('close', () => {
  importBereit = null;
  inhaltZeichnen(); // Farben der Ansicht wiederherstellen
});
$('m-zu').addEventListener('click', () => $('menue').close());
$('menue').addEventListener('click', (e) => { if (e.target === $('menue')) $('menue').close(); });
$('m-export').addEventListener('click', exportieren);
$('m-import').addEventListener('change', (e) => {
  const datei = e.target.files && e.target.files[0];
  e.target.value = '';
  importPruefen(datei);
});
$('m-ja').addEventListener('click', importAusfuehren);
$('m-nein').addEventListener('click', () => {
  importBereit = null;
  $('m-frage').hidden = true;
  $('m-aktionen').hidden = false;
});

// Wischen in der Detailansicht
(() => {
  let x0 = null, y0 = null;
  const bild = $('d-bild');
  bild.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  bild.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) blaettern(dx < 0 ? 1 : -1);
    x0 = y0 = null;
  });
})();

start();
