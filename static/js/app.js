
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

var pendingIntentId = null;
var pendingIntentAmount = null;
let currentMailboxToken = null;
let currentMailboxId = null; // deprecated — kept only to avoid hard crashes during hot reload
let currentPlanId = "free";
let selectedPlanId = "free";
let pendingUpgradePlan = null;
let timerInterval = null;
let pollTimer = null;
let inboxPage = 1;
const INBOX_PER_PAGE = 8;
let inboxPagination = null;

// ── Helpers ──────────────────────────────────────────────
function toast(msg, type) {
  type = type || "ok";
  const $t = $("<div>").addClass("toast " + type).text(msg);
  $("#toasts").append($t);
  setTimeout(() => $t.addClass("show"), 15);
  setTimeout(() => {
    $t.removeClass("show");
    setTimeout(() => $t.remove(), 280);
  }, 4000);
}

function escapeHtml(s) {
  return $("<div>").text(s || "").html();
}

function formatDuration(mins) {
  if (mins < 60) return mins + " min";
  if (mins < 24 * 60) return (mins / 60) + " h";
  const d = mins / (24 * 60);
  return d === 1 ? "1 day" : d + " days";
}

function formatPrice(n) {
  if (n <= 0) return '<span class="free">Free</span>';
  return n.toLocaleString() + " NCH";
}

// ── Plans UI ─────────────────────────────────────────────
function renderPlans() {
  const order = ["free", "flash", "session", "day", "week", "month"];
  let html = "";
  order.forEach(id => {
    const t = TIERS[id];
    if (!t) return;
    const rec = id === "day" ? " recommended" : "";
    const sel = id === selectedPlanId ? " selected" : "";
    const feats = [];
    feats.push("<strong>" + formatDuration(t.ttl_minutes) + "</strong> lifetime");
    feats.push("<strong>" + t.max_messages + "</strong> messages");
    if (t.custom_mode === "prefix") feats.push("Prefix custom");
    else if (t.custom_mode === "full") feats.push("Full custom");
    else feats.push("Random address");
    if (t.attachments) feats.push("Attach ≤ " + t.max_attachment_mb + " MB");
    if (t.priority) feats.push("Priority inbox");
    html += '<div class="plan' + sel + rec + '" data-plan="' + id + '" onclick="selectPlan(\'' + id + '\')">' +
      '<div class="plan-name">' + t.label + '</div>' +
      '<div class="plan-price">' + formatPrice(t.price_nch) + '</div>' +
      '<div class="plan-meta">' + feats.join("<br>") + '</div>' +
    '</div>';
  });
  $("#plans").html(html);
  $("#domain-hint").text("@" + DOMAIN);
  updateCustomRow();
  updateCreateButton();
}

function selectPlan(id) {
  selectedPlanId = id;
  $(".plan").removeClass("selected");
  $('.plan[data-plan="' + id + '"]').addClass("selected");
  updateCustomRow();
  updateCreateButton();
  // Intelligent scroll: bring Create / Upgrade actions into view on mobile
  const $actions = $("#plan-actions");
  if ($actions.length) {
    const rect = $actions[0].getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (rect.bottom > vh - 24 || rect.top < 80) {
      $actions[0].scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }
}

function updateCustomRow() {
  const t = TIERS[selectedPlanId];
  if (t && t.custom_address && currentMailboxToken === null) {
    $("#custom-row").addClass("visible");
    const ph = t.custom_mode === "prefix"
      ? "prefix (3–8 chars)"
      : "local-part (3–32 chars)";
    $("#custom-local").attr("placeholder", ph);
  } else {
    $("#custom-row").removeClass("visible");
  }
}

function updateCreateButton() {
  const t = TIERS[selectedPlanId];
  if (!t) return;
  if (currentMailboxToken === null) {
    $("#btn-create").show().text(
      t.price_nch > 0
        ? "Create · " + t.price_nch.toLocaleString() + " NCH"
        : "Create free mailbox"
    );
    $("#btn-upgrade").hide();
  } else {
    // Already have a mailbox — button becomes upgrade if higher tier
    $("#btn-create").hide();
    if (t.price_nch > (TIERS[currentPlanId] || {}).price_nch) {
      $("#btn-upgrade").show().text("Upgrade to " + t.label + " · " + t.price_nch.toLocaleString() + " NCH");
    } else {
      $("#btn-upgrade").hide();
    }
  }
}

function showPlansForUpgrade() {
  $("#plans-card").show();
  $("html, body").animate({ scrollTop: $("#plans-card").offset().top - 20 }, 280);
}

// ── Create mailbox ───────────────────────────────────────
function createMailbox() {
  const t = TIERS[selectedPlanId];
  if (!t) return;

  // Paid plans require payment first when creating fresh
  if (t.price_nch > 0 && currentMailboxToken === null) {
    pendingUpgradePlan = selectedPlanId;
    openPayModal(t);
    return;
  }

  const payload = { plan: selectedPlanId };
  if (t.custom_address) {
    const local = ($("#custom-local").val() || "").trim().toLowerCase();
    if (local) payload.custom_local = local;
  }

  $.post("/api/mailbox", payload)
    .done(function (data) {
      if (!data.success) {
        toast(data.error || "Could not create mailbox", "err");
        return;
      }
      activateMailboxUI(data);
      toast("Mailbox ready · " + data.address, "ok");
    })
    .fail(function () {
      toast("Network error while creating mailbox", "err");
    });
}

const SESSION_KEY = "ness-tempmail-session";
const DEVICE_KEY = "ness-device-id";
const DEVICE_KEY_LEGACY = ["ness-tempmail-device", "ness_device_id"];

function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      for (let i = 0; i < DEVICE_KEY_LEGACY.length; i++) {
        const v = localStorage.getItem(DEVICE_KEY_LEGACY[i]);
        if (v) { id = v; break; }
      }
    }
    if (id && /^[A-Za-z0-9_\-]{16,64}$/.test(id)) return id;
    // 18 bytes → ~24 url-safe chars
    const arr = new Uint8Array(18);
    if (window.crypto && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    let s = "";
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    id = btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    localStorage.setItem(DEVICE_KEY, id);
    try { localStorage.setItem("ness-tempmail-device", id); } catch (e) {}
    try { localStorage.setItem("ness_device_id", id); } catch (e) {}
    return id;
  } catch (e) {
    return "anon";
  }
}

// Attach device id to every API call (header preferred)
$.ajaxSetup({
  beforeSend: function (xhr) {
    try {
      xhr.setRequestHeader("X-Device-Id", getDeviceId());
    } catch (e) {}
  },
});

function saveSession(data) {
  (async function () {
    try {
      const payload = {
        token: data.token,
        address: data.address,
        plan: data.plan,
        plan_label: data.plan_label,
        badge_class: data.badge_class,
        max_messages: data.max_messages,
        expires_at: data.expires_at,
      };
      if (window.NessVault && !NessVault.isUnlocked()) {
        await NessVault.ensureVault();
      }
      if (window.NessVault && NessVault.isUnlocked()) {
        const sealed = await NessVault.encryptJson(payload);
        localStorage.setItem(SESSION_KEY, JSON.stringify({ v: 2, enc: true, sealed: sealed }));
      }
      // Fail closed if vault unavailable — mailbox token stays only in memory
    } catch (e) {}
  })();
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
}

function loadSession() {
  // Sync path cannot decrypt — returns null; restoreSession uses loadSessionAsync
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const sess = JSON.parse(raw);
    if (sess && sess.enc && sess.sealed) return null;
    // Legacy plaintext: wipe
    if (sess && sess.token && !sess.enc) {
      try { localStorage.removeItem(SESSION_KEY); } catch (e2) {}
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function loadSessionAsync() {
  try {
    if (window.NessVault && !NessVault.isUnlocked()) await NessVault.ensureVault();
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const sess = JSON.parse(raw);
    if (sess && sess.enc && sess.sealed && window.NessVault && NessVault.isUnlocked()) {
      return await NessVault.decryptJson(sess.sealed);
    }
    if (sess && sess.token && !sess.enc) {
      try { localStorage.removeItem(SESSION_KEY); } catch (e2) {}
    }
    return null;
  } catch (e) {
    return null;
  }
}

function activateMailboxUI(data, opts) {
  opts = opts || {};
  currentMailboxToken = data.token;
  currentMailboxId = null;
  currentPlanId = data.plan;
  selectedPlanId = data.plan;
  inboxPage = 1;

  $("#email-address").text(data.address);
  $("#plan-badge")
    .text(data.plan_label)
    .attr("class", "badge " + data.badge_class);
  $("#cap-label").text(data.max_messages + " msg capacity");
  $("#mailbox-card").show();
  $("#inbox-card").show();
  startTimer(data.expires_at);
  startPolling();
  renderPlans();
  updateCreateButton();
  saveSession(data);

  // Scroll only on fresh activation, not on page restore
  if (!opts.silent) {
    requestAnimationFrame(function () {
      const el = document.getElementById("mailbox-card");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
}

function restoreSession() {
  loadSessionAsync().then(function (sess) {
    if (!sess || !sess.token) return;
    _restoreSessionFrom(sess);
  });
}

function _restoreSessionFrom(sess) {
  if (!sess || !sess.token) return;

  // Optimistic UI from cache while we validate with the server
  if (sess.expires_at && new Date(sess.expires_at).getTime() <= Date.now()) {
    clearSession();
    return;
  }

  $.getJSON("/api/mailbox/" + encodeURIComponent(sess.token))
    .done(function (data) {
      if (!data.success) {
        clearSession();
        return;
      }
      activateMailboxUI(data, { silent: true });
    })
    .fail(function (xhr) {
      // 404 / 410 → mailbox gone or expired
      clearSession();
      if (xhr && (xhr.status === 410 || xhr.status === 404)) {
        toast("Previous mailbox expired or was removed", "warn");
      }
    });
}

// ── Timer ────────────────────────────────────────────────
function startTimer(expiresAt) {
  if (timerInterval) clearInterval(timerInterval);
  const end = new Date(expiresAt).getTime();
  function tick() {
    const diff = end - Date.now();
    const $el = $("#timer");
    if (diff <= 0) {
      clearInterval(timerInterval);
      $el.text("EXPIRED").addClass("critical");
      $("#email-address").text("(mailbox expired)");
      clearSession();
      currentMailboxToken = null;
      currentMailboxId = null;
      return;
    }
    const totalSec = Math.floor(diff / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    let str;
    if (h > 0) {
      str = h + "h " + String(m).padStart(2, "0") + "m";
    } else {
      str = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    }
    $el.text(str);
    $el.toggleClass("critical", diff < 120000);
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

// ── Inbox list + pagination ──────────────────────────────
function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function formatMsgTime(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    return d.toLocaleDateString([], { month: "short", day: "numeric" }) +
      " · " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch (e) {
    return iso || "";
  }
}

function renderInbox(data) {
  const list = data.messages || [];
  const pg = data.pagination || {};
  inboxPagination = pg;

  if (pg.total > 0) {
    $("#inbox-count").text(pg.total + (pg.total === 1 ? " message" : " messages"));
  } else {
    $("#inbox-count").text("");
  }

  if (!list.length) {
    $("#msg-list").html(
      '<div class="empty">' +
        '<svg class="empty-icon" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>' +
        "Waiting for messages…" +
      "</div>"
    );
    $("#pager").hide();
    return;
  }

  let html = "";
  list.forEach(function (msg) {
    const clip = msg.attachment_count > 0
      ? '<div class="msg-meta"><span class="msg-attach">' +
          '<svg viewBox="0 0 24 24"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>' +
          msg.attachment_count + (msg.attachment_count === 1 ? " file" : " files") +
        "</span></div>"
      : "";
    html +=
      '<div class="msg" role="button" tabindex="0" onclick="openMessage(' + msg.id + ')">' +
        '<div class="msg-top">' +
          '<span class="msg-from">' + escapeHtml(msg.sender || "") + "</span>" +
          '<span class="msg-time">' + formatMsgTime(msg.received_at) + "</span>" +
        "</div>" +
        '<div class="msg-subj">' + escapeHtml(msg.subject || "(no subject)") + "</div>" +
        '<div class="msg-preview">' + escapeHtml(msg.preview || "") + "</div>" +
        clip +
      "</div>";
  });
  $("#msg-list").html(html);

  if (pg.total_pages > 1) {
    $("#pager").show();
    $("#pager-info").text(pg.page + " / " + pg.total_pages);
    $("#pager-prev").prop("disabled", !pg.has_prev);
    $("#pager-next").prop("disabled", !pg.has_next);
  } else {
    $("#pager").hide();
  }
}

function fetchInbox(page) {
  if (!currentMailboxToken) return;
  if (page) inboxPage = page;
  $.getJSON("/api/messages/" + encodeURIComponent(currentMailboxToken), {
    page: inboxPage,
    per_page: INBOX_PER_PAGE,
  })
    .done(function (data) {
      if (!data.success) {
        if (data.error) toast(data.error, "err");
        return;
      }
      // If current page emptied (e.g. after expiry edge), step back
      if ((!data.messages || !data.messages.length) && data.pagination && data.pagination.page > 1) {
        inboxPage = data.pagination.page - 1;
        fetchInbox(inboxPage);
        return;
      }
      renderInbox(data);
    });
}

function inboxPrev() {
  if (inboxPagination && inboxPagination.has_prev) fetchInbox(inboxPage - 1);
}
function inboxNext() {
  if (inboxPagination && inboxPagination.has_next) fetchInbox(inboxPage + 1);
}

function startPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  function poll() {
    if (!currentMailboxToken) return;
    fetchInbox();
    pollTimer = setTimeout(poll, 5000);
  }
  poll();
}

// ── Message reader ───────────────────────────────────────
function openMessage(messageId) {
  if (!currentMailboxToken || !messageId) return;
  $("#reader-body").html('<p class="reader-loading">Loading…</p>');
  $("#reader-overlay").addClass("open");
  $("body").css("overflow", "hidden");

  $.getJSON("/api/messages/" + encodeURIComponent(currentMailboxToken) + "/" + messageId)
    .done(function (data) {
      if (!data.success || !data.message) {
        $("#reader-body").html('<p class="reader-loading">Message unavailable.</p>');
        return;
      }
      renderReader(data.message);
    })
    .fail(function () {
      $("#reader-body").html('<p class="reader-loading">Failed to load message.</p>');
    });
}

function closeReader() {
  $("#reader-overlay").removeClass("open");
  $("body").css("overflow", "");
}

function substituteCidImages(container, attachments) {
  const map = {};
  (attachments || []).forEach(function (a) {
    if (a.content_id) map[a.content_id] = a;
  });
  container.querySelectorAll('img[src^="cid:"]').forEach(function (img) {
    const cid = (img.getAttribute("src") || "").substring(4).replace(/^<|>$/g, "");
    const att = map[cid];
    if (att && att.data_b64) {
      img.src = "data:" + (att.content_type || "image/png") + ";base64," + att.data_b64;
    }
  });
}

function renderReader(msg) {
  let meta =
    '<div class="reader-meta">' +
      '<div class="reader-meta-row"><span class="reader-meta-label">From</span><span class="reader-meta-val">' + escapeHtml(msg.sender || "") + "</span></div>" +
      '<div class="reader-meta-row"><span class="reader-meta-label">To</span><span class="reader-meta-val">' + escapeHtml(msg.recipient || "") + "</span></div>" +
      '<div class="reader-meta-row"><span class="reader-meta-label">Date</span><span class="reader-meta-val">' + escapeHtml(formatMsgTime(msg.received_at)) + "</span></div>" +
    "</div>";

  const atts = msg.attachments || [];
  const plain = (msg.body || "").trim();
  const hasHtml = !!(msg.body_html && String(msg.body_html).trim());

  let bodyHtml;
  if (hasHtml) {
    const cleaned = sanitizeHtml(msg.body_html);
    bodyHtml = '<div class="reader-content html-body">' + cleaned + "</div>";
  } else if (plain) {
    bodyHtml = '<div class="reader-content">' + escapeHtml(msg.body || "") + "</div>";
  } else {
    bodyHtml =
      '<div class="reader-empty">' +
        '<span class="reader-empty-label">No message body</span>' +
        '<span class="reader-empty-hint">This mail has no text or HTML content.</span>' +
      "</div>";
  }

  // File attachments only — pure cid: inline images are rendered in the body
  const fileAtts = [];
  atts.forEach(function (a, idx) {
    if (a && a.content_id && (a.content_type || "").indexOf("image/") === 0) {
      return; // shown inline after cid substitution
    }
    fileAtts.push({ att: a, idx: idx });
  });

  let attachHtml = "";
  if (fileAtts.length) {
    attachHtml =
      '<div class="attach-section">' +
        "<h4>Attachments · " + fileAtts.length + "</h4>" +
        '<div class="attach-list">';
    fileAtts.forEach(function (item) {
      const a = item.att;
      attachHtml +=
        '<div class="attach-item">' +
          '<div class="attach-icon"><svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>' +
          '<div class="attach-info">' +
            '<div class="attach-name">' + escapeHtml(a.filename || "file") + "</div>" +
            '<div class="attach-size">' + formatBytes(a.size) + " · " + escapeHtml((a.content_type || "").split(";")[0]) + "</div>" +
          "</div>" +
          '<button type="button" class="btn btn-ghost btn-sm" data-att-idx="' + item.idx + '">Download</button>' +
        "</div>";
    });
    attachHtml += "</div></div>";
  }

  const subjectText = msg.subject || "(no subject)";
  $("#reader-body").html(
    '<div class="reader-subject" id="reader-subject">' + escapeHtml(subjectText) + "</div>" +
    '<button type="button" class="reader-subject-toggle" id="reader-subject-toggle">Show full subject</button>' +
    meta + bodyHtml + attachHtml
  );

  // Long-subject affordance: clamp by default, expand on demand
  requestAnimationFrame(function () {
    const subj = document.getElementById("reader-subject");
    const btn = document.getElementById("reader-subject-toggle");
    if (!subj || !btn) return;
    const clamped = subj.scrollHeight > subj.clientHeight + 2;
    if (clamped) {
      btn.classList.add("is-visible");
      btn.onclick = function () {
        const open = subj.classList.toggle("is-expanded");
        btn.textContent = open ? "Show less" : "Show full subject";
      };
    }
  });

  const readerEl = document.getElementById("reader-body");
  if (readerEl) {
    // Resolve cid: → data: then neutralize broken external imgs under CSP
    substituteCidImages(readerEl, atts);
    readerEl.querySelectorAll("img").forEach(function (img) {
      img.addEventListener("error", function () {
        if (img.dataset.broken === "1") return;
        img.dataset.broken = "1";
        img.classList.add("img-blocked");
        img.alt = img.alt || "Image unavailable";
      });
    });
  }

  $("#reader-body").find("button[data-att-idx]").each(function () {
    const idx = parseInt($(this).attr("data-att-idx"), 10);
    const att = atts[idx];
    if (!att || !att.data_b64) return;
    $(this).on("click", function (e) {
      e.stopPropagation();
      downloadBase64(att.data_b64, att.filename || "download", att.content_type || "application/octet-stream");
    });
  });
}

function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
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
        (v.startsWith("javascript:") ||
          v.startsWith("vbscript:") ||
          v.startsWith("data:text/html"))
      ) {
        el.removeAttribute(attr.name);
        if (n === "href" && el.tagName === "A") {
          el.setAttribute("href", "#");
          el.setAttribute("title", "Blocked unsafe link");
        }
      }
    });
  });
  return doc.body.innerHTML;
}

function downloadBase64(b64, filename, mime) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  } catch (e) {
    toast("Could not download file", "err");
  }
}

// Close reader on Escape
$(document).on("keydown", function (e) {
  if (e.key === "Escape") closeReader();
});

// ── Payment ──────────────────────────────────────────────
function openPayForSelected() {
  const t = TIERS[selectedPlanId];
  if (!t || t.price_nch <= 0) return;
  pendingUpgradePlan = selectedPlanId;
  openPayModal(t);
}

function openPayModal(tier) {
  pendingIntentId = null;
  pendingIntentAmount = null;
  $("#pay-title").text("Activate " + tier.label);
  $("#pay-sub").text("Preparing payment…");
  $("#pay-address").text(PAY_ADDRESS);
  $("#pay-amount").html("…");
  $("#tx-hash").val("");
  $("#btn-copy-pay").removeClass("copied");
  if ($("#pay-qr-wrap").length) $("#pay-qr-wrap").empty();
  // Design system: .overlay.open { display:flex }. Must set class so closePay can hide it.
  $("#pay-modal").addClass("open").css("display", "flex");
  $.post("/api/payment/intent", { product: "mail", plan: tier.id || selectedPlanId || pendingUpgradePlan })
    .done(function (data) {
      if (!data || !data.success) {
        toast((data && data.error) || "Could not create payment intent", "err");
        closePay();
        return;
      }
      pendingIntentId = data.intent_id;
      try {
        sessionStorage.setItem("ness_pay_intent_mail", JSON.stringify({
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
        " NCH to the address below, then paste the transaction hash."
      );
      $("#pay-address").text(data.pay_address || PAY_ADDRESS);
      $("#pay-amount").html(Number(data.amount_nch).toLocaleString() + ' <span>NCH</span>');
      if (typeof renderPayQr === "function") renderPayQr(data.pay_address || PAY_ADDRESS);
    })
    .fail(function () {
      toast("Could not create payment intent", "err");
      closePay();
    });
}


function explorerFailMessage(d) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "No internet connection — verify your network and try again";
  }
  if (d && d.connectivity === "offline") {
    return d.error || "No internet connection — verify your network and try again";
  }
  if (d && d.connectivity === "explorer_down") {
    return (d.error || "PrivateNess explorer is down") + " — payments cannot be verified right now";
  }
  if (d && d.error) return d.error;
  return "PrivateNess explorer is down — payments cannot be verified right now";
}

function closePay() {
  // Always clear both class and inline display (open path used to set display:flex only).
  $("#pay-modal").removeClass("open").stop(true, true).hide().css("display", "none");
  pendingUpgradePlan = null;
  mailRenewMode = false;
  pendingIntentId = null;
  pendingIntentAmount = null;
}

function copyPayAddress() {
  const addr = ($("#pay-address").text() || "").trim();
  if (!addr || addr === "—") return;
  function markBtn() {
    const $b = $("#btn-copy-pay");
    $b.addClass("copied");
    setTimeout(function () { $b.removeClass("copied"); }, 1600);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(addr).then(function () {
      toast("Payment address copied", "ok");
      markBtn();
    }).catch(function () {
      fallbackCopy(addr);
      markBtn();
    });
  } else {
    fallbackCopy(addr);
    markBtn();
  }
}

function fallbackCopy(text) {
  const $tmp = $("<textarea>").val(text).css({ position: "fixed", left: "-9999px" }).appendTo("body");
  $tmp[0].select();
  try { document.execCommand("copy"); toast("Payment address copied", "ok"); }
  catch (e) { toast("Could not copy", "err"); }
  $tmp.remove();
}

function togglePayQr() {
  const $wrap = $("#pay-qr-wrap");
  if ($wrap.hasClass("open")) {
    $wrap.removeClass("open");
    $("#pay-qr-frame").empty();
    $("#btn-qr-toggle").text("Show QR code");
    return;
  }
  $wrap.addClass("open");
  $("#btn-qr-toggle").text("Hide QR code");
  const $frame = $("#pay-qr-frame").empty();
  const addr = PAY_ADDRESS || "";
  if (typeof QRCode === "undefined") {
    // CDN fallback: external QR image
    const url = "https://api.qrserver.com/v1/create-qr-code/?size=140x140&margin=8&data=" +
      encodeURIComponent(addr);
    $frame.append($("<img>", { src: url, alt: "Payment address QR", width: 140, height: 140 }));
    return;
  }
  // High-contrast QR on white tile for reliable scanning
  QRCode.toCanvas(addr, {
    width: 140,
    margin: 2,
    color: { dark: "#0A0A0A", light: "#FFFFFF" },
    errorCorrectionLevel: "M",
  }, function (err, canvas) {
    if (err || !canvas) {
      const url = "https://api.qrserver.com/v1/create-qr-code/?size=140x140&margin=8&data=" +
        encodeURIComponent(addr);
      $frame.append($("<img>", { src: url, alt: "Payment address QR", width: 140, height: 140 }));
      return;
    }
    $frame.append(canvas);
  });
}

function confirmPay() {
  const tx = ($("#tx-hash").val() || "").trim();
  if (tx.length < 16) {
    toast("Transaction hash looks too short", "warn");
    return;
  }
  if (mailRenewMode && currentMailboxToken) {
    if (!pendingIntentId) {
      toast("Payment session expired — reopen payment", "warn");
      return;
    }
    const planId = selectedPlanId || currentPlanId;
    const $btn = $("#pay-modal .modal-actions .btn:not(.btn-ghost)");
    const prevLabel = $btn.text();
    setPayBtnBusy($btn, true); $btn.html('<span class="btn-spinner" aria-hidden="true"></span> Renewing…');
    $.post("/api/mailbox/renew", {
      token: currentMailboxToken,
      plan: planId,
      tx_hash: tx,
      intent_id: pendingIntentId,
    }).done(function (data) {
      setPayBtnBusy($btn, false, prevLabel);
      if (!data || !data.success) {
        toast((data && data.error) || "Renew failed", "err");
        return;
      }
      mailRenewMode = false;
      closePay();
      if (data.expires_at) startTimer(data.expires_at);
      if (data.plan) {
        currentPlanId = data.plan;
        selectedPlanId = data.plan;
        var t = TIERS[data.plan];
        if (t) {
          $("#plan-badge").text(t.label).attr("class", "badge " + t.badge_class);
        }
      }
      toast("Mailbox renewed · remaining time kept", "ok");
      try { sessionStorage.removeItem("ness_pay_intent_mail"); } catch (e) {}
    }).fail(function (xhr) {
      setPayBtnBusy($btn, false, prevLabel);
      let msg = "Renew failed";
      try { msg = (xhr.responseJSON && xhr.responseJSON.error) || msg; } catch (e) {}
      toast(msg, "err");
    });
    return;
  }
  const planId = pendingUpgradePlan || selectedPlanId;
  const tier = TIERS[planId];
  if (!tier) {
    toast("Invalid plan", "err");
    return;
  }

  const $btn = $("#pay-modal .modal-actions .btn:not(.btn-ghost)");
  const prevLabel = $btn.text();
  setPayBtnBusy($btn, true);

  if (!pendingIntentId) {
    try {
      var _pi = JSON.parse(sessionStorage.getItem("ness_pay_intent_mail") || "null");
      if (_pi && _pi.intent_id && (!_pi.expires_at || new Date(_pi.expires_at).getTime() > Date.now())) {
        pendingIntentId = _pi.intent_id;
        pendingIntentAmount = _pi.amount_nch;
      }
    } catch (e) {}
  }
  if (!pendingIntentId) {
    toast("Payment session expired — reopen the payment dialog", "warn");
    setPayBtnBusy($btn, false, prevLabel);
    return;
  }
  const payload = {
    plan: planId,
    tx_hash: tx,
    amount: pendingIntentAmount || tier.price_nch,
    intent_id: pendingIntentId,
  };
  if (currentMailboxToken) {
    payload.token = currentMailboxToken;
  }
  if (tier.custom_address) {
    const local = ($("#custom-local").val() || "").trim().toLowerCase();
    if (local) payload.custom_local = local;
  }

  $.post("/api/payment/verify", payload)
    .done(function (data) {
      setPayBtnBusy($btn, false, prevLabel);
      if (!data.success) {
        if (data.explorer_ok === false) {
          toast(explorerFailMessage(data), "err");
        } else {
          toast(data.error || "Payment verification failed", "err");
        }
        return;
      }
      closePay();
      try { sessionStorage.removeItem("ness_pay_intent_mail"); } catch (e) {}
      try { sessionStorage.removeItem("ness_pay_intent_mail"); } catch (e) {}
      toast("Payment verified on-chain · " + (data.hours_received || tier.price_nch) + " NCH", "ok");
      if (data.token && !currentMailboxToken) {
        activateMailboxUI(data);
      } else {
        currentPlanId = data.plan;
        selectedPlanId = data.plan;
        if (data.token) currentMailboxToken = data.token;
        $("#plan-badge")
          .text(data.plan_label)
          .attr("class", "badge " + data.badge_class);
        $("#cap-label").text(data.max_messages + " msg capacity");
        if (data.address) $("#email-address").text(data.address);
        startTimer(data.expires_at);
        renderPlans();
        updateCreateButton();
        saveSession({
          token: currentMailboxToken,
          address: data.address || $("#email-address").text(),
          plan: data.plan,
          plan_label: data.plan_label,
          badge_class: data.badge_class,
          max_messages: data.max_messages,
          expires_at: data.expires_at,
        });
      }
    })
    .fail(function (xhr) {
      setPayBtnBusy($btn, false, prevLabel);
      let msg = "Network error during payment verification";
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        msg = "No internet connection — verify your network and try again";
      } else if (!xhr.status || xhr.status === 0) {
        msg = "No internet connection — verify your network and try again";
      } else {
        try {
          const body = xhr.responseJSON || JSON.parse(xhr.responseText || "{}");
          if (body && body.explorer_ok === false) {
            msg = explorerFailMessage(body);
          } else if (body && body.error) {
            msg = body.error;
          }
        } catch (e) { /* keep default */ }
      }
      toast(msg, "err");
    });
}

// ── Copy ─────────────────────────────────────────────────
function copyAddress() {
  const t = $("#email-address").text();
  if (!t || t.startsWith("(")) return;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(t).then(() => toast("Address copied", "ok"));
  } else {
    const $tmp = $("<input>").val(t).appendTo("body").select();
    document.execCommand("copy");
    $tmp.remove();
    toast("Address copied", "ok");
  }
}

// ── Status ───────────────────────────────────────────────
function refreshStatus() {
  $.getJSON("/api/status")
    .done(function (d) {
      if (d.smtp_enabled) {
        $("#smtp-dot").removeClass("offline").addClass("online");
        $("#smtp-label").text("Reception online · " + d.domain);
      } else {
        $("#smtp-dot").removeClass("online").addClass("offline");
        $("#smtp-label").text("Reception offline (SMTP not installed)");
      }
    })
    .fail(function () {
      $("#smtp-label").text("Status unavailable");
    });
}

// ── Theme ────────────────────────────────────────────────
function applyTheme(theme) {
  if (theme === "light") {
    document.documentElement.setAttribute("data-theme", "light");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  try { localStorage.setItem("ness_theme", theme); } catch (e) {}
}

function toggleTheme() {
  const isLight = document.documentElement.getAttribute("data-theme") === "light";
  applyTheme(isLight ? "dark" : "light");
}

// ── Boot ─────────────────────────────────────────────────
$(function () {
  // Restore theme preference
  let saved = "dark";
  try { saved = localStorage.getItem("ness_theme") || "dark"; } catch (e) {}
  applyTheme(saved === "light" ? "light" : "dark");
  $("#theme-toggle").on("click", toggleTheme);

  renderPlans();
  refreshStatus();
  setInterval(refreshStatus, 30000);

  // Restore active mailbox after refresh / navigation
  restoreSession();
});


/* ── Renew mailbox (remaining + plan TTL) ── */
var mailRenewMode = false;
$(document).on("click", "#btn-renew-mail", function () {
  if (!currentMailboxToken) {
    toast("No active mailbox", "warn");
    return;
  }
  var planId = currentPlanId || selectedPlanId;
  var tier = TIERS[planId];
  if (!tier || tier.price_nch <= 0) {
    // pick cheapest paid
    Object.keys(TIERS).forEach(function (k) {
      if (TIERS[k].price_nch > 0 && (!tier || TIERS[k].price_nch < tier.price_nch)) {
        planId = k; tier = TIERS[k];
      }
    });
  }
  if (!tier || tier.price_nch <= 0) {
    toast("Renew requires a paid plan", "warn");
    return;
  }
  selectedPlanId = planId;
  mailRenewMode = true;
  openPayModal(tier);
});

// Hook confirmPay for renew — patch after confirmPay definition
