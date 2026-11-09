
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

/* NESS Pay — vanilla JS (no CDN dependency for create flow) */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function toast(msg, kind) {
    kind = kind || "ok";
    var host = $("toasts");
    if (!host) {
      console.log("[toast]", kind, msg);
      return;
    }
    var el = document.createElement("div");
    el.className = "toast toast-" + (kind === "err" ? "err" : kind === "warn" ? "warn" : "ok");
    el.textContent = msg;
    host.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("show"); });
    setTimeout(function () {
      el.classList.remove("show");
      setTimeout(function () { el.remove(); }, 280);
    }, 3500);
  }

  function deviceId() {
    if (window.NessVault && typeof NessVault.deviceId === "function") {
      return NessVault.deviceId();
    }
    try {
      var id = localStorage.getItem("ness-device-id")
        || localStorage.getItem("ness_device_id")
        || localStorage.getItem("ness-tempmail-device");
      if (!id) {
        id = "d_" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
      }
      localStorage.setItem("ness-device-id", id);
      try { localStorage.setItem("ness_device_id", id); } catch (e2) {}
      try { localStorage.setItem("ness-tempmail-device", id); } catch (e2) {}
      return id;
    } catch (e) {
      return "unknown";
    }
  }

  function formatRemain(iso) {
    if (!iso) return "—";
    var end = new Date(iso).getTime();
    var ms = end - Date.now();
    if (ms <= 0) return "Expired";
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h >= 48) return Math.floor(h / 24) + "d " + (h % 24) + "h";
    if (h > 0) return h + "h " + m + "m";
    return m + "m " + sec + "s";
  }

  function formatNch(n) {
    return Number(n).toLocaleString("en-US") + " NCH";
  }

  function initThemeToggle() {
    var btn = $("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      if (cur === "light") {
        document.documentElement.removeAttribute("data-theme");
        try { localStorage.setItem("ness_theme", "dark"); } catch (e) {}
      } else {
        document.documentElement.setAttribute("data-theme", "light");
        try { localStorage.setItem("ness_theme", "light"); } catch (e) {}
      }
    });
  }

  function setStatus(ok, text) {
    var label = $("inv-status-label");
    var dot = $("inv-dot");
    if (label) label.textContent = text || (ok ? "Ready" : "Attention");
    if (dot) {
      if (ok) {
        dot.classList.add("online");
        dot.classList.remove("is-warn");
        dot.classList.remove("offline");
      } else {
        dot.classList.remove("online");
        dot.classList.add("is-warn");
      }
    }
  }

  function pathToken() {
    var m = (location.pathname || "").match(/\/invoice\/i\/([A-Za-z0-9_\-]+)/);
    return m ? m[1] : null;
  }

  var timerInterval = null;
  var manageToken = null;
  var publicToken = null;

  var PURPOSE_META = {
    invoice: { label: "Invoice", placeholder: "Design handoff — March" },
    coffee: { label: "Buy me a coffee", placeholder: "Coffee for the next feature" },
    fund: { label: "Fundraiser", placeholder: "Help ship the mobile build" },
    other: { label: "Payment request", placeholder: "NCH payment" }
  };

  var COFFEE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 9h11a3 3 0 0 1 0 6h-1"/><path d="M5 9v7a3 3 0 0 0 3 3h5a3 3 0 0 0 3-3v-1"/><path d="M8 3c0 1-.5 2-1.5 2S5 4 5 3"/><path d="M12 3c0 1-.5 2-1.5 2S9 4 9 3"/><path d="M16 3c0 1-.5 2-1.5 2S13 4 13 3"/></svg>';
  var DOC_SVG = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm1 7V3.5L19.5 9H15z"/></svg>';
  var FUND_SVG = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2a5 5 0 0 1 5 5c0 2.5-1.8 4.1-3.5 5.3L12 14l-1.5-1.7C8.8 11.1 7 9.5 7 7a5 5 0 0 1 5-5z"/></svg>';
  var OTHER_SVG = '<svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M12 2L2 7l10 5 10-5-10-5z"/></svg>';

  function purposeIcon(id) {
    if (id === "coffee") return COFFEE_SVG;
    if (id === "fund") return FUND_SVG;
    if (id === "other") return OTHER_SVG;
    return DOC_SVG;
  }


  /* ── Multi-link sessions (device-local) ─────────────────────────────
   * Public metadata in localStorage; manage tokens in sessionStorage
   * (tab-scoped) so a stolen localStorage dump alone cannot cancel links.
   * Server enforces: max unpaid total + 1 unpaid per purpose.
   */
  var PAY_LIST_KEY = "ness_pay_links_v2";
  var PAY_LEGACY_KEY = "ness_pay_session_v1";
  var PAY_HIDDEN_KEY = "ness_pay_hidden_v1";

  function readHiddenSet() {
    try {
      var raw = localStorage.getItem(PAY_HIDDEN_KEY);
      if (!raw) return {};
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return {};
      var set = {};
      arr.forEach(function (tok) { if (tok) set[tok] = 1; });
      return set;
    } catch (e) {
      return {};
    }
  }

  function writeHiddenSet(set) {
    try {
      localStorage.setItem(PAY_HIDDEN_KEY, JSON.stringify(Object.keys(set).slice(0, 200)));
    } catch (e) {}
  }

  function hideToken(token) {
    if (!token) return;
    var set = readHiddenSet();
    set[token] = 1;
    writeHiddenSet(set);
  }

  function unhideToken(token) {
    if (!token) return;
    var set = readHiddenSet();
    if (set[token]) {
      delete set[token];
      writeHiddenSet(set);
    }
  }
  var payPollTimer = null;

  var _linkListCache = null;

  function readLinkList() {
    if (_linkListCache) return _linkListCache.slice();
    try {
      var raw = localStorage.getItem(PAY_LIST_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      // Encrypted envelope
      if (parsed && parsed.enc && parsed.sealed) {
        return _linkListCache ? _linkListCache.slice() : [];
      }
      if (Array.isArray(parsed)) {
        _linkListCache = parsed.filter(Boolean);
        return _linkListCache.slice();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  async function hydrateLinkList() {
    try {
      if (window.NessVault && !NessVault.isUnlocked()) {
        await NessVault.ensureVault();
      }
      var raw = localStorage.getItem(PAY_LIST_KEY);
      var list = (_linkListCache && _linkListCache.length) ? _linkListCache.slice() : [];
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.enc && parsed.sealed && window.NessVault) {
          try {
            var dec = await NessVault.decryptJson(parsed.sealed);
            if (Array.isArray(dec)) list = dec;
          } catch (decErr) {
            console.warn("[pay] decrypt links failed, keeping memory/server merge", decErr);
          }
        } else if (Array.isArray(parsed)) {
          list = parsed;
          await persistLinkList(list);
        }
      }
      // legacy single session
      var leg = localStorage.getItem(PAY_LEGACY_KEY);
      if (leg) {
        try {
          var one = JSON.parse(leg);
          if (one && one.token && !list.some(function (x) { return x.token === one.token; })) {
            list.unshift(sanitizeLinkEntry(one));
          }
        } catch (e) {}
        try { localStorage.removeItem(PAY_LEGACY_KEY); } catch (e) {}
        await persistLinkList(list);
      }
      _linkListCache = list.filter(Boolean);
      return _linkListCache.slice();
    } catch (e) {
      _linkListCache = [];
      return [];
    }
  }

  async function persistLinkList(list) {
    _linkListCache = (list || []).slice(0, 30);
    try {
      if (window.NessVault && !NessVault.isUnlocked()) {
        await NessVault.ensureVault();
      }
      if (window.NessVault && NessVault.isUnlocked()) {
        var sealed = await NessVault.encryptJson(_linkListCache);
        localStorage.setItem(PAY_LIST_KEY, JSON.stringify({ v: 2, enc: true, sealed: sealed }));
      }
    } catch (e) {}
  }

  function writeLinkList(list) {
    _linkListCache = (list || []).slice(0, 30);
    persistLinkList(_linkListCache);
  }

  function sanitizeLinkEntry(data) {
    return {
      token: data.token,
      title: data.title || "",
      amount_nch: data.amount_nch,
      expires_at: data.expires_at,
      purpose: data.purpose || "invoice",
      purpose_label: data.purpose_label || "",
      public_path: data.public_path || ("/invoice/i/" + data.token),
      status: data.status || "unpaid",
      saved_at: data.saved_at || Date.now(),
    };
  }

  function setManageToken(token, mt) {
    if (!token || !mt) return;
    try { sessionStorage.setItem("ness-inv-manage-" + token, mt); } catch (e) {}
  }

  function getManageToken(token) {
    try { return sessionStorage.getItem("ness-inv-manage-" + token); } catch (e) { return null; }
  }

  function clearManageToken(token) {
    try { sessionStorage.removeItem("ness-inv-manage-" + token); } catch (e) {}
  }

  function upsertLink(data) {
    var entry = sanitizeLinkEntry(data);
    unhideToken(entry.token);
    var list = readLinkList().filter(function (x) { return x.token !== entry.token; });
    list.unshift(entry);
    _linkListCache = list.slice(0, 30);
    writeLinkList(list);
    if (data.manage_token) setManageToken(entry.token, data.manage_token);
  }

  function updateLinkStatus(token, status) {
    var list = readLinkList();
    var changed = false;
    list.forEach(function (x) {
      if (x.token === token) {
        x.status = status;
        changed = true;
      }
    });
    if (changed) writeLinkList(list);
  }

  function removeLink(token) {
    var mt = getManageToken(token);
    var item = readLinkList().find(function (x) { return x.token === token; });
    var wasUnpaid = item && item.status === "unpaid";
    // Option C: hide + cancel unpaid when manage token available (frees quota)
    if (mt && wasUnpaid) {
      fetch("/api/invoice/manage/" + encodeURIComponent(mt) + "/cancel", {
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest", "X-Device-Id": deviceId() },
        credentials: "same-origin",
      }).catch(function () {});
    }
    writeLinkList(readLinkList().filter(function (x) { return x.token !== token; }));
    clearManageToken(token);
    hideToken(token);
  }

  function hasUnpaidPurpose(purpose) {
    return readLinkList().some(function (x) {
      return x.purpose === purpose && x.status === "unpaid";
    });
  }

  function stopPayPoll() {
    if (payPollTimer) {
      clearInterval(payPollTimer);
      payPollTimer = null;
    }
  }

  function startPayPoll(token) {
    stopPayPoll();
    if (!token) return;
    payPollTimer = setInterval(function () {
      fetch("/api/invoice/" + encodeURIComponent(token), {
        headers: { "X-Requested-With": "XMLHttpRequest" },
        credentials: "same-origin",
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!data || !data.success || !data.invoice) return;
          var inv = data.invoice;
          if (inv.status === "paid") {
            stopPayPoll();
            updateLinkStatus(inv.token, "paid");
            renderPay(inv);
            if ($("created-badge") && publicToken === inv.token) {
              $("created-badge").textContent = "Paid";
              $("created-badge").classList.add("is-paid");
            }
            if ($("created-status") && publicToken === inv.token) {
              $("created-status").textContent = "Payment received";
            }
            toast("Payment confirmed", "ok");
            renderLinksList();
          } else if (inv.status === "expired" || inv.status === "cancelled") {
            stopPayPoll();
            updateLinkStatus(inv.token, inv.status);
            renderPay(inv);
            renderLinksList();
          }
        })
        .catch(function () {});
    }, 5000);
  }

  function showView(name) {
    // name: list | create | created | pay
    var map = {
      list: "links-card",
      create: "create-card",
      created: "created-card",
      pay: "pay-card",
    };
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]);
      if (!el) return;
      el.style.display = (k === name) ? "" : "none";
    });
  }

  function renderLinksList() {
    var ul = $("pay-links");
    var card = $("links-card");
    if (!ul || !card) return;
    var list = readLinkList();
    if (!list.length) {
      ul.innerHTML = '<li class="pay-link-item"><span class="pay-link-meta">No payment links yet.</span></li>';
      return;
    }
    ul.innerHTML = "";
    list.forEach(function (item) {
      var li = document.createElement("li");
      li.className = "pay-link-item";
      var purpose = item.purpose_label || item.purpose || "Link";
      var st = item.status || "unpaid";
      var stLabel = st === "unpaid" ? "Unpaid" : (st === "paid" ? "Paid" : (st === "cancelled" ? "Cancelled" : (st === "expired" ? "Expired" : st)));
      var amount = formatNch(item.amount_nch || 0);
      var title = item.title || purpose;
      li.innerHTML =
        '<div class="pay-link-top">' +
          '<span class="pay-link-title"></span>' +
          '<span class="badge ' + (st === "paid" ? "is-paid" : st === "unpaid" ? "is-unpaid" : st === "cancelled" ? "is-cancelled" : "") + '">' + stLabel + "</span>" +
        "</div>" +
        '<div class="pay-link-meta"></div>' +
        '<div class="pay-link-actions">' +
          '<button type="button" class="btn btn-sm btn-open">Open</button>' +
          (st === "unpaid"
            ? '<button type="button" class="btn btn-ghost btn-sm btn-cancel-link">Cancel</button>'
            : '<button type="button" class="btn btn-ghost btn-sm btn-forget">Remove</button>') +
        "</div>";
      li.querySelector(".pay-link-title").textContent = title;
      li.querySelector(".pay-link-meta").textContent =
        purpose + " · " + amount + " · " + formatRemain(item.expires_at);
      li.querySelector(".btn-open").addEventListener("click", function () {
        openManagedLink(item.token);
      });
      var cancelBtn = li.querySelector(".btn-cancel-link");
      if (cancelBtn) {
        cancelBtn.addEventListener("click", function () {
          cancelLinkToken(item.token);
        });
      }
      var forgetBtn = li.querySelector(".btn-forget");
      if (forgetBtn) {
        forgetBtn.addEventListener("click", function () {
          var run = function () {
            removeLink(item.token);
            renderLinksList();
            toast("Removed from My links", "ok");
          };
          if (typeof nessConfirm === "function") {
            nessConfirm({
              title: "Remove from My links?",
              message: (st === "unpaid")
                ? "This hides the link and cancels it if this browser can manage it, freeing an unpaid slot. Continue?"
                : "This hides the link from your list only. The invoice record on the server is kept.",
              confirmLabel: "Remove",
              danger: st === "unpaid",
            }).then(function (ok) { if (ok) run(); });
          } else {
            run();
          }
        });
      }
      ul.appendChild(li);
    });
  }

  function openManagedLink(token) {
    publicToken = token;
    manageToken = getManageToken(token);
    fetch("/api/invoice/" + encodeURIComponent(token), {
      headers: { "X-Requested-With": "XMLHttpRequest" },
      credentials: "same-origin",
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || !data.success || !data.invoice) {
          removeLink(token);
          renderLinksList();
          toast("Link no longer available", "warn");
          return;
        }
        var inv = data.invoice;
        updateLinkStatus(inv.token, inv.status);
        // Merchant detail view
        showCreated({
          token: inv.token,
          manage_token: manageToken,
          amount_nch: inv.amount_nch,
          expires_at: inv.expires_at,
          public_path: "/invoice/i/" + inv.token,
          status: inv.status,
          purpose: inv.purpose,
          purpose_label: inv.purpose_label,
          title: inv.title,
        });
        if (manageToken) {
          fetch("/api/invoice/manage/" + encodeURIComponent(manageToken) + "/rotate", {
            method: "POST",
            headers: { "X-Requested-With": "XMLHttpRequest" },
            credentials: "same-origin",
          })
            .then(function (res) { return res.json(); })
            .then(function (rot) {
              if (rot && rot.success && rot.manage_token) {
                manageToken = rot.manage_token;
                setManageToken(inv.token, rot.manage_token);
              }
            })
            .catch(function () {});
        }
        if (inv.status === "unpaid") startPayPoll(inv.token);
        else stopPayPoll();
      })
      .catch(function () {
        toast("Unable to open link", "err");
      });
  }

  function cancelLinkToken(token) {
    var mt = getManageToken(token);
    function doCancel() {
      if (!mt) {
        removeLink(token);
        renderLinksList();
        toast("Removed. Server cancel unavailable in this browser.", "warn");
        return;
      }
      fetch("/api/invoice/manage/" + encodeURIComponent(mt) + "/cancel", {
        method: "POST",
        headers: { "X-Requested-With": "XMLHttpRequest", "X-Device-Id": deviceId() },
        credentials: "same-origin",
      })
        .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
        .then(function (pack) {
          if (pack.data && pack.data.success) {
            updateLinkStatus(token, "cancelled");
            clearManageToken(token);
            renderLinksList();
            toast("Link cancelled", "ok");
            if (publicToken === token) showView("list");
          } else {
            toast((pack.data && pack.data.error) || "Cancel failed", "err");
          }
        })
        .catch(function () {
          toast("Cancel failed", "err");
        });
    }
    if (typeof nessConfirm !== "function") {
      doCancel();
      return;
    }
    if (!mt) {
      nessConfirm({
        title: "Remove from My links?",
        message: "This browser no longer holds the manage token, so the link may stay open on the server until it expires.",
        confirmLabel: "Remove",
        danger: true,
      }).then(function (ok) { if (ok) doCancel(); });
      return;
    }
    nessConfirm({
      title: "Cancel this payment link?",
      message: "The payer will no longer be able to pay via this link. This cannot be undone.",
      confirmLabel: "Cancel link",
      danger: true,
    }).then(function (ok) { if (ok) doCancel(); });
  }


  function updateLinksBadge(n) {
    var btn = document.getElementById("btn-show-links");
    if (!btn) return;
    if (n > 0) {
      btn.style.display = "";
      btn.textContent = "My links · " + n;
    } else {
      btn.style.display = "none";
    }
  }

  function resetCreateForm() {
    var purposeInput = document.getElementById("inv-purpose");
    if (purposeInput) purposeInput.value = "invoice";
    document.querySelectorAll(".purpose-card").forEach(function (c) {
      c.classList.remove("selected");
      c.setAttribute("aria-selected", "false");
      if (c.getAttribute("data-purpose") === "invoice") {
        c.classList.add("selected");
        c.setAttribute("aria-selected", "true");
      }
    });
    var ti = document.getElementById("inv-title");
    var d = document.getElementById("inv-desc");
    var a = document.getElementById("inv-amount");
    var ttl = document.getElementById("inv-ttl");
    if (ti) {
      ti.value = "";
      ti.placeholder = (PURPOSE_META.invoice && PURPOSE_META.invoice.placeholder) || "Design handoff — March";
    }
    if (d) d.value = "";
    if (a) a.value = "";
    if (ttl) ttl.value = "24";
    var warn = document.getElementById("existing-purpose-warning");
    if (warn) {
      warn.style.display = "none";
      warn.innerHTML = "";
    }
  }

  function showExistingPurposeWarning(purpose, existing, count) {
    var warn = document.getElementById("existing-purpose-warning");
    if (!warn) return;
    if (!existing && !(count > 0)) {
      warn.style.display = "none";
      warn.innerHTML = "";
      return;
    }
    var label = (PURPOSE_META[purpose] && PURPOSE_META[purpose].label) || purpose;
    var n = count || 1;
    warn.style.display = "";
    if (n > 1) {
      warn.innerHTML =
        "You have <strong>" + n + " unpaid " + label + "</strong> links. " +
        "Open one from My links, or pick another purpose.";
    } else {
      warn.innerHTML =
        "You have an unpaid <strong>" + label + "</strong> link. " +
        '<button type="button" class="btn btn-ghost btn-sm" id="btn-open-existing">Open it</button> ' +
        "or pick another purpose to create a different link.";
      var openBtn = document.getElementById("btn-open-existing");
      if (openBtn && existing) {
        openBtn.onclick = function () {
          openManagedLink(existing.token);
        };
      }
    }
  }

  function restoreMerchantHome() {
    var boot = window.NessVault ? NessVault.ensureVault() : Promise.resolve({ ok: true });
    boot.then(function () {
      return hydrateLinkList();
    }).then(function () {
      return fetch("/api/invoice/mine", {
        headers: {
          "X-Requested-With": "XMLHttpRequest",
          "X-Device-Id": deviceId(),
        },
        credentials: "same-origin",
      }).then(function (res) { return res.json(); }).catch(function () { return null; });
    }).then(function (data) {
      var local = readLinkList();
      var byTok = {};
      local.forEach(function (x) { if (x && x.token) byTok[x.token] = x; });
      var hidden = readHiddenSet();
      if (data && data.success && Array.isArray(data.items)) {
        data.items.forEach(function (it) {
          if (hidden[it.token]) return;
          var prev = byTok[it.token] || {};
          byTok[it.token] = sanitizeLinkEntry({
            token: it.token,
            title: it.title || prev.title || "",
            amount_nch: it.amount_nch,
            expires_at: it.expires_at,
            purpose: it.purpose,
            purpose_label: it.purpose_label,
            public_path: it.public_path,
            status: it.status,
            saved_at: prev.saved_at || Date.now(),
          });
        });
      }
      var merged = Object.keys(byTok).map(function (k) { return byTok[k]; });
      merged.sort(function (a, b) {
        var rank = function (s) {
          if (s === "unpaid") return 0;
          if (s === "paid") return 1;
          return 2;
        };
        var d = rank(a.status) - rank(b.status);
        if (d !== 0) return d;
        return (b.saved_at || 0) - (a.saved_at || 0);
      });
      writeLinkList(merged);
      renderLinksList();
      // Always land on create form; expose existing links via badge
      showView("create");
      updateLinksBadge(merged.length);
    }).catch(function (err) {
      console.warn("[pay] restore", err);
      renderLinksList();
      showView("create");
      updateLinksBadge(readLinkList().length);
    });
  }

  function copyText(value) {
    if (!value) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(function () {
        toast("Copied", "ok");
      }).catch(function () { legacyCopy(value); });
    } else {
      legacyCopy(value);
    }
  }

  function legacyCopy(value) {
    var ta = document.createElement("textarea");
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("Copied", "ok"); }
    catch (e) { toast("Copy failed", "err"); }
    ta.remove();
  }

  function val(id) {
    var el = $(id);
    return el ? (el.value || "").trim() : "";
  }

  function createInvoice() {
    var title = val("inv-title");
    var description = val("inv-desc");
    var amount = parseInt(val("inv-amount"), 10);
    var pay_to_address = val("inv-address");
    var ttl_hours = parseInt(val("inv-ttl"), 10) || 24;
    var purpose = val("inv-purpose") || "invoice";

    if (!title) { toast("Title is required", "warn"); return; }
    if (!amount || amount < 1) { toast("Enter a valid NCH amount", "warn"); return; }
    if (!/^[1-9A-HJ-NP-Za-km-z]{20,50}$/.test(pay_to_address)) {
      toast("Invalid NESS address (check length and characters)", "warn");
      return;
    }
    var btn = $("btn-create");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Creating…";
    }

    var body = new URLSearchParams();
    body.set("title", title);
    body.set("description", description);
    body.set("amount_nch", String(amount));
    body.set("pay_to_address", pay_to_address);
    body.set("ttl_hours", String(ttl_hours));
    body.set("purpose", purpose);

    var ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timer = setTimeout(function () {
      if (ctrl) ctrl.abort();
    }, 25000);

    fetch("/api/invoice/create", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "X-Device-Id": deviceId(),
      },
      body: body.toString(),
      signal: ctrl ? ctrl.signal : undefined,
      credentials: "same-origin",
    })
      .then(function (res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (e) { data = null; }
          return { status: res.status, data: data, text: text };
        });
      })
      .then(function (pack) {
        clearTimeout(timer);
        var data = pack.data;
        if (!data || !data.success) {
          var msg = (data && data.error) || ("Create failed (" + pack.status + ")");
          if (data && data.existing && data.existing.token) {
            upsertLink(data.existing);
            toast(msg, "warn");
            openManagedLink(data.existing.token);
            return;
          }
          toast(msg, "err");
          console.warn("[invoice create]", pack.status, pack.text);
          restoreMerchantHome();
          return;
        }
        manageToken = data.manage_token;
        publicToken = data.token;
        try {
          sessionStorage.setItem("ness-inv-manage-" + data.token, data.manage_token);
        } catch (e) {}
        data.status = "unpaid";
        data.title = title;
        upsertLink(data);
        manageToken = data.manage_token;
        showCreated(data);
        startPayPoll(data.token);
        renderLinksList();
        toast("Payment link ready", "ok");
      })
      .catch(function (err) {
        clearTimeout(timer);
        var msg = "Create failed";
        if (err && err.name === "AbortError") msg = "Request timed out — check the server and retry";
        else if (err && err.message) msg = err.message;
        toast(msg, "err");
        console.error("[invoice create]", err);
      })
      .then(function () {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Create payment link";
        }
      });
  }

  function showCreated(data) {
    showView("created");

    var link = location.origin + (data.public_path || ("/invoice/i/" + data.token));
    if ($("created-link")) $("created-link").value = link;
    if ($("created-status")) {
      var st0 = data.status || "unpaid";
      if (st0 === "paid") $("created-status").textContent = "Payment received";
      else if (st0 === "expired") $("created-status").textContent = "Link expired";
      else if (st0 === "cancelled") $("created-status").textContent = "Link cancelled";
      else $("created-status").textContent = "Unpaid — share this link with your payer";
    }
    if ($("created-amount")) $("created-amount").textContent = formatNch(data.amount_nch);
    if ($("created-badge")) {
      var st = (data.status || "unpaid");
      var labels = { unpaid: "Unpaid", paid: "Paid", cancelled: "Cancelled", expired: "Expired" };
      $("created-badge").textContent = labels[st] || (st.charAt(0).toUpperCase() + st.slice(1));
      $("created-badge").classList.toggle("is-paid", st === "paid");
      $("created-badge").classList.toggle("is-unpaid", st === "unpaid");
      $("created-badge").classList.toggle("is-cancelled", st === "cancelled");
    }
    if ($("created-manage-hint")) {
      var st = (data.status || "unpaid");
      if (st === "paid") {
        $("created-manage-hint").textContent = "Payment received. You can keep this link for your records.";
      } else if (st === "expired") {
        $("created-manage-hint").textContent = "This link has expired.";
      } else if (st === "cancelled") {
        $("created-manage-hint").textContent = "This link was cancelled.";
      } else {
        $("created-manage-hint").textContent =
          "Status: Unpaid — waiting for your payer. Share the link below; cancel anytime from My links.";
      }
    }
    if (timerInterval) clearInterval(timerInterval);
    function tick() {
      if ($("created-timer")) $("created-timer").textContent = formatRemain(data.expires_at);
    }
    tick();
    timerInterval = setInterval(tick, 1000);
  }

  function loadPublic(token) {
    if ($("create-card")) $("create-card").style.display = "none";
    if ($("created-card")) $("created-card").style.display = "none";
    if ($("pay-card")) $("pay-card").style.display = "";
    if ($("pay-title")) $("pay-title").textContent = "Loading…";
    if ($("pay-desc")) $("pay-desc").textContent = "";
    if ($("pay-unpaid")) $("pay-unpaid").hidden = true;
    if ($("pay-paid")) $("pay-paid").hidden = true;

    fetch("/api/invoice/" + encodeURIComponent(token), {
      headers: { "X-Requested-With": "XMLHttpRequest" },
      credentials: "same-origin",
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data.success || !data.invoice) {
          if ($("pay-title")) $("pay-title").textContent = "Unavailable";
          toast((data && data.error) || "Invoice not found", "err");
          return;
        }
        renderPay(data.invoice);
      })
      .catch(function () {
        if ($("pay-title")) $("pay-title").textContent = "Unavailable";
        toast("Invoice not found", "err");
      });
  }

  function renderPay(inv) {
    publicToken = inv.token;
    if ($("pay-title")) $("pay-title").textContent = inv.title || "Payment";
    if ($("pay-desc")) $("pay-desc").textContent = inv.description || "";
    if ($("pay-amount")) $("pay-amount").textContent = formatNch(inv.amount_nch);
    if ($("pay-address")) $("pay-address").value = inv.pay_to_address || "";
    if ($("pay-badge")) {
      var ps = inv.status || "unpaid";
      var plabels = { unpaid: "Unpaid", paid: "Paid", cancelled: "Cancelled", expired: "Expired" };
      $("pay-badge").textContent = plabels[ps] || ps;
      if (ps === "paid") $("pay-badge").classList.add("is-paid");
      else $("pay-badge").classList.remove("is-paid");
      if (ps === "unpaid") $("pay-badge").classList.add("is-unpaid");
      else $("pay-badge").classList.remove("is-unpaid");
    }

    var pur = inv.purpose || "invoice";
    var plabel = inv.purpose_label || (PURPOSE_META[pur] && PURPOSE_META[pur].label) || "Payment";
    if ($("pay-section-label")) $("pay-section-label").textContent = plabel;
    if ($("pay-purpose-label")) $("pay-purpose-label").textContent = plabel;
    if ($("pay-purpose-icon")) $("pay-purpose-icon").innerHTML = purposeIcon(pur);
    if ($("pay-purpose-wrap")) $("pay-purpose-wrap").hidden = false;

    if (timerInterval) clearInterval(timerInterval);
    function tick() {
      if ($("pay-timer")) $("pay-timer").textContent = formatRemain(inv.expires_at);
    }
    tick();
    timerInterval = setInterval(tick, 1000);

    if (inv.status === "paid") {
      stopPayPoll();
      if ($("pay-unpaid")) $("pay-unpaid").hidden = true;
      if ($("pay-paid")) $("pay-paid").hidden = false;
      if ($("pay-txid")) $("pay-txid").textContent = inv.tx_hash || "";
      setStatus(true, "Paid");
      updateLinkStatus(inv.token, "paid");
      return;
    }
    if (inv.status === "expired" || inv.status === "cancelled") {
      stopPayPoll();
      if ($("pay-unpaid")) $("pay-unpaid").hidden = true;
      if ($("pay-paid")) $("pay-paid").hidden = true;
      setStatus(false, inv.status);
      return;
    }

    if ($("pay-unpaid")) $("pay-unpaid").hidden = false;
    if ($("pay-paid")) $("pay-paid").hidden = true;
    startPayPoll(inv.token);
    if ($("pay-qr")) {
      $("pay-qr").src =
        "https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=8&data=" +
        encodeURIComponent(inv.pay_to_address || "");
    }
    setStatus(true, "Awaiting payment");
  }

  function verifyPayment() {
    var token = publicToken || pathToken();
    var tx = val("pay-tx");
    if (!token) { toast("Missing invoice", "err"); return; }
    if (tx.length < 16) { toast("Paste a valid transaction hash", "warn"); return; }

    var btn = $("btn-verify");
    if (btn) { btn.disabled = true; btn.textContent = "Verifying…"; }

    fetch("/api/invoice/" + encodeURIComponent(token) + "/verify", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: "tx_hash=" + encodeURIComponent(tx),
      credentials: "same-origin",
    })
      .then(function (res) {
        return res.json().then(function (data) {
          return { ok: res.ok, data: data };
        });
      })
      .then(function (pack) {
        var data = pack.data;
        if (!data || !data.success) {
          var err = (data && data.error) || "Verification failed";
          var low = String(err).toLowerCase();
          if (low.indexOf("already used") >= 0 || low.indexOf("anti-replay") >= 0) {
            err = "This transaction already confirmed another payment. Use a separate payment for this link.";
          }
          toast(err, "err");
          return;
        }
        toast(data.already_paid ? "Already paid" : "Payment confirmed", "ok");
        if (data.invoice) {
          updateLinkStatus(data.invoice.token, data.invoice.status || "paid");
          renderPay(data.invoice);
        }
      })
      .catch(function () {
        toast("Verification failed", "err");
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Verify payment"; }
      });
  }

  function cancelInvoice() {
    if (!publicToken) {
      toast("Nothing to cancel", "warn");
      return;
    }
    cancelLinkToken(publicToken);
  }

  function onReady() {
    initThemeToggle();

    var grid = $("purpose-grid");
    if (grid) {
      grid.addEventListener("click", function (e) {
        var card = e.target.closest(".purpose-card");
        if (!card) return;
        var id = card.getAttribute("data-purpose");
        grid.querySelectorAll(".purpose-card").forEach(function (c) {
          c.classList.remove("selected");
          c.setAttribute("aria-selected", "false");
        });
        card.classList.add("selected");
        card.setAttribute("aria-current", "true");
        card.setAttribute("aria-selected", "true");
        if ($("inv-purpose")) $("inv-purpose").value = id;
        var meta = PURPOSE_META[id];
        if (meta && $("inv-title")) $("inv-title").placeholder = meta.placeholder;

        // Informational only — do not auto-open existing links
        hydrateLinkList().then(function () {
          var unpaid = readLinkList().filter(function (x) {
            return x.purpose === id && x.status === "unpaid";
          });
          if (unpaid.length) {
            showExistingPurposeWarning(id, unpaid[0], unpaid.length);
            return;
          }
          return fetch("/api/invoice/mine", {
            headers: { "X-Requested-With": "XMLHttpRequest", "X-Device-Id": deviceId() },
            credentials: "same-origin",
          }).then(function (res) { return res.json(); }).then(function (data) {
            var list = (data && data.items) ? data.items.filter(function (x) {
              return x.purpose === id && x.status === "unpaid";
            }) : [];
            if (list.length) {
              list.forEach(function (it) { upsertLink(it); });
              showExistingPurposeWarning(id, list[0], list.length);
            } else {
              showExistingPurposeWarning(id, null, 0);
            }
          });
        });
      });
    }


    var boot = window.NessVault ? NessVault.ensureVault() : Promise.resolve({ ok: true });
    boot.then(function () {
    var tok = pathToken();
    if (tok) {
      loadPublic(tok);
    } else {
      restoreMerchantHome();
    }
    });

    if ($("btn-create")) $("btn-create").addEventListener("click", createInvoice);
    if ($("btn-copy-link")) $("btn-copy-link").addEventListener("click", function () {
      copyText(val("created-link"));
    });
    if ($("btn-copy-addr")) $("btn-copy-addr").addEventListener("click", function () {
      copyText(val("pay-address"));
    });
    if ($("btn-verify")) $("btn-verify").addEventListener("click", verifyPayment);
    if ($("btn-cancel-invoice")) $("btn-cancel-invoice").addEventListener("click", cancelInvoice);
    if ($("btn-new-invoice")) $("btn-new-invoice").addEventListener("click", function () {
      stopPayPoll();
      resetCreateForm();
      showView("create");
      updateLinksBadge(readLinkList().length);
    });
    if ($("btn-back-list")) $("btn-back-list").addEventListener("click", function () {
      stopPayPoll();
      renderLinksList();
      showView("list");
    });
    if ($("btn-show-create")) $("btn-show-create").addEventListener("click", function () {
      stopPayPoll();
      resetCreateForm();
      showView("create");
      updateLinksBadge(readLinkList().length);
    });
    if ($("btn-show-links")) $("btn-show-links").addEventListener("click", function () {
      stopPayPoll();
      renderLinksList();
      showView("list");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onReady);
  } else {
    onReady();
  }
})();
