
function setPayBtnBusy($btn, busy, idleLabel) {
  if (!$btn || !$btn.length) return;
  if (busy) {
    if (!$btn.data("idleLabel")) $btn.data("idleLabel", $btn.text());
    $btn.prop("disabled", true).addClass("is-busy")
      .html('<span class="btn-spinner" aria-hidden="true"></span> Verifying…');
  } else {
    $btn.prop("disabled", false).removeClass("is-busy")
      .text(idleLabel || $btn.data("idleLabel") || "Verify");
  }
}

function formatQuotaMb(mb){mb=Number(mb)||0;if(mb>=1024)return(mb/1024).toFixed(mb%1024===0?0:1)+' GB';return mb+' MB';}
var pendingIntentId = null;
var pendingIntentAmount = null;
/* NESS Burn — same design system & interaction grammar as TempMail */

let selectedPlanId = "free";
let planLocked = false;
let selectedFiles = [];
let lastVoiceFileName = null;
let activeWaAudio = null;

const BURN_DRAFT_KEY = "ness_burn_draft_v1";
const BURN_ACTIVE_KEY = "ness_burn_active_v1";
const BURN_LIBRARY_KEY = "ness_burn_library_v1";
const BURN_IDB_NAME = "ness_burn_idb";

const BURN_IDB_STORE = "files";

/* ── E2E content encryption (server stores ciphertext only) ─────────────
 * File format: 12-byte IV || AES-GCM ciphertext+tag
 * DEK wrap:
 *   - passphrase mode: PBKDF2-SHA256 → AES-GCM wrap of DEK
 *   - link mode: random 32-byte link key in URL #k= (never sent to server)
 */
var __burnLinkKey = null; // base64url, for open drops after publish
var __burnContentKey = null; // CryptoKey DEK while viewing

function burnB64urlEnc(buf) {
  var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function burnB64urlDec(str) {
  str = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  var bin = atob(str);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}
function burnB64Enc(buf) {
  var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function burnB64Dec(str) {
  var bin = atob(str);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

async function burnE2E_wrapDek(rawDek, passphrase) {
  if (passphrase) {
    var salt = crypto.getRandomValues(new Uint8Array(16));
    var iters = 120000;
    var base = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    var wrapKey = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: iters, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"]
    );
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, wrapKey, rawDek);
    return {
      mode: "passphrase",
      salt: burnB64Enc(salt),
      iters: iters,
      iv: burnB64Enc(iv),
      ct: burnB64Enc(ct),
    };
  }
  var linkKey = crypto.getRandomValues(new Uint8Array(32));
  var wk = await crypto.subtle.importKey("raw", linkKey, { name: "AES-GCM" }, false, ["encrypt"]);
  var iv2 = crypto.getRandomValues(new Uint8Array(12));
  var ct2 = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv2 }, wk, rawDek);
  return {
    wrap: {
      mode: "link",
      iv: burnB64Enc(iv2),
      ct: burnB64Enc(ct2),
    },
    linkKeyB64: burnB64urlEnc(linkKey),
  };
}

async function burnE2E_unwrapDek(encMeta, secret) {
  // secret = passphrase string OR link key ArrayBuffer
  var wrap = (encMeta && encMeta.wrap) || {};
  if (wrap.mode === "passphrase") {
    var salt = burnB64Dec(wrap.salt);
    var iters = parseInt(wrap.iters, 10) || 120000;
    var base = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(secret || "")), "PBKDF2", false, ["deriveKey"]);
    var wrapKey = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: iters, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
    var iv = burnB64Dec(wrap.iv);
    var ct = burnB64Dec(wrap.ct);
    var raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(iv) }, wrapKey, ct);
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  }
  if (wrap.mode === "link") {
    var lk = secret instanceof ArrayBuffer ? secret : burnB64urlDec(secret);
    var wk = await crypto.subtle.importKey("raw", lk, { name: "AES-GCM" }, false, ["decrypt"]);
    var ivL = burnB64Dec(wrap.iv);
    var ctL = burnB64Dec(wrap.ct);
    var rawL = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(ivL) }, wk, ctL);
    return crypto.subtle.importKey("raw", rawL, { name: "AES-GCM" }, false, ["decrypt"]);
  }
  throw new Error("Unknown wrap mode");
}

async function burnE2E_encryptFile(file, dek) {
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var buf = await file.arrayBuffer();
  var ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, dek, buf);
  var out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return new File([out], file.name, { type: file.type || "application/octet-stream" });
}

async function burnE2E_decryptBytes(cipherBuf, dek) {
  var u = new Uint8Array(cipherBuf);
  if (u.length < 13) throw new Error("ciphertext too short");
  var iv = u.slice(0, 12);
  var ct = u.slice(12);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, dek, ct);
}

async function burnE2E_buildEnvelope(fileList, passphrase) {
  if (!window.crypto || !crypto.subtle) throw new Error("WebCrypto unavailable");
  var dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  var outFiles = [];
  for (var i = 0; i < fileList.length; i++) {
    outFiles.push(await burnE2E_encryptFile(fileList[i], dek));
  }
  var rawDek = await crypto.subtle.exportKey("raw", dek);
  var linkKeyB64 = null;
  var wrap;
  if (passphrase) {
    wrap = await burnE2E_wrapDek(rawDek, passphrase);
  } else {
    var packed = await burnE2E_wrapDek(rawDek, null);
    wrap = packed.wrap;
    linkKeyB64 = packed.linkKeyB64;
  }
  return {
    files: outFiles,
    encMeta: { v: 1, alg: "AES-GCM-256", wrap: wrap },
    linkKeyB64: linkKeyB64,
  };
}

function burnLinkKeyFromLocation() {
  try {
    var h = String(location.hash || "");
    var m = h.match(/(?:^|[&#])k=([A-Za-z0-9_\-]+)/);
    return m ? m[1] : null;
  } catch (e) { return null; }
}

function burnSharePath(token, linkKeyB64) {
  var p = "/burn/d/" + token;
  if (linkKeyB64) p += "#k=" + linkKeyB64;
  return p;
}



let activeDrop = null;
let publisherReturnTo = null; // 'active' | 'mine' | null

let timerInterval = null;

function toast(msg, type) {
  type = type || "ok";
  const $t = $('<div class="toast ' + type + '"></div>').text(msg);
  $("#toasts").append($t);
  requestAnimationFrame(function () { $t.addClass("show"); });
  setTimeout(function () {
    $t.removeClass("show");
    setTimeout(function () { $t.remove(); }, 280);
  }, 3800);
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

function formatDuration(mins) {
  mins = Number(mins) || 0;
  if (mins < 60) return mins + " min";
  if (mins < 1440) return Math.round(mins / 60) + " h";
  return Math.round(mins / 1440) + " day" + (mins >= 2880 ? "s" : "");
}

function formatPrice(n) {
  n = Number(n) || 0;
  if (n <= 0) return "Free";
  return n.toLocaleString("en-US") + " NCH";
}

function formatRemain(iso) {
  const end = new Date(iso).getTime();
  const ms = end - Date.now();
  if (ms <= 0) return "Expired";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 48) return Math.floor(h / 24) + "d " + (h % 24) + "h";
  if (h > 0) return h + "h " + m + "m";
  return m + "m " + sec + "s";
}

function deviceId() {
  const k = "ness-device-id";
  let v = localStorage.getItem(k) || localStorage.getItem("ness_device_id") || localStorage.getItem("ness-tempmail-device");
  if (!v || v.length < 16) {
    v = Array.from(crypto.getRandomValues(new Uint8Array(16)))
      .map(function (b) { return b.toString(16).padStart(2, "0"); })
      .join("");
    localStorage.setItem(k, v);
    try { localStorage.setItem("ness_device_id", v); } catch (e) {}
    try { localStorage.setItem("ness-tempmail-device", v); } catch (e) {}
  }
  return v;
}

function ajaxHeaders() {
  return { "X-Device-Id": deviceId() };
}


function idbOpen() {
  return new Promise(function (resolve, reject) {
    if (!window.indexedDB) {
      resolve(null);
      return;
    }
    const req = indexedDB.open(BURN_IDB_NAME, 1);
    req.onupgradeneeded = function () {
      const db = req.result;
      if (!db.objectStoreNames.contains(BURN_IDB_STORE)) {
        db.createObjectStore(BURN_IDB_STORE);
      }
    };
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { resolve(null); };
  });
}

async function idbSaveFiles(files) {
  const db = await idbOpen();
  if (!db) return;
  if (window.NessVault && !NessVault.isUnlocked()) {
    await NessVault.ensureVault();
  }
  const payloads = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const buf = await f.arrayBuffer();
    let sealed = null;
    if (window.NessVault && NessVault.isUnlocked()) {
      sealed = await NessVault.encryptArrayBuffer(buf);
    } else {
      // Should not happen if vault init ran; refuse plaintext file cache
      console.warn("[burn] vault locked — skip file persist");
      continue;
    }
    payloads.push({
      name: f.name,
      type: f.type || "application/octet-stream",
      lastModified: f.lastModified || Date.now(),
      sealed: sealed,
    });
  }
  return new Promise(function (resolve) {
    const tx = db.transaction(BURN_IDB_STORE, "readwrite");
    tx.objectStore(BURN_IDB_STORE).put({ v: 2, enc: true, files: payloads }, "draft_files");
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { resolve(); };
  });
}

async function idbLoadFiles() {
  const db = await idbOpen();
  if (!db) return [];
  if (window.NessVault && !NessVault.isUnlocked()) {
    await NessVault.ensureVault();
  }
  return new Promise(function (resolve) {
    const tx = db.transaction(BURN_IDB_STORE, "readonly");
    const req = tx.objectStore(BURN_IDB_STORE).get("draft_files");
    req.onsuccess = async function () {
      try {
        const row = req.result;
        if (!row) { resolve([]); return; }
        // Legacy plaintext format (array of {buffer})
        if (Array.isArray(row)) {
          resolve([]); // drop legacy plaintext — force re-attach
          return;
        }
        const list = row.files || [];
        const out = [];
        for (let i = 0; i < list.length; i++) {
          const r = list[i];
          if (!r.sealed) continue;
          const buf = await NessVault.decryptToArrayBuffer(r.sealed);
          out.push(new File([buf], r.name, { type: r.type, lastModified: r.lastModified }));
        }
        resolve(out);
      } catch (e) {
        console.warn("[burn] decrypt files failed", e);
        resolve([]);
      }
    };
    req.onerror = function () { resolve([]); };
  });
}

async function idbClearFiles() {
  const db = await idbOpen();
  if (!db) return;
  return new Promise(function (resolve) {
    const tx = db.transaction(BURN_IDB_STORE, "readwrite");
    tx.objectStore(BURN_IDB_STORE).delete("draft_files");
    tx.oncomplete = function () { resolve(); };
    tx.onerror = function () { resolve(); };
  });
}

function saveBurnDraft() {
  (async function () {
    try {
      if (window.NessVault && !NessVault.isUnlocked()) {
        await NessVault.ensureVault();
      }
      const noteEl = document.getElementById("note-editor");
      const payload = {
        plan: selectedPlanId,
        planLocked: planLocked,
        noteHtml: noteEl ? noteEl.innerHTML : "",
        allow_view: $("#opt-allow-view").length ? $("#opt-allow-view").is(":checked") : true,
        allow_download: $("#opt-allow-download").length ? $("#opt-allow-download").is(":checked") : true,
        burn_after: $("#opt-burn-after").length ? $("#opt-burn-after").is(":checked") : true,
        voice_anon: $("#opt-voice-anon").length ? $("#opt-voice-anon").is(":checked") : true,
        saved_at: Date.now(),
      };
      if (window.NessVault && NessVault.isUnlocked()) {
        const sealed = await NessVault.encryptJson(payload);
        localStorage.setItem(BURN_DRAFT_KEY, JSON.stringify({ v: 2, enc: true, sealed: sealed }));
      }
    } catch (e) {
      console.warn("[burn] draft save", e);
    }
    if (selectedFiles.length) {
      idbSaveFiles(selectedFiles).catch(function () {});
    } else {
      idbClearFiles().catch(function () {});
    }
  })();
}

function clearBurnDraft() {
  try { localStorage.removeItem(BURN_DRAFT_KEY); } catch (e) {}
  idbClearFiles().catch(function () {});
}

function saveBurnActive(data) {
  (async function () {
    try {
      if (window.NessVault && !NessVault.isUnlocked()) await NessVault.ensureVault();
      const payload = {
        token: data.token,
        plan: data.plan,
        plan_label: data.plan_label,
        path: data.path || ("/burn/d/" + data.token),
        expires_at: data.expires_at,
        max_downloads: data.max_downloads,
        burn_after: data.burn_after,
        files: data.files || [],
        badge_class: data.badge_class || "",
        link_key: data.link_key || __burnLinkKey || null,
        saved_at: Date.now(),
      };
      // Fail closed: never persist capability tokens in plaintext
      if (!(window.NessVault && NessVault.isUnlocked())) return;
      const sealed = await NessVault.encryptJson(payload);
      localStorage.setItem(BURN_ACTIVE_KEY, JSON.stringify({ v: 2, enc: true, sealed: sealed }));
      try { await upsertBurnLibrary(payload); } catch (e3) {}
    } catch (e) {}
  })();
}

function loadBurnActiveSyncMeta() {
  try {
    const raw = localStorage.getItem(BURN_ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.enc) return { enc: true };
    // Legacy plaintext: wipe
    if (parsed && parsed.token && !parsed.enc) {
      try { localStorage.removeItem(BURN_ACTIVE_KEY); } catch (e2) {}
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function loadBurnActive() {
  try {
    if (window.NessVault && !NessVault.isUnlocked()) await NessVault.ensureVault();
    const raw = localStorage.getItem(BURN_ACTIVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.enc && parsed.sealed && window.NessVault && NessVault.isUnlocked()) {
      return await NessVault.decryptJson(parsed.sealed);
    }
    // Legacy plaintext active record: wipe — do not rehydrate secrets in clear
    if (parsed && parsed.token && !parsed.enc) {
      try { localStorage.removeItem(BURN_ACTIVE_KEY); } catch (e2) {}
    }
    return null;
  } catch (e) {
    return null;
  }
}

function clearBurnActive() {
  try { localStorage.removeItem(BURN_ACTIVE_KEY); } catch (e) {}
}

var _burnLibraryCache = null;

function readBurnLibrary() {
  // Sync cache only — never return decrypted-from-disk without hydrate
  if (_burnLibraryCache) return _burnLibraryCache.slice();
  try {
    var raw = localStorage.getItem(BURN_LIBRARY_KEY);
    if (!raw) return [];
    var parsed = JSON.parse(raw);
    // Encrypted envelope: wait for hydrateBurnLibrary()
    if (parsed && parsed.enc && parsed.sealed) return [];
    // Legacy plaintext list: wipe immediately (capability tokens)
    if (Array.isArray(parsed) && parsed.length) {
      try { localStorage.removeItem(BURN_LIBRARY_KEY); } catch (e2) {}
    }
    return [];
  } catch (e) { return []; }
}

async function hydrateBurnLibrary() {
  try {
    if (window.NessVault && !NessVault.isUnlocked()) await NessVault.ensureVault();
    var raw = localStorage.getItem(BURN_LIBRARY_KEY);
    if (!raw) {
      _burnLibraryCache = [];
      return [];
    }
    var parsed = JSON.parse(raw);
    if (parsed && parsed.enc && parsed.sealed && window.NessVault && NessVault.isUnlocked()) {
      var dec = await NessVault.decryptJson(parsed.sealed);
      _burnLibraryCache = Array.isArray(dec) ? dec : [];
      return _burnLibraryCache.slice();
    }
    if (Array.isArray(parsed)) {
      // Migrate once under vault, then discard plaintext form
      _burnLibraryCache = parsed.filter(Boolean).slice(0, 40);
      await persistBurnLibrary(_burnLibraryCache);
      return _burnLibraryCache.slice();
    }
    _burnLibraryCache = [];
    return [];
  } catch (e) {
    _burnLibraryCache = [];
    return [];
  }
}

async function persistBurnLibrary(items) {
  _burnLibraryCache = (items || []).slice(0, 40);
  try {
    if (window.NessVault && !NessVault.isUnlocked()) await NessVault.ensureVault();
    if (!(window.NessVault && NessVault.isUnlocked())) return; // fail closed
    var sealed = await NessVault.encryptJson(_burnLibraryCache);
    localStorage.setItem(BURN_LIBRARY_KEY, JSON.stringify({ v: 2, enc: true, sealed: sealed }));
  } catch (e) {}
}

function writeBurnLibrary(items) {
  _burnLibraryCache = (items || []).slice(0, 40);
  persistBurnLibrary(_burnLibraryCache);
}

async function upsertBurnLibrary(data) {
  if (!data || !data.token) return;
  if (!_burnLibraryCache) {
    try { await hydrateBurnLibrary(); } catch (e) {}
  }
  var items = (_burnLibraryCache || []).filter(function (x) { return x && x.token !== data.token; });
  items.unshift({
    token: data.token,
    plan: data.plan,
    plan_label: data.plan_label,
    badge_class: data.badge_class || "",
    path: data.path || ("/burn/d/" + data.token),
    expires_at: data.expires_at,
    max_downloads: data.max_downloads,
    burn_after: data.burn_after,
    files: data.files || [],
    saved_at: Date.now(),
  });
  var now = Date.now();
  items = items.filter(function (x) {
    if (!x.expires_at) return true;
    try { return new Date(x.expires_at).getTime() > now; } catch (e) { return true; }
  });
  await persistBurnLibrary(items);
}


async function restoreBurnDraft() {
  let draft = null;
  try {
    if (window.NessVault && !NessVault.isUnlocked()) {
      await NessVault.ensureVault();
    }
    const raw = JSON.parse(localStorage.getItem(BURN_DRAFT_KEY) || "null");
    if (raw && raw.enc && raw.sealed && window.NessVault) {
      draft = await NessVault.decryptJson(raw.sealed);
    } else if (raw && raw.plan && !raw.enc) {
      draft = raw;
    }
  } catch (e) {
    draft = null;
  }
  if (!draft || !draft.plan) return false;
  if (!TIERS[draft.plan]) return false;

  selectedPlanId = draft.plan;
  renderPlans();
  selectPlan(draft.plan);

  let restoredFiles = [];
  try {
    restoredFiles = await idbLoadFiles();
  } catch (e) {
    restoredFiles = [];
  }
  if (restoredFiles && restoredFiles.length) {
    selectedFiles = restoredFiles;
    lastVoiceFileName = null;
    restoredFiles.forEach(function (f) {
      if (f.name && String(f.name).indexOf("voice-") === 0) lastVoiceFileName = f.name;
    });
    renderFileList();
  }

  const noteEl = document.getElementById("note-editor");
  if (noteEl && draft.noteHtml) {
    noteEl.innerHTML = sanitizeNoteHtml(draft.noteHtml || "");
    updateNoteCount();
  }
  if ($("#opt-allow-view").length) $("#opt-allow-view").prop("checked", draft.allow_view !== false);
  if ($("#opt-allow-download").length) $("#opt-allow-download").prop("checked", draft.allow_download !== false);
  if ($("#opt-burn-after").length && !$("#opt-burn-after").prop("disabled")) {
    $("#opt-burn-after").prop("checked", !!draft.burn_after);
  }
  if ($("#opt-voice-anon").length && !$("#opt-voice-anon").prop("disabled")) {
    $("#opt-voice-anon").prop("checked", draft.voice_anon !== false);
  }

  const hasFiles = !!(restoredFiles && restoredFiles.length);
  const noteHtml = draft.noteHtml || "";
  const noteText = noteHtml.replace(/<[^>]*>/g, "").replace(/\u200B/g, "").trim();
  const hasInlineImg = noteHtml.indexOf("<img") !== -1;
  const hasNote = noteText.length > 0 || hasInlineImg;
  // Only auto-open compose when there is real work in progress
  if (draft.planLocked && (hasFiles || hasNote)) {
    showCompose();
    return true;
  }
  return false;
}

function restoreBurnActive() {
  // Soft restore only: keep library / activeDrop memory for Manage.
  // Never auto-open the management card on reload — home = plans + live list.
  loadBurnActive().then(function (saved) {
    if (!saved || !saved.token) return;
    const pathTok = (location.pathname || "").match(/\/burn\/d\/([A-Za-z0-9_\-]+)/);
    if (pathTok) return;

    $.ajax({
      url: "/api/burn/" + encodeURIComponent(saved.token),
      headers: ajaxHeaders(),
    })
      .done(function (data) {
        if (!data || !data.success) {
          clearBurnActive();
          return;
        }
        var payload = {
          token: saved.token,
          plan: data.plan || saved.plan,
          plan_label: saved.plan_label || data.plan,
          path: "/burn/d/" + saved.token,
          expires_at: data.expires_at || saved.expires_at,
          max_downloads: data.max_downloads != null ? data.max_downloads : saved.max_downloads,
          burn_after: data.burn_after != null ? data.burn_after : saved.burn_after,
          files: data.files || saved.files || [],
          badge_class: saved.badge_class || "",
        };
        activeDrop = payload;
        try { upsertBurnLibrary(payload); } catch (e) {}
        try { saveBurnActive(payload); } catch (e2) {}
        if (typeof loadMineDrops === "function") loadMineDrops();
      })
      .fail(function () {
        if (saved.expires_at && new Date(saved.expires_at).getTime() > Date.now()) {
          activeDrop = saved;
          try { upsertBurnLibrary(saved); } catch (e) {}
          if (typeof loadMineDrops === "function") loadMineDrops();
        } else {
          clearBurnActive();
        }
      });
  });
}

function initThemeToggle() {
  $("#theme-toggle").on("click", function () {
    const cur = document.documentElement.getAttribute("data-theme");
    if (cur === "light") {
      document.documentElement.removeAttribute("data-theme");
      localStorage.setItem("ness_theme", "dark");
    } else {
      document.documentElement.setAttribute("data-theme", "light");
      localStorage.setItem("ness_theme", "light");
    }
  });
}

/** TempMail-identical plan grid */
function renderPlans() {
  const order = ["free", "flash", "session", "day", "week", "month"];
  let html = "";
  order.forEach(function (id) {
    const t = TIERS[id];
    if (!t) return;
    const rec = id === "day" ? " recommended" : "";
    const sel = id === selectedPlanId ? " selected" : "";
    const feats = [];
    feats.push("<strong>" + formatDuration(t.ttl_minutes) + "</strong> lifetime");
    feats.push("<strong>" + formatQuotaMb(t.max_size_mb) + "</strong> · " + (Number(t.max_files) > 0 ? (t.max_files + " file" + (t.max_files > 1 ? "s" : "")) : "Unlimited files"));
    feats.push("<strong>" + t.max_downloads + "</strong> downloads");
    if (t.max_audio_seconds) {
      const as = t.max_audio_seconds;
      feats.push("Voice ≤ " + (as >= 60 ? Math.round(as / 60) + " min" : as + "s"));
    }
    if (t.password) feats.push("Passphrase");
    if (t.burn_after_download) feats.push("Auto-burn");
    html +=
      '<div class="plan' + sel + rec + '" data-plan="' + id + '">' +
        '<div class="plan-name">' + escapeHtml(t.label) + "</div>" +
        '<div class="plan-price">' + formatPrice(t.price_nch) + "</div>" +
        '<div class="plan-meta">' + feats.join("<br>") + "</div>" +
      "</div>";
  });
  $("#plans").html(html);
}

function selectPlan(id) {
  if (!TIERS[id]) return;
  selectedPlanId = id;
  $(".plan").removeClass("selected");
  $('.plan[data-plan="' + id + '"]').addClass("selected");
  const $actions = $("#plan-actions");
  if ($actions.length && !planLocked) {
    const rect = $actions[0].getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (rect.bottom > vh - 24 || rect.top < 80) {
      $actions[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

function setPasswordInputVisible(input, visible) {
  if (!input) return false;
  var want = visible ? "text" : "password";
  if ((input.getAttribute("type") || input.type || "").toLowerCase() === want) {
    return true;
  }
  // Primary path
  try {
    input.type = want;
  } catch (err) { /* some legacy engines */ }
  if ((input.type || "").toLowerCase() === want) {
    return true;
  }
  // Fallback: replace node (rare WebViews that block type mutation)
  try {
    var clone = input.cloneNode(false);
    clone.setAttribute("type", want);
    clone.value = input.value;
    clone.className = input.className;
    clone.id = input.id;
    clone.name = input.name;
    if (input.placeholder) clone.placeholder = input.placeholder;
    if (input.autocomplete) clone.autocomplete = input.autocomplete;
    clone.required = input.required;
    input.parentNode.replaceChild(clone, input);
    return true;
  } catch (err2) {
    return false;
  }
}

function syncPwToggleUi(btn, revealed) {
  if (!btn) return;
  btn.classList.toggle("is-revealed", !!revealed);
  btn.setAttribute("aria-pressed", revealed ? "true" : "false");
  btn.setAttribute("aria-label", revealed ? "Hide passphrase" : "Show passphrase");
  btn.setAttribute("title", revealed ? "Hide passphrase" : "Show passphrase");
}

function togglePassphraseForButton(btn) {
  if (!btn) return;
  var id = btn.getAttribute("data-target");
  var inp = id ? document.getElementById(id) : null;
  if (!inp) return;
  var cur = (inp.getAttribute("type") || inp.type || "password").toLowerCase();
  var reveal = cur === "password";
  if (!setPasswordInputVisible(inp, reveal)) {
    return;
  }
  // Re-query in case the node was replaced
  inp = document.getElementById(id) || inp;
  var now = (inp.getAttribute("type") || inp.type || "").toLowerCase();
  syncPwToggleUi(btn, now === "text");
  try { inp.focus({ preventScroll: true }); } catch (e) { try { inp.focus(); } catch (e2) {} }
}

function bindPassphraseToggles() {
  if (window.__nessPwToggleBound) return;
  window.__nessPwToggleBound = true;

  function onActivate(e) {
    var btn = e.target && e.target.closest ? e.target.closest("button.pw-toggle") : null;
    if (!btn || !document.body.contains(btn)) return;
    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === "function") e.stopImmediatePropagation();
    togglePassphraseForButton(btn);
  }

  // Bubble + capture so neither overlay nor stopPropagation on parents can starve us
  document.addEventListener("click", onActivate, true);
  document.addEventListener("click", onActivate, false);
  // Keyboard: Enter / Space on focused toggle
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var btn = e.target && e.target.closest ? e.target.closest("button.pw-toggle") : null;
    if (!btn) return;
    e.preventDefault();
    togglePassphraseForButton(btn);
  }, true);
}

function setPassphraseFieldVisible(on) {
  var el = document.getElementById("opt-password-wrap");
  if (!el) return;
  if (on) {
    el.removeAttribute("hidden");
    el.hidden = false;
    el.style.display = "flex";
    bindPassphraseToggles();
    var btn = document.getElementById("btn-toggle-opt-password");
    var inp = document.getElementById("opt-password");
    if (inp) setPasswordInputVisible(inp, false);
    syncPwToggleUi(btn, false);
  } else {
    el.setAttribute("hidden", "");
    el.hidden = true;
    el.style.display = "none";
    var inp2 = document.getElementById("opt-password");
    if (inp2) {
      setPasswordInputVisible(inp2, false);
      inp2.value = "";
    }
    syncPwToggleUi(document.getElementById("btn-toggle-opt-password"), false);
  }
}

function syncComposeFromPlan() {
  const t = TIERS[selectedPlanId];
  if (!t) return;
  $("#compose-badge").attr("class", "badge " + (t.badge_class || "plan-free")).text(t.label);
  $("#compose-limits").text(
    (typeof formatQuotaMb === "function" ? formatQuotaMb(t.max_size_mb) : (t.max_size_mb + " MB")) +
    " · " + planFilesLabel() + " · " + t.max_downloads + " DL · voice " +
    (t.max_audio_seconds >= 60
      ? Math.round(t.max_audio_seconds / 60) + " min"
      : t.max_audio_seconds + "s")
  );
  if (t.burn_after_download) {
    $("#opt-burn-after").prop("checked", true).prop("disabled", true);
  } else {
    $("#opt-burn-after").prop("disabled", false);
  }
  // Day / Week / Month only — must remove [hidden] (CSS uses !important)
  setPassphraseFieldVisible(!!t.password);
  const sec = t.max_audio_seconds || 60;
  $("#audio-limit-hint").text("Up to " + (sec >= 60 ? Math.round(sec / 60) + " min" : sec + "s") + " on " + t.label);
  if (t.voice_anonymize === false) {
    $("#opt-voice-anon").prop("checked", false).prop("disabled", true);
  } else {
    $("#opt-voice-anon").prop("disabled", false);
  }
  const nc = t.max_note_chars || 500;
  $("#note-limit-hint").text(nc.toLocaleString("en-US") + " characters max");
  updateNoteCount();
}

function showPlansOnly(opts) {
  opts = opts || {};
  planLocked = false;
  $("#plans-card").show();
  $("#compose-card").hide();
  $("#active-card").hide();
  $("#download-card").hide();
  // activeDrop kept in memory for Manage — UI stays on home
  stopRecordingQuiet();
  discardPendingAudio();
  // Never persist on boot — that would wipe IndexedDB before restoreBurnDraft.
  // Only persist when leaving compose intentionally (e.g. Change plan).
  if (opts.persistDraft === true) {
    try { saveBurnDraft(); } catch (e) {}
  }
  if (typeof loadMineDrops === "function") loadMineDrops();
}

function showCompose() {
  planLocked = true;
  saveBurnDraft();
  syncComposeFromPlan();
  $("#plans-card").hide();
  $("#compose-card").show();
  $("#active-card").hide();
  $("#download-card").hide();
  const el = document.getElementById("compose-card");
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function showActive(data) {
  activeDrop = data;
  saveBurnActive(data);
  clearBurnDraft();
  // Exclusive: management card only — never stack with mine list (same link twice)
  $("#plans-card").hide();
  $("#compose-card").hide();
  $("#download-card").hide();
  if ($("#mine-card").length) $("#mine-card").hide();
  $("#active-card").show();
  $("#active-badge").attr("class", "badge " + (data.badge_class || "")).text(data.plan_label || data.plan);
  var path = data.path || ("/burn/d/" + data.token);
  if (data.link_key && path.indexOf("#k=") === -1) {
    path = burnSharePath(data.token, data.link_key);
  } else if (__burnLinkKey && path.indexOf("#k=") === -1 && !data.password_required) {
    path = burnSharePath(data.token, __burnLinkKey);
  }
  const link = (path.indexOf("http") === 0) ? path : (location.origin + path);
  $("#active-link").text(link);
  if (link.indexOf("#k=") !== -1) {
    try {
      if (!window.__burnKeyWarnShown) {
        window.__burnKeyWarnShown = true;
        toast("Open links include a secret #k= fragment — copy the full URL", "warn");
      }
    } catch (e) {}
  }
  $("#active-cap").text(
    (data.max_downloads || "—") + " DL" + (data.burn_after ? " · burn" : "")
  );
  const $fl = $("#active-files").empty();
  (data.files || []).forEach(function (f) {
    $fl.append(
      "<li><span class=\"fname\">" + escapeHtml(f.filename) + "</span>" +
      "<span class=\"fmeta\">" + formatBytes(f.size) + "</span></li>"
    );
  });
  if (timerInterval) clearInterval(timerInterval);
  function tick() {
    $("#active-timer").text(formatRemain(data.expires_at));
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

function renderFileList() {
  const $ul = $("#file-list").empty();
  selectedFiles.forEach(function (f, i) {
    $ul.append(
      "<li><span class=\"fname\">" + escapeHtml(f.name) + "</span>" +
      "<span class=\"fmeta\">" + formatBytes(f.size) +
      ' <button type="button" class="btn btn-ghost btn-sm rm" data-i="' + i + '">Remove</button></span></li>'
    );
  });
}


function loadMineDrops() {
  var list = $("#mine-list");
  var card = $("#mine-card");
  if (!list.length || !card.length) return;

  function renderItems(items) {
    list.empty();
    // Exclusive UI: management card owns the screen when visible
    if ($("#active-card").length && $("#active-card").is(":visible")) {
      card.hide();
      return;
    }
    if (!items.length) {
      card.hide();
      return;
    }
    card.show();
    items.forEach(function (it) {
      var link = location.origin + (it.path || ("/burn/d/" + it.token));
      var expLabel = "";
      try {
        if (it.expires_at) expLabel = formatRemain(it.expires_at);
      } catch (e) {}
      var shortId = (it.token || "").length > 12 ? (it.token.slice(0, 6) + "…" + it.token.slice(-4)) : (it.token || "");
      var fileHint = "";
      try {
        var fl = it.files || [];
        if (fl.length === 1) fileHint = fl[0].filename || fl[0].name || "";
        else if (fl.length > 1) fileHint = fl.length + " files";
      } catch (e2) {}
      var row = $(
        '<div class="burn-mine-row">' +
          '<div class="burn-mine-main">' +
            '<div class="burn-mine-head">' +
              '<span class="badge ' + escapeHtml(it.badge_class || "") + '">' +
                escapeHtml(it.plan_label || it.plan || "Drop") +
              "</span>" +
              (expLabel ? '<span class="timer burn-mine-ttl">' + escapeHtml(expLabel) + "</span>" : "") +
            "</div>" +
            (fileHint ? '<div class="burn-mine-file">' + escapeHtml(fileHint) + "</div>" : "") +
            '<div class="burn-mine-id mono" title="' + escapeHtml(link) + '">/burn/d/' + escapeHtml(shortId) + "</div>" +
          "</div>" +
          '<div class="burn-mine-actions">' +
            '<button type="button" class="btn btn-sm btn-mine-preview">Open</button>' +
            '<button type="button" class="btn btn-sm btn-ghost btn-mine-manage">Manage</button>' +
            '<button type="button" class="btn btn-sm btn-ghost btn-mine-copy" title="Copy public link" aria-label="Copy link">' +
              '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
            "</button>" +
          "</div>" +
        "</div>"
      );
      row.find(".btn-mine-preview").on("click", function () {
        activeDrop = {
          token: it.token,
          plan: it.plan,
          plan_label: it.plan_label,
          badge_class: it.badge_class,
          path: it.path,
          expires_at: it.expires_at,
          max_downloads: it.max_downloads,
          burn_after: it.burn_after,
          files: it.files || [],
        };
        if (typeof saveBurnActive === "function") saveBurnActive(activeDrop);
        openPublisherPreview(it.token, "home");
      });
      row.find(".btn-mine-copy").on("click", function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(function () { toast("Link copied", "ok"); })
            .catch(function () { toast("Copy failed", "err"); });
        } else toast("Copy not available", "warn");
      });
      row.find(".btn-mine-open").on("click", function () {
        window.open(link, "_blank", "noopener,noreferrer");
      });
      row.find(".btn-mine-manage").on("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var payload = {
          token: it.token,
          plan: it.plan,
          plan_label: it.plan_label,
          badge_class: it.badge_class,
          path: it.path || ("/burn/d/" + it.token),
          expires_at: it.expires_at,
          max_downloads: it.max_downloads,
          burn_after: it.burn_after,
          files: it.files || [],
        };
        showActive(payload);
        history.replaceState({}, "", "/burn");
        requestAnimationFrame(function () {
          var el = document.getElementById("active-card");
          if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      });
      list.append(row);
    });
  }

  // Local library first (always available on this device)
  var localItems = readBurnLibrary();
  var byTok = {};
  localItems.forEach(function (it) { if (it && it.token) byTok[it.token] = it; });

  // Merge server-owned drops when device id is known
  $.ajax({
    url: "/api/burn/mine",
    method: "GET",
    headers: typeof ajaxHeaders === "function" ? ajaxHeaders() : {},
  })
    .done(function (data) {
      var serverItems = (data && data.success && data.items) ? data.items : [];
      serverItems.forEach(function (it) {
        byTok[it.token] = it;
        try { upsertBurnLibrary(it); } catch (e) {}
      });
      // Verify still-live via meta (prune burned/expired)
      var tokens = Object.keys(byTok);
      if (!tokens.length) { renderItems([]); return; }
      var pending = tokens.length;
      var live = [];
      tokens.forEach(function (tok) {
        $.ajax({
          url: "/api/burn/" + encodeURIComponent(tok),
          headers: typeof ajaxHeaders === "function" ? ajaxHeaders() : {},
        })
          .done(function (meta) {
            if (meta && meta.success) {
              var base = byTok[tok] || {};
              live.push({
                token: tok,
                plan: meta.plan || base.plan,
                plan_label: base.plan_label || meta.plan,
                badge_class: base.badge_class || "",
                path: base.path || ("/burn/d/" + tok),
                expires_at: meta.expires_at || base.expires_at,
                max_downloads: meta.max_downloads != null ? meta.max_downloads : base.max_downloads,
                burn_after: meta.burn_after != null ? meta.burn_after : base.burn_after,
                files: meta.files || base.files || [],
              });
            }
          })
          .always(function () {
            pending -= 1;
            if (pending <= 0) {
              live.sort(function (a, b) {
                return String(b.expires_at || "").localeCompare(String(a.expires_at || ""));
              });
              writeBurnLibrary(live);
              renderItems(live);
            }
          });
      });
    })
    .fail(function () {
      // Offline / error — still show local library, prune client-side only
      var now = Date.now();
      var live = localItems.filter(function (x) {
        if (!x || !x.token) return false;
        if (!x.expires_at) return true;
        try { return new Date(x.expires_at).getTime() > now; } catch (e) { return true; }
      });
      renderItems(live);
    });
}

function tokenFromPath() {
  const m = location.pathname.match(/^\/burn\/d\/([A-Za-z0-9_\-]+)/);
  return m ? m[1] : null;
}

function openPay() {
  const t = TIERS[selectedPlanId] || {};
  if (!selectedPlanId || !t.id || Number(t.price_nch) <= 0) {
    toast("Select a paid plan before publishing", "warn");
    showPlansOnly();
    return;
  }
  pendingIntentId = null;
  pendingIntentAmount = null;
  $("#pay-title").text("Activate " + (t.label || "plan"));
  $("#pay-sub").text("Preparing payment…");
  $("#pay-address").text(typeof PAY_ADDRESS !== "undefined" ? PAY_ADDRESS : "—");
  $("#pay-amount").html("…");
  $("#tx-hash").val("");
  // Must clear any inline display:none left by closePay (class alone cannot override it)
  $("#pay-modal").addClass("open").stop(true, true).css("display", "flex").show();
  $.ajax({
    url: "/api/payment/intent",
    method: "POST",
    data: { product: "burn", plan: selectedPlanId },
    headers: typeof ajaxHeaders === "function" ? ajaxHeaders() : {},
  })
    .done(function (data) {
      if (!data || !data.success) {
        toast((data && data.error) || "Could not create payment intent", "err");
        closePay();
        return;
      }
      pendingIntentId = data.intent_id;
      try {
        sessionStorage.setItem("ness_pay_intent_burn", JSON.stringify({
          intent_id: data.intent_id,
          amount_nch: data.amount_nch,
          plan: data.plan,
          expires_at: data.expires_at,
          pay_address: data.pay_address
        }));
      } catch (e) {}
      pendingIntentAmount = data.amount_nch;
      $("#pay-sub").text(
        "Send at least " + Number(data.amount_nch).toLocaleString() +
        " NCH, then paste the transaction hash."
      );
      $("#pay-address").text(data.pay_address || PAY_ADDRESS);
      $("#pay-amount").html(Number(data.amount_nch).toLocaleString() + " <span>NCH</span>");
    })
    .fail(function (xhr) {
      var msg = "Could not create payment intent";
      try {
        var body = xhr.responseJSON || JSON.parse(xhr.responseText || "{}");
        if (body && body.error) msg = body.error;
      } catch (e) {}
      if (xhr.status === 429) msg = "Too many payment attempts — wait a moment";
      if (xhr.status === 503) msg = "Service busy — try again shortly";
      toast(msg, "err");
      closePay();
    });
}


var burnRenewMode = false;

function closePay() {
  $("#pay-modal").removeClass("open").stop(true, true).hide().css("display", "none");
  burnRenewMode = false;
  pendingIntentId = null;
  pendingIntentAmount = null;
}

function validateFilesAgainstPlan() {
  const t = TIERS[selectedPlanId];
  if (!t) return "No plan selected";
  const noteLen = getNotePlainLength();
  if (!selectedFiles.length && !hasNoteContent()) return "Add a file, voice note, or text note";
  const maxNote = (t.max_note_chars || 500);
  if (noteLen > maxNote) return "Note exceeds " + maxNote + " characters for this plan";
  const items = countPayloadItems();
  if (items > planCapacity()) {
    return "This plan allows " + planCapacity() + " item(s) — you have " + items + " (each file/voice and the note count as 1)";
  }
  let total = 0;
  selectedFiles.forEach(function (f) { total += f.size || 0; });
  const maxB = t.max_size_mb * 1024 * 1024;
  if (total > maxB) return "Total size exceeds " + t.max_size_mb + " MB for this plan";
  return null;
}


function hasNoteContent() {
  const el = document.getElementById("note-editor");
  if (!el) return false;
  const text = (el.innerText || "").replace(/\u200B/g, "").trim();
  if (text.length > 0) return true;
  return (el.innerHTML || "").indexOf("<img") !== -1;
}

function countPayloadItems() {
  // Each selected file counts as 1; secure note (text and/or inline images) counts as 1
  return selectedFiles.length + (hasNoteContent() ? 1 : 0);
}

function planCapacity() {
  // max_files === 0 means unlimited (aligned with burn.py). Never treat 0 as 1.
  const t = TIERS[selectedPlanId] || {};
  const n = parseInt(t.max_files, 10);
  if (!isFinite(n) || n <= 0) return Number.MAX_SAFE_INTEGER;
  return n;
}

function planFilesLabel() {
  const t = TIERS[selectedPlanId] || {};
  const n = parseInt(t.max_files, 10);
  if (!isFinite(n) || n <= 0) return "Unlimited files";
  return n + " file" + (n === 1 ? "" : "s");
}

function assertCanAddFile() {
  // Adding one more binary file
  const next = selectedFiles.length + 1 + (hasNoteContent() ? 1 : 0);
  if (next > planCapacity()) {
    toast(planCapacity() >= 1e9 ? "Something went wrong adding this file." : ("This plan allows " + planCapacity() + " item(s). Remove something or upgrade."), "warn");
    return false;
  }
  return true;
}

function assertCanAddNote() {
  // Note counts as one item if not already present
  if (hasNoteContent()) return true;
  const next = selectedFiles.length + 1;
  if (next > planCapacity()) {
    toast("This plan allows " + planCapacity() + " item(s). Remove a file/voice to write a note.", "warn");
    return false;
  }
  return true;
}

function assertCanAddVoice() {
  // Voice replaces other voice-* but still one file slot among selectedFiles
  const withoutVoice = selectedFiles.filter(function (f) {
    return !(f && f.name && String(f.name).indexOf("voice-") === 0);
  });
  const next = withoutVoice.length + 1 + (hasNoteContent() ? 1 : 0);
  if (next > planCapacity()) {
    toast("This plan allows " + planCapacity() + " item(s). Remove the note or a file to record.", "warn");
    return false;
  }
  return true;
}

function getNotePlainLength() {
  const el = document.getElementById("note-editor");
  if (!el) return 0;
  return (el.innerText || "").replace(/\u200B/g, "").trim().length;
}

function updateNoteCount() {
  const t = TIERS[selectedPlanId] || {};
  const max = t.max_note_chars || 500;
  const n = getNotePlainLength();
  const $c = $("#note-count");
  $c.text(n + " / " + max);
  $c.toggleClass("is-over", n > max);
}


/** Re-encode raster images on-device to drop EXIF/GPS (journalism / anti-doxxing).
 * Fail-closed: never returns the original file. SVG is refused (embedded metadata / script risk).
 */
function stripImageMetadata(file) {
  return new Promise(function (resolve, reject) {
    if (!file || !file.type || file.type.indexOf("image/") !== 0) {
      resolve(file);
      return;
    }
    var type = (file.type || "").toLowerCase();
    var name = String(file.name || "").toLowerCase();
    if (type === "image/svg+xml" || name.endsWith(".svg") || name.endsWith(".svgz")) {
      reject(new Error("SVG images are not allowed (metadata and script risk). Use PNG or JPEG."));
      return;
    }
    // HEIC/HEIF often cannot be decoded by canvas in many browsers — refuse rather than pass-through
    if (type.indexOf("heic") !== -1 || type.indexOf("heif") !== -1 ||
        name.endsWith(".heic") || name.endsWith(".heif")) {
      reject(new Error("HEIC/HEIF not supported for metadata stripping. Convert to JPEG or PNG first."));
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = function () {
      try {
        const max = 4096;
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (!w || !h) {
          URL.revokeObjectURL(url);
          reject(new Error("Could not read image dimensions — file refused."));
          return;
        }
        if (w > max || h > max) {
          const s = Math.min(max / w, max / h);
          w = Math.round(w * s);
          h = Math.round(h * s);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error("Canvas unavailable — image refused to protect metadata."));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(function (blob) {
          URL.revokeObjectURL(url);
          if (!blob || blob.size < 32) {
            reject(new Error("Image re-encode failed — file refused (metadata not stripped)."));
            return;
          }
          // Neutral filename — no original name leakage
          const safe = "image-" + Date.now() + ".jpg";
          resolve(new File([blob], safe, { type: "image/jpeg", lastModified: Date.now() }));
        }, "image/jpeg", 0.92);
      } catch (e) {
        URL.revokeObjectURL(url);
        reject(new Error("Image re-encode failed — file refused (metadata not stripped)."));
      }
    };
    img.onerror = function () {
      URL.revokeObjectURL(url);
      reject(new Error("Could not decode image — file refused (metadata not stripped)."));
    };
    // Avoid accidental credentialed loads; blob: URLs are local
    img.referrerPolicy = "no-referrer";
    img.src = url;
  });
}

function sanitizeAttachmentName(name) {
  const base = String(name || "file").split(/[/\\]/).pop();
  const ext = (base.match(/(\.[a-zA-Z0-9]{1,8})$/) || [])[1] || "";
  return "file-" + Date.now().toString(36) + ext.toLowerCase();
}

function _burnExt(name) {
  var m = String(name || "").toLowerCase().match(/\.([a-z0-9]{1,8})$/);
  return m ? m[1] : "";
}

async function stripPdfMetadata(file) {
  var PDF_STRIP_MAX = 25 * 1024 * 1024;
  if ((file.size || 0) > PDF_STRIP_MAX) {
    throw new Error("PDF too large to strip metadata in-browser (max 25 MB). Split or compress first.");
  }
  var buf = new Uint8Array(await file.arrayBuffer());
  var headLen = Math.min(buf.length, 512 * 1024);
  var head = "";
  for (var i = 0; i < headLen; i++) head += String.fromCharCode(buf[i]);
  if (/\/Encrypt[\s\/\[]/.test(head)) {
    throw new Error("Encrypted PDF refused — decrypt locally first so metadata can be stripped.");
  }
  var magic = String.fromCharCode(buf[0] || 0, buf[1] || 0, buf[2] || 0, buf[3] || 0, buf[4] || 0);
  if (magic !== "%PDF-" && _burnExt(file.name) !== "pdf" && (file.type || "") !== "application/pdf") {
    throw new Error("Not a valid PDF — refused.");
  }
  var text = head;
  if (buf.length > headLen) {
    for (var j = headLen; j < buf.length; j++) text += String.fromCharCode(buf[j]);
  }
  var orig = text;
  text = text.replace(/<\?xpacket begin[\s\S]*?<\?xpacket end[^?]*\?>/g, "");
  text = text.replace(/\/Info\s*\d+\s+\d+\s+R/g, "");
  text = text.replace(/\/Info\s*<<[\s\S]*?>>/g, "");
  text = text.replace(/\/(Author|Title|Subject|Creator|Producer|Keywords|CreationDate|ModDate)\s*\((?:\\.|[^\\)])*\)/g, "");
  text = text.replace(/\/(Author|Title|Subject|Creator|Producer|Keywords)\s*<[0-9A-Fa-f]*>/g, "");
  if (text === orig && /\/Info\b/.test(orig) && /\/(Author|Producer|Creator|CreationDate)\b/.test(orig)) {
    throw new Error("Could not strip PDF metadata — file refused.");
  }
  var out = new Uint8Array(text.length);
  for (var k = 0; k < text.length; k++) out[k] = text.charCodeAt(k) & 0xff;
  return new File([out], "doc-" + Date.now() + ".pdf", { type: "application/pdf", lastModified: Date.now() });
}

async function stripAudioMetadata(file) {
  var buf = new Uint8Array(await file.arrayBuffer());
  var start = 0;
  var end = buf.length;
  if (end - start >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    var size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    var footer = (buf[5] & 0x10) ? 10 : 0;
    start = Math.min(end, 10 + size + footer);
  }
  if (end - start >= 128) {
    var tpos = end - 128;
    if (buf[tpos] === 0x54 && buf[tpos + 1] === 0x41 && buf[tpos + 2] === 0x47) end = tpos;
  }
  if (end - start >= 32) {
    var ap = end - 32;
    var tag = String.fromCharCode(buf[ap], buf[ap + 1], buf[ap + 2], buf[ap + 3], buf[ap + 4], buf[ap + 5], buf[ap + 6], buf[ap + 7]);
    if (tag === "APETAGEX") {
      var apeSize = buf[ap + 12] | (buf[ap + 13] << 8) | (buf[ap + 14] << 16) | (buf[ap + 15] << 24);
      var apeFlags = buf[ap + 20] | (buf[ap + 21] << 8) | (buf[ap + 22] << 16) | (buf[ap + 23] << 24);
      var hasHeader = (apeFlags & (1 << 31)) !== 0;
      var block = 32 + apeSize + (hasHeader ? 32 : 0);
      if (block > 0 && block < end - start) end -= block;
    }
  }
  var ext = _burnExt(file.name);
  var type = file.type || "";
  var slice = buf.subarray(start, end);
  if ((type === "audio/wav" || type === "audio/x-wav" || ext === "wav") && slice.length > 12) {
    try { slice = _stripRiffListInfo(slice); } catch (e) {}
  }
  return new File([slice], "audio-" + Date.now() + (ext ? "." + ext : ""), {
    type: type || "application/octet-stream",
    lastModified: Date.now(),
  });
}

function _stripRiffListInfo(buf) {
  if (buf.length < 12) return buf;
  if (String.fromCharCode(buf[0], buf[1], buf[2], buf[3]) !== "RIFF") return buf;
  var outChunks = [];
  var offset = 12;
  while (offset + 8 <= buf.length) {
    var id = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
    var sz = buf[offset + 4] | (buf[offset + 5] << 8) | (buf[offset + 6] << 16) | (buf[offset + 7] << 24);
    if (sz < 0 || offset + 8 + sz > buf.length) break;
    var advance = 8 + sz + (sz & 1);
    var listType = "";
    if (id === "LIST" && sz >= 4) {
      listType = String.fromCharCode(buf[offset + 8], buf[offset + 9], buf[offset + 10], buf[offset + 11]);
    }
    if (!(id === "LIST" && listType === "INFO")) {
      outChunks.push(buf.subarray(offset, Math.min(offset + advance, buf.length)));
    }
    offset += advance;
  }
  var bodyLen = 4;
  outChunks.forEach(function (c) { bodyLen += c.length; });
  var out = new Uint8Array(8 + bodyLen);
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46;
  out[4] = bodyLen & 0xff; out[5] = (bodyLen >> 8) & 0xff;
  out[6] = (bodyLen >> 16) & 0xff; out[7] = (bodyLen >> 24) & 0xff;
  out.set(buf.subarray(8, 12), 8);
  var pos = 12;
  outChunks.forEach(function (c) { out.set(c, pos); pos += c.length; });
  return out;
}

async function stripVideoMetadata(file) {
  var buf = new Uint8Array(await file.arrayBuffer());
  if (buf.length < 16) throw new Error("Media file too small — refused.");
  var ext = _burnExt(file.name);
  var type = file.type || "";
  var isBmff = false;
  if (buf.length > 8) {
    var t4 = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
    if (t4 === "ftyp" || t4 === "wide" || t4 === "free" || t4 === "mdat" || t4 === "moov") isBmff = true;
  }
  if (!isBmff) {
    return new File([buf], "video-" + Date.now() + (ext ? "." + ext : ""), {
      type: type || "application/octet-stream",
      lastModified: Date.now(),
    });
  }
  var cleaned = _bmffStripMeta(buf);
  if (!cleaned || cleaned.length < 16) {
    throw new Error("Could not strip video metadata — file refused.");
  }
  return new File([cleaned], "video-" + Date.now() + (ext ? "." + ext : ".mp4"), {
    type: type || "video/mp4",
    lastModified: Date.now(),
  });
}

function _bmffStripMeta(buf) {
  var DROP = { meta: 1, uuid: 1, udta: 1 };
  function walk(start, end) {
    var chunks = [];
    var off = start;
    while (off + 8 <= end) {
      var size = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
      var type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
      var header = 8;
      if (size === 1) {
        if (off + 16 > end) break;
        var high = ((buf[off + 8] << 24) | (buf[off + 9] << 16) | (buf[off + 10] << 8) | buf[off + 11]) >>> 0;
        var low = ((buf[off + 12] << 24) | (buf[off + 13] << 16) | (buf[off + 14] << 8) | buf[off + 15]) >>> 0;
        if (high !== 0) break;
        size = low;
        header = 16;
      } else if (size === 0) {
        size = end - off;
      }
      if (size < header || off + size > end) break;
      if (DROP[type]) { off += size; continue; }
      if ((type === "moov" || type === "trak" || type === "mdia" || type === "minf") && size > header) {
        var inner = walk(off + header, off + size);
        var ns = 8 + inner.length;
        var box = new Uint8Array(ns);
        box[0] = (ns >>> 24) & 0xff; box[1] = (ns >>> 16) & 0xff;
        box[2] = (ns >>> 8) & 0xff; box[3] = ns & 0xff;
        box[4] = buf[off + 4]; box[5] = buf[off + 5]; box[6] = buf[off + 6]; box[7] = buf[off + 7];
        box.set(inner, 8);
        chunks.push(box);
      } else {
        chunks.push(buf.subarray(off, off + size));
      }
      off += size;
    }
    var total = 0;
    chunks.forEach(function (c) { total += c.length; });
    var merged = new Uint8Array(total);
    var p = 0;
    chunks.forEach(function (c) { merged.set(c, p); p += c.length; });
    return merged;
  }
  return walk(0, buf.length);
}

/** @returns {Promise<{file: File, hygiene: "stripped"|"name-only"}>} */
async function prepareAttachmentForBurn(file) {
  if (!file) throw new Error("No file");
  var type = (file.type || "").toLowerCase();
  var name = String(file.name || "").toLowerCase();
  var ext = _burnExt(name);
  if (type.indexOf("image/") === 0 || /^(png|jpe?g|gif|webp|bmp|svg|svgz|heic|heif)$/.test(ext)) {
    return { file: await stripImageMetadata(file), hygiene: "stripped" };
  }
  if (type === "application/pdf" || ext === "pdf") {
    return { file: await stripPdfMetadata(file), hygiene: "stripped" };
  }
  if (type.indexOf("audio/") === 0 || /^(mp3|wav|m4a|aac|ogg|flac|opus|wma)$/.test(ext)) {
    return { file: await stripAudioMetadata(file), hygiene: "stripped" };
  }
  if (/^(mp4|mov|m4v)$/.test(ext) || type === "video/mp4" || type === "video/quicktime") {
    return { file: await stripVideoMetadata(file), hygiene: "stripped" };
  }
  if (type.indexOf("video/") === 0 || /^(webm|mkv|avi)$/.test(ext)) {
    return {
      file: new File([file], "video-" + Date.now() + (ext ? "." + ext : ""), {
        type: file.type || "application/octet-stream",
        lastModified: Date.now(),
      }),
      hygiene: "name-only",
    };
  }
  return {
    file: new File([file], sanitizeAttachmentName(file.name), {
      type: file.type || "application/octet-stream",
      lastModified: Date.now(),
    }),
    hygiene: "name-only",
  };
}

function insertImageAtCursor(file) {
  if (!file || !file.type || file.type.indexOf("image/") !== 0) {
    toast("Choose an image file", "warn");
    return;
  }
  if (!hasNoteContent() && selectedFiles.length >= planCapacity()) {
    toast("This plan allows " + planCapacity() + " item(s). Remove a file/voice to add a note/image.", "warn");
    return;
  }
  stripImageMetadata(file).then(function (clean) {
    _insertImageAtCursorClean(clean);
  }).catch(function (err) {
    toast((err && err.message) || "Image refused", "err");
  });
}

function _insertImageAtCursorClean(file) {
  if (file.size > 1.5 * 1024 * 1024) {
    toast("Inline image max 1.5 MB", "warn");
    return;
  }
  const reader = new FileReader();
  reader.onload = function () {
    const ed = document.getElementById("note-editor");
    ed.focus();
    const img = document.createElement("img");
    img.src = reader.result;
    img.alt = file.name || "image";
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const range = sel.getRangeAt(0);
      if (ed.contains(range.commonAncestorContainer)) {
        range.deleteContents();
        range.insertNode(img);
        range.setStartAfter(img);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        ed.appendChild(img);
      }
    } else {
      ed.appendChild(img);
    }
    updateNoteCount();
  };
  reader.readAsDataURL(file);
}

function buildNoteFileIfAny() {
  const el = document.getElementById("note-editor");
  if (!el) return null;
  const text = (el.innerText || "").replace(/\u200B/g, "").trim();
  const html = (el.innerHTML || "").trim();
  if (!text && html.indexOf("<img") === -1) return null;
  const doc =
    "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
    "<title>NESS Burn note</title>" +
    "<style>body{font-family:Newsreader,Georgia,serif;font-size:1.125rem;line-height:1.8;color:#111;max-width:40rem;margin:2rem auto;padding:0 1rem}" +
    "img{max-width:100%;height:auto;border-radius:6px}</style></head><body>" +
    html +
    "</body></html>";
  return new File([doc], "secure-note.html", { type: "text/html;charset=utf-8" });
}

function filesForUpload() {
  const list = selectedFiles.slice();
  const note = buildNoteFileIfAny();
  if (note) list.push(note);
  return list;
}

function createFree() {
  const err = validateFilesAgainstPlan();
  if (err) { toast(err, "warn"); return; }
  const planForPw = TIERS[selectedPlanId] || {};
  const pw = ($("#opt-password").val() || "").trim();
  if (pw && !planForPw.password) {
    toast("This plan does not support a passphrase", "warn");
    return;
  }
  const $btn = $("#btn-burn-go").prop("disabled", true).text("Encrypting…");
  const plainFiles = filesForUpload();
  burnE2E_buildEnvelope(plainFiles, pw || null)
    .then(function (env) {
      __burnLinkKey = env.linkKeyB64 || null;
      const fd = new FormData();
      fd.append("plan", selectedPlanId);
      env.files.forEach(function (f) { fd.append("files", f); });
      if ($("#opt-burn-after").is(":checked")) fd.append("burn_after", "1");
      fd.append("allow_view", $("#opt-allow-view").is(":checked") ? "1" : "0");
      fd.append("allow_download", $("#opt-allow-download").is(":checked") ? "1" : "0");
      if (pw) fd.append("password", pw);
      fd.append("enc_meta", JSON.stringify(env.encMeta));
      $btn.text("Publishing…");
      return $.ajax({
        url: "/api/burn/create",
        method: "POST",
        data: fd,
        processData: false,
        contentType: false,
        headers: ajaxHeaders(),
      }).then(function (data) {
        $btn.prop("disabled", false).text("Publish");
        if (!data.success) { toast(data.error || "Failed", "err"); return; }
        if (__burnLinkKey) {
          data.path = burnSharePath(data.token, __burnLinkKey);
          data.link_key = __burnLinkKey;
        }
        toast("Published — encrypted end-to-end", "ok");
        selectedFiles = [];
        renderFileList();
        showActive(data);
        history.replaceState({}, "", "/burn");
      });
    })
    .catch(function (xhr) {
      $btn.prop("disabled", false).text("Publish");
      let msg = "Upload failed";
      try {
        if (xhr && xhr.responseJSON && xhr.responseJSON.error) msg = xhr.responseJSON.error;
        else if (xhr && xhr.message) msg = xhr.message;
      } catch (e) {}
      toast(msg, "err");
    });
}

function payAndUpload() {
  if (!pendingIntentId) {
    try {
      var _pi = JSON.parse(sessionStorage.getItem("ness_pay_intent_burn") || "null");
      if (_pi && _pi.intent_id && (!_pi.expires_at || new Date(_pi.expires_at).getTime() > Date.now())) {
        pendingIntentId = _pi.intent_id;
        pendingIntentAmount = _pi.amount_nch;
      }
    } catch (e) {}
  }
  if (!pendingIntentId) {
    toast("Payment session expired — reopen payment", "warn");
    return;
  }
  const tx = ($("#tx-hash").val() || "").trim();
  if (!tx) { toast("Paste the transaction hash", "warn"); return; }

  // Renew existing active drop (remaining time + plan TTL)
  if (typeof burnRenewMode !== "undefined" && burnRenewMode && activeDrop && activeDrop.token) {
    if (tx.length < 16) { toast("Transaction hash looks too short", "warn"); return; }
    const $btn = $("#btn-pay-confirm");
    if (typeof setPayBtnBusy === "function") setPayBtnBusy($btn, true);
    else $btn.prop("disabled", true).text("Renewing…");
    const fd = new FormData();
    fd.append("plan", selectedPlanId);
    fd.append("tx_hash", tx);
    fd.append("intent_id", pendingIntentId);
    $.ajax({
      url: "/api/burn/" + encodeURIComponent(activeDrop.token) + "/renew",
      method: "POST",
      data: fd,
      processData: false,
      contentType: false,
      headers: typeof ajaxHeaders === "function" ? ajaxHeaders() : {},
    }).done(function (data) {
      if (typeof setPayBtnBusy === "function") setPayBtnBusy($btn, false, "Verify & upload");
      else $btn.prop("disabled", false).text("Verify & upload");
      if (!data || !data.success) {
        toast((data && data.error) || "Renew failed", "err");
        return;
      }
      burnRenewMode = false;
      closePay();
      activeDrop.expires_at = data.expires_at;
      if (data.plan) activeDrop.plan = data.plan;
      if (typeof showActive === "function") showActive(activeDrop);
      else if (typeof restoreBurnActive === "function") restoreBurnActive();
      if (typeof saveBurnActive === "function") saveBurnActive(activeDrop);
      try { sessionStorage.removeItem("ness_pay_intent_burn"); } catch (e) {}
      toast("Drop renewed · time remaining kept", "ok");
    }).fail(function (xhr) {
      if (typeof setPayBtnBusy === "function") setPayBtnBusy($btn, false, "Verify & upload");
      else $btn.prop("disabled", false).text("Verify & upload");
      var msg = "Renew failed";
      try { msg = (xhr.responseJSON && xhr.responseJSON.error) || msg; } catch (e) {}
      toast(msg, "err");
    });
    return;
  }

  const err = validateFilesAgainstPlan();
  if (err) { toast(err, "warn"); return; }
  const planForPw = TIERS[selectedPlanId] || {};
  const pw = ($("#opt-password").val() || "").trim();
  if (pw && !planForPw.password) {
    toast("This plan does not support a passphrase", "warn");
    return;
  }
  const $btn = $("#btn-pay-confirm").each(function(){ setPayBtnBusy($(this), true); });
  $btn.each(function(){ $(this).text("Encrypting…"); });
  const plainFiles = filesForUpload();
  burnE2E_buildEnvelope(plainFiles, pw || null)
    .then(function (env) {
      __burnLinkKey = env.linkKeyB64 || null;
      const fd = new FormData();
      fd.append("plan", selectedPlanId);
      if (pendingIntentId) fd.append("intent_id", pendingIntentId);
      fd.append("tx_hash", tx);
      env.files.forEach(function (f) { fd.append("files", f); });
      if ($("#opt-burn-after").is(":checked")) fd.append("burn_after", "1");
      fd.append("allow_view", $("#opt-allow-view").is(":checked") ? "1" : "0");
      fd.append("allow_download", $("#opt-allow-download").is(":checked") ? "1" : "0");
      if (pw) fd.append("password", pw);
      fd.append("enc_meta", JSON.stringify(env.encMeta));
      $btn.each(function(){ $(this).text("Verifying…"); });
      return $.ajax({
        url: "/api/burn/pay",
        method: "POST",
        data: fd,
        processData: false,
        contentType: false,
        headers: ajaxHeaders(),
      });
    })
    .then(function (data) {
      $btn.prop("disabled", false).text("Publish");
      if (!data || !data.success) {
        if (data.connectivity === "offline") {
          toast(data.error || "No internet connection — verify your network and try again", "err");
        } else if (data.explorer_ok === false) {
          toast(data.error || "PrivateNess explorer is down", "err");
        } else {
          toast(data.error || "Payment failed", "err");
        }
        return;
      }
      if (__burnLinkKey) {
        data.path = burnSharePath(data.token, __burnLinkKey);
        data.link_key = __burnLinkKey;
      }
      closePay();
      try { sessionStorage.removeItem("ness_pay_intent_burn"); } catch (e) {}
      toast("Payment verified · encrypted end-to-end", "ok");
      selectedFiles = [];
      renderFileList();
      showActive(data);
      /* stay on /burn — public path is share link only */
history.replaceState({}, "", "/burn");
    })
    .fail(function (xhr) {
      $btn.prop("disabled", false).text("Publish");
      let msg = "Verification failed";
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        msg = "No internet connection — verify your network and try again";
      } else {
        try {
          const b = xhr.responseJSON || JSON.parse(xhr.responseText || "{}");
          if (b.error) msg = b.error;
        } catch (e) {}
      }
      toast(msg, "err");
    });
}

/* ── Voice (only while compose is open / plan locked) ── */
let mediaStream = null;
let mediaRecorder = null;
let recChunks = [];
let recTimer = null;
let recStartedAt = 0;
let pendingAudioBlob = null;
let pendingAudioUrl = null;

function maxAudioSeconds() {
  const t = TIERS[selectedPlanId] || {};
  return Math.max(15, parseInt(t.max_audio_seconds || 60, 10));
}

function formatRecClock(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

function pickMime() {
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  for (let i = 0; i < cands.length; i++) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(cands[i])) {
      return cands[i];
    }
  }
  return "";
}

function assertPlanForAudio() {
  if (!planLocked) {
    toast("Select a plan first", "warn");
    return false;
  }
  return true;
}

function playRecBeep() {
  return new Promise(function (resolve) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const now = ctx.currentTime;
      gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.16);
      setTimeout(function () {
        try { ctx.close(); } catch (e) {}
        resolve();
      }, 180);
    } catch (e) {
      resolve();
    }
  });
}

async function startRecording() {
  if (!assertPlanForAudio()) return;
  if (!assertCanAddVoice()) return;
  await playRecBeep();
  if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
    toast("Microphone needs HTTPS (or localhost). Open via 127.0.0.1 not a LAN IP.", "err");
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast("Microphone API unavailable in this browser", "err");
    return;
  }
  if (mediaRecorder && mediaRecorder.state === "recording") return;
  try {
    const rawStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: { ideal: true },
        noiseSuppression: { ideal: true },
        autoGainControl: { ideal: true },
        channelCount: 1,
        sampleRate: { ideal: 48000 },
      },
    });
    // Premium cleanup chain: high-pass + light compression → recorder
    try {
      const actx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
      const src = actx.createMediaStreamSource(rawStream);
      const high = actx.createBiquadFilter();
      high.type = "highpass";
      high.frequency.value = 85;
      high.Q.value = 0.7;
      const low = actx.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.value = 12000;
      low.Q.value = 0.7;
      const comp = actx.createDynamicsCompressor();
      comp.threshold.value = -32;
      comp.knee.value = 18;
      comp.ratio.value = 3;
      comp.attack.value = 0.005;
      comp.release.value = 0.12;
      const dest = actx.createMediaStreamDestination();
      src.connect(high);
      high.connect(low);
      low.connect(comp);
      comp.connect(dest);
      mediaStream = dest.stream;
      mediaStream.__rawTracks = rawStream.getTracks();
      mediaStream.__audioCtx = actx;
    } catch (procErr) {
      console.warn(procErr);
      mediaStream = rawStream;
    }
  } catch (err) {
    const name = (err && err.name) || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      toast("Microphone blocked — allow mic for this site in browser settings, then retry", "err");
    } else if (name === "NotFoundError") {
      toast("No microphone found on this device", "err");
    } else if (name === "NotReadableError") {
      toast("Microphone is busy in another app", "err");
    } else {
      toast("Microphone error: " + (err.message || name || "unknown"), "err");
    }
    return;
  }
  recChunks = [];
  const mime = pickMime();
  try {
    mediaRecorder = mime
      ? new MediaRecorder(mediaStream, { mimeType: mime, audioBitsPerSecond: 128000 })
      : new MediaRecorder(mediaStream);
  } catch (e) {
    mediaRecorder = new MediaRecorder(mediaStream);
  }
  mediaRecorder.ondataavailable = function (ev) {
    if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
  };
  mediaRecorder.onstop = function () { finishRecording(); };
  mediaRecorder.start(250);
  recStartedAt = Date.now();
  $("#btn-rec").attr("aria-pressed", "true").attr("title", "Recording…");
  $("#btn-rec-stop").prop("disabled", false);
  if (recTimer) clearInterval(recTimer);
  recTimer = setInterval(function () {
    const elapsed = Date.now() - recStartedAt;
    $("#rec-timer").text(formatRecClock(elapsed));
    if (elapsed >= maxAudioSeconds() * 1000) {
      stopRecording();
      toast("Audio limit for this plan reached", "warn");
    }
  }, 200);
}

function stopRecordingQuiet() {
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  $("#btn-rec").attr("aria-pressed", "false").attr("title", "Record");
  $("#btn-rec-stop").prop("disabled", true);
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.onstop = null; mediaRecorder.stop(); } catch (e) {}
  }
  if (mediaStream) {
    try { (mediaStream.__rawTracks || []).forEach(function (tr) { tr.stop(); }); } catch (e) {}
    try { mediaStream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
    try { if (mediaStream.__audioCtx) mediaStream.__audioCtx.close(); } catch (e) {}
    mediaStream = null;
  }
  mediaRecorder = null;
}

function stopRecording() {
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  $("#btn-rec").attr("aria-pressed", "false").attr("title", "Record");
  $("#btn-rec-stop").prop("disabled", true);
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    try { mediaRecorder.stop(); } catch (e) {}
  } else if (mediaStream) {
    mediaStream.getTracks().forEach(function (tr) { tr.stop(); });
    mediaStream = null;
  }
}

async function finishRecording() {
  if (mediaStream) {
    try { (mediaStream.__rawTracks || []).forEach(function (tr) { tr.stop(); }); } catch (e) {}
    try { mediaStream.getTracks().forEach(function (tr) { tr.stop(); }); } catch (e) {}
    try { if (mediaStream.__audioCtx) mediaStream.__audioCtx.close(); } catch (e) {}
    mediaStream = null;
  }
  if (!recChunks.length) {
    toast("No audio captured", "warn");
    return;
  }
  const rawType = (recChunks[0] && recChunks[0].type) || "audio/webm";
  let blob = new Blob(recChunks, { type: rawType });
  recChunks = [];
  if ($("#opt-voice-anon").is(":checked")) {
    try {
      blob = await anonymizeVoiceBlob(blob);
      toast("Voice anonymized on-device", "ok");
    } catch (e) {
      console.warn(e);
      toast("Anonymize failed — using cleaned capture", "warn");
    }
  }
  if (pendingAudioUrl) {
    try { URL.revokeObjectURL(pendingAudioUrl); } catch (e) {}
  }
  pendingAudioBlob = blob;
  if (pendingAudioUrl) {
    try { URL.revokeObjectURL(pendingAudioUrl); } catch (e) {}
  }
  pendingAudioUrl = URL.createObjectURL(blob);
  $("#audio-preview").prop("hidden", false);
  const mount = document.getElementById("audio-player-mount");
  if (mount) mountWaPlayer(mount, pendingAudioUrl);
  // Auto-attach so voice is not lost if user only hits Create drop
  attachPendingAudio();
}

/**
 * Anonymous-style voice mask — hard to identify, still understandable, fast.
 *
 * Identity is mostly F0 + formants. We:
 *  1) pitch-shift ~−6 semitones *without* changing duration (grain OLA),
 *  2) mild formant offset via secondary EQ,
 *  3) telephone band + light robotic ring,
 *  4) fast 16 kHz WAV (offline only — no real-time MediaRecorder).
 */
async function anonymizeVoiceBlob(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    const arr = await blob.arrayBuffer();
    decoded = await ctx.decodeAudioData(arr.slice(0));
  } finally {
    try { await ctx.close(); } catch (e) {}
  }

  const srIn = decoded.sampleRate || 48000;
  const nCh = decoded.numberOfChannels;
  const srcLen = decoded.length;
  const sr = 16000;
  const ratioSr = sr / srIn;
  const workLen = Math.max(1, Math.floor(srcLen * ratioSr));

  // Mono → 16 kHz
  const mono = new Float32Array(workLen);
  for (let i = 0; i < workLen; i++) {
    const srcPos = i / ratioSr;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(srcLen - 1, i0 + 1);
    const frac = srcPos - i0;
    let s0 = 0, s1 = 0;
    for (let c = 0; c < nCh; c++) {
      const ch = decoded.getChannelData(c);
      s0 += ch[i0];
      s1 += ch[i1];
    }
    mono[i] = (s0 + (s1 - s0) * frac) / nCh;
  }

  // Pitch down, same duration (destroys natural F0 / speaker cue)
  const pitched = pitchShiftDurationPreserve(mono, sr, -6);

  // Offline EQ / compress at same length
  const offline = new OfflineAudioContext(1, pitched.length, sr);
  const bufIn = offline.createBuffer(1, pitched.length, sr);
  bufIn.copyToChannel(pitched, 0);
  const source = offline.createBufferSource();
  source.buffer = bufIn;

  const hp = offline.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = 180;
  hp.Q.value = 0.7;

  // Shift perceived formants away from natural voice
  const notch = offline.createBiquadFilter();
  notch.type = "notch";
  notch.frequency.value = 900;
  notch.Q.value = 1.2;

  const formant = offline.createBiquadFilter();
  formant.type = "peaking";
  formant.frequency.value = 2200;
  formant.Q.value = 1.1;
  formant.gain.value = 5;

  const lp = offline.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = 3800;
  lp.Q.value = 0.75;

  const comp = offline.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 10;
  comp.ratio.value = 5;
  comp.attack.value = 0.004;
  comp.release.value = 0.12;

  source.connect(hp);
  hp.connect(notch);
  notch.connect(formant);
  formant.connect(lp);
  lp.connect(comp);
  comp.connect(offline.destination);
  source.start(0);
  const rendered = await offline.startRendering();
  const data = rendered.getChannelData(0);
  const len = data.length;

  // Light robotic color (identification, not mud)
  const carrierHz = 60;
  const ringMix = 0.22;
  const drive = 1.35;
  const twoPi = Math.PI * 2;
  let peakAbs = 0;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = Math.tanh(data[i] * drive);
    const ring = s * Math.sin(twoPi * carrierHz * (i / sr));
    s = s * (1 - ringMix) + ring * ringMix;
    out[i] = s;
    const a = Math.abs(s);
    if (a > peakAbs) peakAbs = a;
  }
  const g = peakAbs > 1e-6 ? 0.9 / peakAbs : 1;
  for (let i = 0; i < len; i++) {
    let s = out[i] * g;
    if (s > 0.97) s = 0.97;
    else if (s < -0.97) s = -0.97;
    out[i] = s;
  }

  const ac = new Ctx();
  const outBuf = ac.createBuffer(1, len, sr);
  outBuf.copyToChannel(out, 0);
  const result = encodeWavBlob(outBuf);
  try { await ac.close(); } catch (e) {}
  return result;
}

/**
 * Pitch shift by `semitones` keeping buffer length (OLA grains).
 * Negative semitones → deeper; breaks speaker F0 while words stay timed.
 */
function pitchShiftDurationPreserve(input, sampleRate, semitones) {
  const pitchRatio = Math.pow(2, semitones / 12); // e.g. -6 → ~0.707
  const n = input.length;
  if (n < 64) return input;

  const grainSize = 1024;
  const hopOut = 256;
  const hopIn = hopOut * pitchRatio;
  const out = new Float32Array(n);
  const norm = new Float32Array(n);
  const win = new Float32Array(grainSize);
  for (let i = 0; i < grainSize; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (grainSize - 1));
  }

  let inPos = 0;
  let outPos = 0;
  while (outPos < n) {
    for (let i = 0; i < grainSize; i++) {
      const o = outPos + i;
      if (o >= n) break;
      // Resample input grain: pitchRatio < 1 → read slower through source (deeper)
      const srcIndex = inPos + i * pitchRatio;
      const i0 = Math.floor(srcIndex);
      const i1 = i0 + 1;
      let s = 0;
      if (i0 >= 0 && i0 < n) {
        const frac = srcIndex - i0;
        const a = input[i0] || 0;
        const b = i1 < n ? input[i1] : 0;
        s = a + (b - a) * frac;
      }
      const w = win[i];
      out[o] += s * w;
      norm[o] += w;
    }
    inPos += hopIn;
    outPos += hopOut;
    if (inPos >= n - 1) break;
  }

  for (let i = 0; i < n; i++) {
    if (norm[i] > 1e-6) out[i] /= norm[i];
  }
  return out;
}


function encodeWavBlob(buffer) {
  const sampleRate = buffer.sampleRate;
  const samples = buffer.getChannelData(0);
  const len = samples.length;
  const dataSize = len * 2;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  function str(o, s) { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); }
  str(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); str(8, "WAVE"); str(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, "data"); view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < len; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([ab], { type: "audio/wav" });
}


function mountWaPlayer(container, srcUrl) {
  if (!container) return null;
  container.innerHTML = "";
  const root = document.createElement("div");
  root.className = "wa-player";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "wa-play";
  btn.setAttribute("aria-label", "Play");
  const iconPlay = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
  const iconPause = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
  btn.innerHTML = iconPlay;
  const wave = document.createElement("div");
  wave.className = "wa-wave";
  for (let i = 0; i < 22; i++) {
    const s = document.createElement("span");
    s.style.height = (18 + Math.abs((i % 7) - 3) * 12) + "%";
    wave.appendChild(s);
  }
  const time = document.createElement("div");
  time.className = "wa-time";
  time.textContent = "0:00";
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  audio.src = srcUrl;
  audio.style.display = "none";
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }
  function syncTime() {
    const d = isFinite(audio.duration) ? audio.duration : 0;
    time.textContent = fmt(audio.currentTime) + (d ? " / " + fmt(d) : "");
  }
  btn.addEventListener("click", function () {
    if (audio.paused) {
      if (activeWaAudio && activeWaAudio !== audio) {
        try { activeWaAudio.pause(); } catch (e) {}
      }
      activeWaAudio = audio;
      audio.play().then(function () {
        root.classList.add("is-playing");
        btn.innerHTML = iconPause;
        btn.setAttribute("aria-label", "Pause");
      }).catch(function () {
        toast("Unable to play audio", "err");
      });
    } else {
      audio.pause();
      root.classList.remove("is-playing");
      btn.innerHTML = iconPlay;
      btn.setAttribute("aria-label", "Play");
    }
  });
  audio.addEventListener("timeupdate", syncTime);
  audio.addEventListener("loadedmetadata", syncTime);
  audio.addEventListener("ended", function () {
    root.classList.remove("is-playing");
    btn.innerHTML = iconPlay;
    btn.setAttribute("aria-label", "Play");
    audio.currentTime = 0;
    syncTime();
  });
  wave.addEventListener("click", function (e) {
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    const rect = wave.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * audio.duration;
  });
  root.appendChild(btn);
  root.appendChild(wave);
  root.appendChild(time);
  root.appendChild(audio);
  container.appendChild(root);
  return audio;
}

function attachPendingAudio() {
  if (!assertPlanForAudio()) return;
  if (!pendingAudioBlob) return;
  // One voice attachment only — drop any prior voice-* files
  selectedFiles = selectedFiles.filter(function (f) {
    return !(f && f.name && String(f.name).indexOf("voice-") === 0);
  });
  const ext = pendingAudioBlob.type.indexOf("wav") >= 0 ? "wav" : "webm";
  const name = "voice-" + new Date().toISOString().replace(/[:.]/g, "").slice(0, 15) + "." + ext;
  lastVoiceFileName = name;
  selectedFiles.push(new File([pendingAudioBlob], name, {
    type: pendingAudioBlob.type || "audio/webm",
    lastModified: Date.now(),
  }));
  renderFileList();
  saveBurnDraft();
  toast("Voice note attached", "ok");
}

function discardPendingAudio() {
  // Fully detach from drop payload
  if (lastVoiceFileName) {
    selectedFiles = selectedFiles.filter(function (f) { return f.name !== lastVoiceFileName; });
    lastVoiceFileName = null;
    renderFileList();
  }
  pendingAudioBlob = null;
  if (activeWaAudio) {
    try { activeWaAudio.pause(); } catch (e) {}
    activeWaAudio = null;
  }
  if (pendingAudioUrl) {
    try { URL.revokeObjectURL(pendingAudioUrl); } catch (e) {}
    pendingAudioUrl = null;
  }
  const mount = document.getElementById("audio-player-mount");
  if (mount) mount.innerHTML = "";
  $("#audio-preview").prop("hidden", true);
  $("#rec-timer").text("0:00");
}


function setPublisherBar(visible) {
  var bar = document.getElementById("publisher-bar");
  if (!bar) return;
  if (visible) {
    bar.hidden = false;
    bar.removeAttribute("hidden");
  } else {
    bar.hidden = true;
    bar.setAttribute("hidden", "");
  }
}

function closePublisherPreview() {
  var ret = publisherReturnTo || "active";
  publisherReturnTo = null;
  setPublisherBar(false);
  $("#download-card").hide();
  $("#dl-preview").prop("hidden", true).empty();
  $("#dl-files").empty();
  history.replaceState({}, "", "/burn");
  if (ret === "active" && activeDrop && activeDrop.token) {
    showActive(activeDrop);
    if (typeof loadMineDrops === "function") loadMineDrops();
    return;
  }
  // Home / mine: plans + library
  showPlansOnly();
  if (typeof loadMineDrops === "function") loadMineDrops();
}


/** True when content DEK is wrapped with a user passphrase (not link key). */
function burnNeedsE2EPassphrase(data) {
  try {
    if (!data || !data.encrypted || !data.enc_meta) return false;
    var w = data.enc_meta.wrap || {};
    return w.mode === "passphrase";
  } catch (e) {
    return false;
  }
}

/**
 * Gate UI for E2E passphrase before renderDropAccess.
 * Server view_token may already be issued (publisher); DEK still needs the passphrase.
 */
function showE2EPassphraseGate(token, data, viewToken) {
  var dlPw = document.getElementById("dl-password-wrap");
  if (dlPw) {
    dlPw.removeAttribute("hidden");
    dlPw.hidden = false;
    dlPw.style.display = "flex";
  }
  try { bindPassphraseToggles(); } catch (e) {}
  var dlInp = document.getElementById("dl-password");
  if (dlInp) {
    try { setPasswordInputVisible(dlInp, false); } catch (e) {}
    dlInp.value = "";
  }
  $("#dl-files").empty();
  $("#dl-preview").prop("hidden", true).empty();
  $("#dl-status").text("Passphrase required to decrypt this content");
  $("#btn-dl-unlock").off("click").on("click", function () {
    var pw = ($("#dl-password").val() || "").trim();
    if (!pw) { toast("Enter the passphrase", "warn"); return; }
    var $btn = $(this).prop("disabled", true).text("Unlocking…");
    function finish(viewTok) {
      window.__burnUnlockPass = pw;
      if (dlPw) {
        dlPw.setAttribute("hidden", "");
        dlPw.hidden = true;
        dlPw.style.display = "none";
      }
      $("#dl-password").val("");
      // Restore into local "My drops" — public links work without device ownership
      try {
        if (data && data.token) {
          upsertBurnLibrary({
            token: data.token || token,
            plan: data.plan,
            plan_label: data.plan_label,
            badge_class: data.badge_class,
            path: data.path || ("/burn/d/" + token),
            expires_at: data.expires_at,
            max_downloads: data.max_downloads,
            burn_after: data.burn_after,
            files: data.files || [],
          });
        } else if (token) {
          upsertBurnLibrary({ token: token, path: "/burn/d/" + token });
        }
        if (typeof loadMineDrops === "function") loadMineDrops();
      } catch (e) {}
      // Soft server claim when drop has no owner yet (legacy)
      try {
        $.ajax({
          url: "/api/burn/" + encodeURIComponent(token) + "/claim-device",
          method: "POST",
          data: { password: pw },
          headers: typeof ajaxHeaders === "function" ? ajaxHeaders() : {},
        });
      } catch (e2) {}
      renderDropAccess(token, data, viewTok || viewToken || "");
      toast("Unlocked", "ok");
      $btn.prop("disabled", false).text("Unlock");
    }
    // If we already have a view session (publisher-open), only need the DEK passphrase.
    if (viewToken) {
      finish(viewToken);
      return;
    }
    unlockBurnView(token, pw)
      .done(function (vt) {
        if (!vt) {
          toast("Unlock failed", "err");
          $btn.prop("disabled", false).text("Unlock");
          return;
        }
        finish(vt);
      })
      .fail(function (xhr) {
        var msg = "Invalid passphrase";
        try {
          var b = (xhr && xhr.responseJSON) || {};
          if (b.error) msg = b.error;
          if (b.retry_after) msg = msg + " (" + b.retry_after + "s)";
        } catch (e) {}
        toast(msg, "err");
        $btn.prop("disabled", false).text("Unlock");
      });
  });
}

function openPublisherPreview(token, returnTo) {
  token = token || (activeDrop && activeDrop.token);
  if (!token) {
    toast("No published drop selected", "warn");
    return;
  }
  publisherReturnTo = returnTo || "active";
  $("#plans-card").hide();
  $("#compose-card").hide();
  $("#active-card").hide();
  // Keep mine list memory but hide while previewing
  if ($("#mine-card").length) $("#mine-card").hide();
  $("#download-card").show();
  setPublisherBar(true);
  var lbl = document.getElementById("dl-section-label");
  if (lbl) lbl.textContent = "Published content";
  $("#dl-status").text("Loading your publication…");
  $("#dl-files").empty();
  $("#dl-preview").prop("hidden", true).empty();
  $("#dl-password-wrap").prop("hidden", true);
  var dlPw = document.getElementById("dl-password-wrap");
  if (dlPw) {
    dlPw.setAttribute("hidden", "");
    dlPw.hidden = true;
    dlPw.style.display = "none";
  }

  window.__burnDlToken = token;
  window.__burnDlMeta = null;
  window.__burnPreviewIdx = null;

  $.ajax({
    url: "/api/burn/" + encodeURIComponent(token) + "/publisher-open",
    method: "POST",
    headers: typeof ajaxHeaders === "function" ? ajaxHeaders() : {},
  })
    .done(function (data) {
      if (!data || !data.success) {
        $("#dl-status").text((data && data.error) || "Unavailable");
        toast((data && data.error) || "Could not open publication", "err");
        return;
      }
      window.__burnDlMeta = data;
      var bits = ["Publisher preview"];
      if (data.downloads_remaining != null) bits.push(data.downloads_remaining + " download(s) left");
      bits.push(formatBytes(data.total_bytes || 0));
      if (data.allow_view === false) bits.push("view off");
      if (data.allow_download === false) bits.push("download off");
      $("#dl-status").text(bits.join(" · "));
      if (timerInterval) clearInterval(timerInterval);
      function tick() { $("#dl-timer").text(formatRemain(data.expires_at)); }
      tick();
      timerInterval = setInterval(tick, 1000);
      if (data.badge_class || data.plan_label) {
        $("#dl-badge").attr("class", "badge " + (data.badge_class || "")).text(data.plan_label || data.plan || "Drop");
      }
      // E2E passphrase still required for DEK even when publisher owns the drop
      if (burnNeedsE2EPassphrase(data)) {
        showE2EPassphraseGate(token, data, data.view_token || "");
      } else {
        renderDropAccess(token, data, data.view_token || "");
      }
      requestAnimationFrame(function () {
        var card = document.getElementById("download-card");
        if (card && typeof card.scrollIntoView === "function") {
          card.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    })
    .fail(function () {
      // Ownership claim missing (legacy drops) — open public meta in publisher chrome
      openPublisherPreviewPublicFallback(token);
    });
}

function openPublisherPreviewPublicFallback(token) {
  $.ajax({
    url: "/api/burn/" + encodeURIComponent(token),
    headers: typeof ajaxHeaders === "function" ? ajaxHeaders() : {},
  })
    .done(function (data) {
      if (!data || !data.success) {
        $("#dl-status").text((data && data.error) || "Unavailable");
        toast((data && data.error) || "Could not open publication", "err");
        return;
      }
      window.__burnDlMeta = data;
      var bits = ["Preview"];
      if (data.downloads_remaining != null) bits.push(data.downloads_remaining + " download(s) left");
      bits.push(formatBytes(data.total_bytes || 0));
      $("#dl-status").text(bits.join(" · "));
      if (timerInterval) clearInterval(timerInterval);
      function tick() { $("#dl-timer").text(formatRemain(data.expires_at)); }
      tick();
      timerInterval = setInterval(tick, 1000);
      var dlPw = document.getElementById("dl-password-wrap");
      if (data.password_required) {
        if (dlPw) {
          dlPw.removeAttribute("hidden");
          dlPw.hidden = false;
          dlPw.style.display = "flex";
        }
        $("#dl-files").empty();
        $("#dl-preview").prop("hidden", true).empty();
        $("#dl-status").text("Passphrase required to view or download");
        showE2EPassphraseGate(token, data, "");
        return;
      }
      if (burnNeedsE2EPassphrase(data)) {
        // Encrypted content but server gate not required (edge) — still need DEK
        showE2EPassphraseGate(token, data, "");
        return;
      }
      if (dlPw) {
        dlPw.setAttribute("hidden", "");
        dlPw.hidden = true;
        dlPw.style.display = "none";
      }
      renderDropAccess(token, data, "");
    })
    .fail(function (xhr) {
      var msg = "Could not open publication";
      try {
        var body = xhr.responseJSON || JSON.parse(xhr.responseText || "{}");
        if (body && body.error) msg = body.error;
      } catch (e) {}
      $("#dl-status").text(msg);
      toast(msg, "err");
    });
}

function loadDownload(token) {
  // Public visitor path — not publisher preview
  publisherReturnTo = null;
  var bar = document.getElementById("publisher-bar");
  if (bar) { bar.hidden = true; bar.setAttribute("hidden", ""); }
  var lbl = document.getElementById("dl-section-label");
  if (lbl) lbl.textContent = "Shared content";
  $("#plans-card").hide();
  $("#compose-card").hide();
  $("#active-card").hide();
  if ($("#mine-card").length) $("#mine-card").hide();
  $("#download-card").show();
  $("#dl-status").text("Loading…");
  $("#dl-files").empty();
  $("#dl-preview").prop("hidden", true).empty();
  $("#dl-password-wrap").prop("hidden", true);

  window.__burnDlToken = token;
  window.__burnDlMeta = null;
  window.__burnPreviewIdx = null;

  $.ajax({ url: "/api/burn/" + encodeURIComponent(token), headers: ajaxHeaders() })
    .done(function (data) {
      if (!data.success) {
        $("#dl-status").text(data.error || "Unavailable");
        return;
      }
      window.__burnDlMeta = data;
      const bits = [];
      if (data.downloads_remaining != null) bits.push(data.downloads_remaining + " download(s) left");
      bits.push(formatBytes(data.total_bytes));
      if (data.allow_view === false) bits.push("view off");
      if (data.allow_download === false) bits.push("download off");
      $("#dl-status").text(bits.join(" · "));
      if (timerInterval) clearInterval(timerInterval);
      function tick() { $("#dl-timer").text(formatRemain(data.expires_at)); }
      tick();
      timerInterval = setInterval(tick, 1000);

      // Passphrase UI only when author set one on a plan that supports it
      var dlPw = document.getElementById("dl-password-wrap");
      if (dlPw) {
        dlPw.setAttribute("hidden", "");
        dlPw.hidden = true;
        dlPw.style.display = "none";
      }
      var needsPassphrase = !!(data.password_required);
      if (needsPassphrase) {
        if (dlPw) {
          dlPw.removeAttribute("hidden");
          dlPw.hidden = false;
          dlPw.style.display = "flex";
        }
        bindPassphraseToggles();
        var dlInp = document.getElementById("dl-password");
        if (dlInp) setPasswordInputVisible(dlInp, false);
        syncPwToggleUi(document.getElementById("btn-toggle-dl-password"), false);
        $("#dl-files").empty();
        $("#dl-preview").prop("hidden", true).empty();
        $("#dl-status").text("Passphrase required to view or download");
        $("#btn-dl-unlock").off("click").on("click", function () {
          const pw = ($("#dl-password").val() || "").trim();
          if (!pw) { toast("Enter the passphrase", "warn"); return; }
          const $btn = $(this).prop("disabled", true).text("Unlocking…");
          unlockBurnView(token, pw)
            .done(function (viewToken) {
              if (!viewToken) {
                toast("Unlock failed", "err");
                return;
              }
              window.__burnUnlockPass = pw;
              $("#dl-password-wrap").prop("hidden", true).hide();
              $("#dl-password").val("");
              try {
                upsertBurnLibrary({
                  token: token,
                  plan: data.plan,
                  plan_label: data.plan_label,
                  badge_class: data.badge_class,
                  path: data.path || ("/burn/d/" + token),
                  expires_at: data.expires_at,
                  max_downloads: data.max_downloads,
                  burn_after: data.burn_after,
                  files: data.files || [],
                });
                if (typeof loadMineDrops === "function") loadMineDrops();
              } catch (e) {}
              try {
                $.ajax({
                  url: "/api/burn/" + encodeURIComponent(token) + "/claim-device",
                  method: "POST",
                  data: { password: pw },
                  headers: typeof ajaxHeaders === "function" ? ajaxHeaders() : {},
                });
              } catch (e2) {}
              renderDropAccess(token, data, viewToken);
              toast("Unlocked", "ok");
            })
            .fail(function (xhr) {
              let msg = "Invalid passphrase";
              try {
                const b = (xhr && xhr.responseJSON) || {};
                if (b.error) msg = b.error;
                if (b.retry_after) msg = msg + " (" + b.retry_after + "s)";
              } catch (e) {}
              toast(msg, "err");
            })
            .always(function () {
              $btn.prop("disabled", false).text("Unlock");
            });
        });
      } else if (burnNeedsE2EPassphrase(data)) {
        showE2EPassphraseGate(token, data, "");
      } else {
        $("#dl-password-wrap").prop("hidden", true);
        $("#dl-password").val("");
        unlockBurnView(token, "")
          .done(function (viewToken) {
            renderDropAccess(token, data, viewToken || "");
          })
          .fail(function () {
            renderDropAccess(token, data, "");
          });
      }
    })
    .fail(function (xhr) {
      let msg = "Drop unavailable";
      try {
        const b = xhr.responseJSON || JSON.parse(xhr.responseText || "{}");
        if (b.error) msg = b.error;
      } catch (e) {}
      $("#dl-status").text(msg);
    });
}

function fileUrl(token, idx, viewToken, inline) {
  let url = "/api/burn/" + encodeURIComponent(token) + "/file/" + idx + "?";
  const q = [];
  if (inline) q.push("inline=1");
  if (viewToken) q.push("view_token=" + encodeURIComponent(viewToken));
  return url + q.join("&");
}

function unlockBurnView(token, password) {
  return $.ajax({
    url: "/api/burn/" + encodeURIComponent(token) + "/unlock",
    method: "POST",
    data: { password: password || "" },
    headers: ajaxHeaders(),
  }).then(function (data) {
    if (data && data.success && data.view_token) return data.view_token;
    return $.Deferred().reject({ responseJSON: data }).promise();
  });
}

function renderDropAccess(token, data, viewToken) {
  window.__burnDlMeta = data;
  window.__burnPreviewIdx = null;

  function paintStatus() {
    try {
      var bits = [];
      if (data && data.plan) bits.push(String(data.plan));
      if (data && data.downloads_remaining != null) bits.push(data.downloads_remaining + " download(s) left");
      if (data && data.expires_at) bits.push("until " + String(data.expires_at).replace("T", " ").slice(0, 16));
      if (data && data.encrypted) bits.push("E2E");
      if (bits.length) $("#dl-status").text(bits.join(" · "));
      else $("#dl-status").text("Ready");
    } catch (e) {
      $("#dl-status").text("Ready");
    }
  }
  paintStatus();

  function bodyWithKey(contentKey) {
    __burnContentKey = contentKey || null;
    _renderDropAccessBody(token, data, viewToken);
  }

  if (data && data.encrypted && data.enc_meta) {
    var secret = null;
    try {
      var mode = (data.enc_meta.wrap && data.enc_meta.wrap.mode) || "";
      if (mode === "passphrase") {
        secret = window.__burnUnlockPass || "";
        if (!secret) {
          $("#dl-status").text("Passphrase required to decrypt");
          return;
        }
      } else if (mode === "link") {
        secret = burnLinkKeyFromLocation() || data.link_key || (activeDrop && activeDrop.link_key) || __burnLinkKey;
        if (!secret) {
          $("#dl-status").text("Incomplete link — missing #k= key. Ask the publisher for the full URL.");
          toast("Share link is missing the decryption key fragment (#k=)", "err");
          return;
        }
      }
      burnE2E_unwrapDek(data.enc_meta, secret)
        .then(function (dek) {
          try { window.__burnUnlockPass = null; } catch (e) {}
          bodyWithKey(dek);
        })
        .catch(function () {
          $("#dl-status").text("Decryption failed — wrong key or corrupted envelope");
          toast("Cannot decrypt content", "err");
        });
    } catch (e) {
      $("#dl-status").text("Decryption failed");
    }
    return;
  }
  bodyWithKey(null);
}

function _renderDropAccessBody(token, data, viewToken) {
  const $fl = $("#dl-files").empty();
  $("#dl-preview").empty().prop("hidden", true);
  const allowView = data.allow_view !== false;
  const allowDl = data.allow_download !== false;
  const files = data.files || [];

  // Public list: Download button only (no View — content auto-shows when allowed)
  files.forEach(function (f, idx) {
    let actions = "";
    if (allowDl) {
      actions += ' <button type="button" class="btn btn-sm dl" data-idx="' + idx + '">Download</button>';
    } else if (!allowView) {
      actions = ' <span class="fmeta">No access</span>';
    }
    $fl.append(
      "<li data-file-idx=\"" + idx + "\"><span class=\"fname\">" + escapeHtml(f.filename) + "</span>" +
      "<span class=\"fmeta\">" + formatBytes(f.size) + actions + "</span></li>"
    );
  });

  $fl.find("button.dl").on("click", function () {
    const idx = $(this).data("idx");
    const vt = viewToken || "";
    const $btn = $(this);
    $btn.prop("disabled", true);
    const url = "/api/burn/" + encodeURIComponent(token) + "/file/" + idx;
    const opts = { method: vt ? "POST" : "GET", headers: ajaxHeaders(), credentials: "same-origin" };
    if (vt) {
      const fd = new FormData();
      fd.append("view_token", vt);
      opts.body = fd;
    }
    fetch(url, opts)
      .then(function (res) {
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (!res.ok) {
          if (ct.indexOf("application/json") !== -1) {
            return res.json().then(function (body) {
              throw new Error((body && body.error) || ("Download failed (" + res.status + ")"));
            });
          }
          throw new Error("Download failed (" + res.status + ")");
        }
        var fname = "download";
        try {
          var meta = (window.__burnDlMeta && window.__burnDlMeta.files && window.__burnDlMeta.files[idx]) || {};
          fname = meta.filename || fname;
        } catch (e) {}
        return res.arrayBuffer().then(function (buf) {
          var ready = __burnContentKey ? burnE2E_decryptBytes(buf, __burnContentKey) : Promise.resolve(buf);
          return ready.then(function (plain) {
            var blob = new Blob([plain]);
            var a = document.createElement("a");
            var obj = URL.createObjectURL(blob);
            a.href = obj;
            a.download = fname;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(function () { URL.revokeObjectURL(obj); }, 2000);
            toast("Download started", "ok");
            // Refresh remaining slots without full page navigation
            $.ajax({ url: "/api/burn/" + encodeURIComponent(token), headers: ajaxHeaders() })
              .done(function (data) {
                if (!data || !data.success) {
                  if (data && (data.status === "burned" || (data.error || "").toLowerCase().indexOf("expired") !== -1)) {
                    $("#dl-status").text(data.error || "This drop has expired and burned");
                    $("#dl-files").empty();
                    $("#dl-preview").prop("hidden", true).empty();
                  }
                  return;
                }
                window.__burnDlMeta = data;
                var bits = [];
                if (data.downloads_remaining != null) bits.push(data.downloads_remaining + " download(s) left");
                bits.push(formatBytes(data.total_bytes || 0));
                $("#dl-status").text(bits.join(" · "));
              });
          });
        });
      })
      .catch(function (err) {
        toast((err && err.message) || "Download failed", "err");
      })
      .finally(function () {
        $btn.prop("disabled", false);
      });
  });

  // Author enabled in-browser view → show all readable content automatically
  if (allowView && files.length) {
    const $stack = $("#dl-preview").empty().prop("hidden", false);
    files.forEach(function (f, idx) {
      const k = f.kind || "file";
      const ct = f.content_type || "";
      const name = f.filename || "";
      if (
        k === "note" || k === "audio" || k === "image" ||
        name.endsWith(".html") ||
        ct.indexOf("audio/") === 0 ||
        ct.indexOf("image/") === 0
      ) {
        appendInlineBlock($stack, token, f, idx, viewToken);
      }
    });
    if (!$stack.children().length) {
      $stack.prop("hidden", true);
    }
  }
}


function sanitizeNoteHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
  doc.querySelectorAll("script, iframe, object, embed, form, link[rel=import], meta, base").forEach(function (n) {
    n.remove();
  });
  doc.querySelectorAll("*").forEach(function (el) {
    Array.from(el.attributes).forEach(function (attr) {
      const n = attr.name.toLowerCase();
      const v = (attr.value || "").trim().toLowerCase();
      if (n.startsWith("on")) {
        el.removeAttribute(attr.name);
        return;
      }
      if (
        (n === "href" || n === "src" || n === "xlink:href" || n === "action") &&
        (v.startsWith("javascript:") || v.startsWith("vbscript:") || v.startsWith("data:text/html"))
      ) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body ? doc.body.innerHTML : "";
}

async function appendInlineBlock($stack, token, file, idx, viewToken) {
  const block = $('<div class="preview-block"></div>');
  block.append('<div class="preview-label">' + escapeHtml(file.filename) + "</div>");
  $stack.append(block);
  const url = fileUrl(token, idx, viewToken, true);
  const kind = file.kind || "file";
  const ct = file.content_type || "";

  if (kind === "audio" || ct.indexOf("audio/") === 0) {
    const hold = document.createElement("div");
    block.append(hold);
    if (__burnContentKey) {
      fetch(url, { headers: ajaxHeaders() }).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        return burnE2E_decryptBytes(buf, __burnContentKey);
      }).then(function (plain) {
        var blobUrl = URL.createObjectURL(new Blob([plain], { type: ct || "audio/*" }));
        mountWaPlayer(hold, blobUrl);
      }).catch(function () {
        hold.textContent = "Decrypt failed";
      });
    } else {
      mountWaPlayer(hold, url);
    }
    return;
  }
  if (kind === "image" || ct.indexOf("image/") === 0) {
    const img = document.createElement("img");
    img.className = "preview-img";
    img.alt = file.filename || "image";
    block.append(img);
    if (__burnContentKey) {
      fetch(url, { headers: ajaxHeaders() }).then(function (r) { return r.arrayBuffer(); }).then(function (buf) {
        return burnE2E_decryptBytes(buf, __burnContentKey);
      }).then(function (plain) {
        img.src = URL.createObjectURL(new Blob([plain], { type: ct || "image/*" }));
      }).catch(function () {
        img.alt = "Decrypt failed";
      });
    } else {
      img.src = url;
    }
    return;
  }
  if (kind === "note" || (file.filename || "").endsWith(".html")) {
    try {
      const res = await fetch(url, { headers: ajaxHeaders() });
      if (!res.ok) {
        let msg = "Unable to open note";
        try {
          const b = await res.json();
          if (b.error) msg = b.error;
        } catch (e) {}
        block.append('<p style="color:var(--muted);font-size:0.9rem;">' + escapeHtml(msg) + "</p>");
        return;
      }
      var buf = await res.arrayBuffer();
      if (__burnContentKey) {
        buf = await burnE2E_decryptBytes(buf, __burnContentKey);
      }
      const html = new TextDecoder().decode(buf);
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script, iframe, object, embed").forEach(function (n) { n.remove(); });
      const wrap = document.createElement("div");
      wrap.className = "note-view";
      wrap.innerHTML = sanitizeNoteHtml(doc.body ? doc.body.innerHTML : "");
      block.append(wrap);
    } catch (e) {
      block.append('<p style="color:var(--muted);font-size:0.9rem;">Unable to open note</p>');
    }
  }
}


function openAuthorPreview() {
  // Exact recipient reading experience from current editor + pending files
  const t = TIERS[selectedPlanId];
  if (!t) { toast("Select a plan first", "warn"); return; }
  $("#plans-card").hide();
  $("#compose-card").hide();
  $("#active-card").hide();
  $("#download-card").show();
  $("#dl-password-wrap").prop("hidden", true);
  $("#dl-status").text("Author preview · not published yet");
  $("#dl-timer").text(formatDuration(t.ttl_minutes));
  $("#dl-badge").text(t.label);
  const $prev = $("#dl-preview").empty().prop("hidden", false);
  const $fl = $("#dl-files").empty();

  const noteHtml = ($("#note-editor").html() || "").trim();
  const noteText = getNotePlainLength();
  if (noteText > 0 || noteHtml.indexOf("<img") >= 0) {
    $fl.append('<li><span class="fname">secure-note.html</span><span class="fmeta">note</span></li>');
    $prev.append('<div class="preview-label">secure-note.html</div>');
    const wrap = document.createElement("div");
    wrap.className = "note-view";
    wrap.innerHTML = sanitizeNoteHtml(noteHtml);
    $prev.append(wrap);
  }
  selectedFiles.forEach(function (f) {
    $fl.append(
      "<li><span class=\"fname\">" + escapeHtml(f.name) + "</span>" +
      "<span class=\"fmeta\">" + formatBytes(f.size) + "</span></li>"
    );
    if ((f.type || "").indexOf("audio/") === 0) {
      const url = URL.createObjectURL(f);
      $prev.append('<div class="preview-label" style="margin-top:1rem;">' + escapeHtml(f.name) + "</div>");
      const hold = document.createElement("div");
      $prev.append(hold);
      mountWaPlayer(hold, url);
    }
  });
  if (!$prev.children().length) {
    $prev.append('<p style="color:var(--muted)">Nothing to preview yet.</p>');
  }
  $prev.append(
    '<div style="margin-top:1rem;"><button type="button" class="btn btn-ghost btn-sm" id="btn-preview-back">Back to editor</button></div>'
  );
  $("#btn-preview-back").on("click", function () {
    $("#download-card").hide();
    $("#compose-card").show();
  });
}

$(function () {
  bindPassphraseToggles();

  initThemeToggle();

  // Restore published drop or in-progress draft after reload
  const pathTokBoot = (location.pathname || "").match(/\/burn\/d\/([A-Za-z0-9_\-]+)/);
  const vaultBoot = (window.NessVault ? NessVault.ensureVault() : Promise.resolve({ ok: true }));
  vaultBoot.then(function () {
    if (!pathTokBoot) {
      // Home first (plans + live drops). Soft-restore library; draft only if no sticky manage UI.
      return hydrateBurnLibrary().then(function () {
        restoreBurnActive();
        return restoreBurnDraft();
      });
    }
  });

  $("#note-editor").on("blur", function () { saveBurnDraft(); });
  $("#opt-allow-view, #opt-allow-download, #opt-burn-after").on("change", saveBurnDraft);

  function bootPlans() {
    const keys = (typeof TIERS === "object" && TIERS) ? Object.keys(TIERS) : [];
    if (keys.length) {
      renderPlans();
      return;
    }
    $.getJSON("/api/burn/tiers")
      .done(function (data) {
        if (data && data.tiers) {
          window.TIERS = data.tiers;
        }
        renderPlans();
      })
      .fail(function () {
        toast("Unable to load plans", "err");
      });
  }
  bootPlans();
  $("#burn-dot").css("background", "var(--accent)");
  $("#burn-status-label").text("Ready");

  $("#plans").on("click", ".plan", function () {
    selectPlan($(this).data("plan"));
  });

  $("#btn-continue-plan").on("click", function () {
    if (!TIERS[selectedPlanId]) {
      toast("Select a plan", "warn");
      return;
    }
    showCompose();
  });

  $("#btn-change-plan").on("click", function () {
    var doChange = function () {
      selectedFiles = [];
      renderFileList();
      stopRecordingQuiet();
      discardPendingAudio();
      if (typeof clearBurnDraft === "function") clearBurnDraft();
      showPlansOnly({ persistDraft: true });
    };
    var hasContent = (selectedFiles && selectedFiles.length) ||
      (typeof hasNoteContent === "function" && hasNoteContent());
    if (hasContent && typeof nessConfirm === "function") {
      nessConfirm({
        title: "Change plan and clear draft?",
        message: "Your current files and note will be discarded. This cannot be undone.",
        confirmLabel: "Change plan",
        danger: true,
      }).then(function (ok) { if (ok) doChange(); });
    } else {
      doChange();
    }
  });

  const dz = document.getElementById("dropzone");
  if (dz) {
    dz.addEventListener("click", function (e) {
      if (e.target.closest(".rm")) return;
      if (!planLocked) { toast("Select a plan first", "warn"); return; }
      $("#file-input").trigger("click");
    });
    dz.addEventListener("dragover", function (e) {
      e.preventDefault();
      if (planLocked) dz.classList.add("drag");
    });
    dz.addEventListener("dragleave", function () { dz.classList.remove("drag"); });
    dz.addEventListener("drop", function (e) {
      e.preventDefault();
      dz.classList.remove("drag");
      if (!planLocked) { toast("Select a plan first", "warn"); return; }
      const incoming = Array.from(e.dataTransfer.files || []);
      (async function () {
        for (let i = 0; i < incoming.length; i++) {
          if (!assertCanAddFile()) break;
          let f = incoming[i];
          try {
            var prepared = await prepareAttachmentForBurn(f);
            f = prepared.file;
            if (prepared.hygiene === "stripped") toast("Metadata cleaned", "ok");
            else toast("Filename neutralized — container metadata may remain", "warn");
          } catch (err) {
            toast((err && err.message) || "File refused", "err");
            continue;
          }
          selectedFiles.push(f);
        }
        renderFileList();
        saveBurnDraft();
      })();
    });
  }
  $("#file-input").on("change", function () {
    if (!planLocked) { toast("Select a plan first", "warn"); this.value = ""; return; }
    const incoming = Array.from(this.files || []);
    const inputEl = this;
    (async function () {
      for (let i = 0; i < incoming.length; i++) {
        if (!assertCanAddFile()) break;
        let f = incoming[i];
        try {
          var prepared = await prepareAttachmentForBurn(f);
          f = prepared.file;
          if (prepared.hygiene === "stripped") toast("Metadata cleaned", "ok");
          else toast("Filename neutralized — container metadata may remain", "warn");
        } catch (err) {
          toast((err && err.message) || "File refused", "err");
          continue;
        }
        selectedFiles.push(f);
      }
      inputEl.value = "";
      renderFileList();
      saveBurnDraft();
    })();
  });
  $("#file-list").on("click", ".rm", async function (e) {
    e.preventDefault();
    e.stopPropagation();
    var i = parseInt($(this).data("i"), 10);
    if (isNaN(i) || !selectedFiles[i]) return;
    var f = selectedFiles[i];
    if (typeof nessConfirm === "function") {
      var ok = await nessConfirm({
        title: "Remove file from draft?",
        message: f.name ? ("'" + f.name + "' will be removed from this draft.") : "Remove this file?",
        confirmLabel: "Remove",
        danger: false,
      });
      if (!ok) return;
    }
    selectedFiles.splice(i, 1);
    renderFileList();
    saveBurnDraft();
  });

  $("#btn-author-preview").on("click", function () { openAuthorPreview(); });

  $("#btn-burn-go").on("click", function () {
    try {
      const t = (typeof TIERS === "object" && TIERS) ? TIERS[selectedPlanId] : null;
      if (!t) {
        toast("Plan not ready — select a plan again", "warn");
        showPlansOnly();
        return;
      }
      const err = validateFilesAgainstPlan();
      if (err) { toast(err, "warn"); return; }
      // Re-enable if stuck from a previous interrupted publish
      $(this).prop("disabled", false);
      if (Number(t.price_nch) > 0) openPay();
      else createFree();
    } catch (e) {
      toast("Publish failed to start — try again", "err");
      try { console.error(e); } catch (e2) {}
    }
  });

  $("#btn-pay-cancel").on("click", closePay);
  $("#btn-pay-confirm").on("click", payAndUpload);
  $("#btn-copy-pay").on("click", function () {
    const a = $("#pay-address").text();
    if (navigator.clipboard) navigator.clipboard.writeText(a).then(function () { toast("Address copied", "ok"); });
  });
  $("#btn-open-published").on("click", function () {
    var tok = activeDrop && activeDrop.token;
    if (!tok) { toast("No publication selected", "warn"); return; }
    openPublisherPreview(tok, "active");
  });
  $("#btn-burn-home").on("click", function () {
    showPlansOnly();
    history.replaceState({}, "", "/burn");
  });
  $("#btn-publisher-back").on("click", function () {
    closePublisherPreview();
  });
  $("#btn-copy-link").on("click", function () {
    const a = ($("#active-link").text() || "").trim();
    if (!a) return;
    var hasKey = a.indexOf("#k=") !== -1;
    var done = function () {
      if (hasKey) toast("Link copied — keep the #k= fragment or the content cannot be decrypted", "ok");
      else toast("Link copied", "ok");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(a).then(done).catch(function () {
        toast("Copy failed", "err");
      });
    } else {
      toast("Clipboard unavailable", "warn");
    }
  });
  burnRenewMode = false;
  $("#btn-renew-drop").on("click", function () {
    if (!activeDrop || !activeDrop.token) {
      toast("No active drop to renew", "warn");
      return;
    }
    if (!TIERS[selectedPlanId] || Number(TIERS[selectedPlanId].price_nch) <= 0) {
      // pick first paid plan
      var keys = Object.keys(TIERS);
      for (var i = 0; i < keys.length; i++) {
        if (Number(TIERS[keys[i]].price_nch) > 0) { selectedPlanId = keys[i]; break; }
      }
      renderPlans();
    }
    burnRenewMode = true;
    openPay();
  });
  $("#btn-new-drop").on("click", function () {
    var go = function () {
      activeDrop = null;
      selectedFiles = [];
      clearBurnActive();
      clearBurnDraft();
      renderFileList();
      const noteEl = document.getElementById("note-editor");
      if (noteEl) noteEl.innerHTML = "";
      history.pushState({}, "", "/burn");
      showPlansOnly();
    };
    if (typeof nessConfirm === "function") {
      nessConfirm({
        title: "Start a new drop?",
        message: "Your published drop stays live with its current link until it expires.",
        confirmLabel: "New drop",
        danger: false,
      }).then(function (ok) { if (ok) go(); });
    } else {
      go();
    }
  });

  $("#note-editor").on("input", function () {
    if (hasNoteContent() && selectedFiles.length >= planCapacity()) {
      // note would be an extra item beyond capacity
      const withoutNote = selectedFiles.length;
      if (withoutNote >= planCapacity()) {
        toast("This plan allows " + planCapacity() + " item(s). Remove a file/voice to keep a note.", "warn");
        const el = document.getElementById("note-editor");
        if (el) el.innerHTML = "";
      }
    }
    updateNoteCount();
  });
  $("#note-editor").on("paste", function () {
    setTimeout(function () {
      if (hasNoteContent() && selectedFiles.length >= planCapacity()) {
        toast("This plan allows " + planCapacity() + " item(s). Remove a file/voice to keep a note.", "warn");
        const el = document.getElementById("note-editor");
        if (el) el.innerHTML = "";
      }
      updateNoteCount();
    }, 0);
  });
  $("#btn-note-image").on("click", function () {
    $("#note-image-input").trigger("click");
  });
  $("#note-image-input").on("change", function () {
    const f = this.files && this.files[0];
    if (f) insertImageAtCursor(f);
    this.value = "";
  });

  $("#btn-rec").on("click", function () {
    if ($(this).attr("aria-pressed") === "true") return;
    startRecording();
  });
  $("#btn-rec-stop").on("click", function () { stopRecording(); });
  $("#btn-audio-discard").on("click", async function () {
    if (typeof pendingAudioBlob !== "undefined" && pendingAudioBlob && typeof nessConfirm === "function") {
      var ok = await nessConfirm({
        title: "Discard voice note?",
        message: "The recording will be lost.",
        confirmLabel: "Discard",
        danger: true,
      });
      if (!ok) return;
    }
    discardPendingAudio();
  });

  const tok = tokenFromPath();
  if (tok) {
    loadDownload(tok);
  } else {
    showPlansOnly();
    if (typeof loadMineDrops === "function") loadMineDrops();
  }
});


