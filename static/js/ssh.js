/* NESS SSH Access — self-service keys, keygen, invites, connect helper */
(function () {
  var HOST_KEY = "ness_ssh_host";
  var SELECT_USER_KEY = "ness_ssh_user";

  function $(id) { return document.getElementById(id); }
  function toast(msg, kind) {
    var root = $("toasts");
    if (!root) {
      root = document.createElement("div");
      root.id = "toasts";
      document.body.appendChild(root);
    }
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : " ok");
    el.textContent = msg;
    root.appendChild(el);
    // CSS defaults to opacity:0 until .show (same contract as app.js / invoice.js)
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.classList.add("show");
      });
    });
    setTimeout(function () {
      el.classList.remove("show");
      setTimeout(function () {
        try { el.remove(); } catch (e) {}
      }, 280);
    }, 4000);
  }
  function deviceHeaders() {
    var h = { "X-Requested-With": "XMLHttpRequest" };
    try {
      if (window.NessVault && NessVault.deviceId) h["X-Device-Id"] = NessVault.deviceId();
      else {
        var id = localStorage.getItem("ness-device-id");
        if (id) h["X-Device-Id"] = id;
      }
    } catch (e) {}
    return h;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function b64(u8) {
    var s = "";
    for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function sshString(buf) {
    var u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var out = new Uint8Array(4 + u8.length);
    out[0] = (u8.length >>> 24) & 255;
    out[1] = (u8.length >>> 16) & 255;
    out[2] = (u8.length >>> 8) & 255;
    out[3] = u8.length & 255;
    out.set(u8, 4);
    return out;
  }
  function concatBytes(parts) {
    var n = 0;
    parts.forEach(function (p) { n += p.length; });
    var out = new Uint8Array(n);
    var o = 0;
    parts.forEach(function (p) { out.set(p, o); o += p.length; });
    return out;
  }
  function toOpenSshPublic(rawPub32, comment) {
    var type = new TextEncoder().encode("ssh-ed25519");
    var body = concatBytes([sshString(type), sshString(rawPub32)]);
    return "ssh-ed25519 " + b64(body) + (comment ? " " + comment : "");
  }

  function toPemPkcs8(pkcs8) {
    var u8 = new Uint8Array(pkcs8);
    var b = b64(u8);
    var lines = b.match(/.{1,64}/g) || [];
    return "-----BEGIN PRIVATE KEY-----\n" + lines.join("\n") + "\n-----END PRIVATE KEY-----\n";
  }

  /** Extract 32-byte Ed25519 seed from PKCS#8 (RFC 8410). */
  function ed25519SeedFromPkcs8(pkcs8) {
    var u8 = new Uint8Array(pkcs8);
    // Prefer: OID 1.3.101.112 (2b 65 70) then OCTET STRING wrapping 32-byte seed
    for (var i = 0; i < u8.length - 5; i++) {
      if (u8[i] === 0x06 && u8[i + 1] === 0x03 && u8[i + 2] === 0x2b &&
          u8[i + 3] === 0x65 && u8[i + 4] === 0x70) {
        for (var j = i + 5; j < u8.length - 2; j++) {
          if (u8[j] === 0x04 && u8[j + 1] === 0x20 && j + 34 <= u8.length) {
            return u8.slice(j + 2, j + 34);
          }
          if (u8[j] === 0x04 && u8[j + 1] === 0x22 && u8[j + 2] === 0x04 &&
              u8[j + 3] === 0x20 && j + 36 <= u8.length) {
            return u8.slice(j + 4, j + 36);
          }
        }
      }
    }
    // Fallback: last 32-byte OCTET STRING
    for (var k = u8.length - 34; k >= 0; k--) {
      if (u8[k] === 0x04 && u8[k + 1] === 0x20) return u8.slice(k + 2, k + 34);
    }
    return null;
  }

  function sshUint32(n) {
    return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  }

  /**
   * OpenSSH private key (openssh-key-v1, unencrypted) for Ed25519.
   * Compatible with `ssh -i id_ed25519` without conversion.
   */
  function toOpenSshPrivateEd25519(seed32, pub32, comment) {
    comment = comment || "";
    var keyType = new TextEncoder().encode("ssh-ed25519");
    var pubBlob = concatBytes([sshString(keyType), sshString(pub32)]);
    // OpenSSH stores private as seed||public (64 bytes)
    var privCombined = concatBytes([seed32, pub32]);
    var check = (Math.random() * 0xffffffff) >>> 0;
    var privateSection = concatBytes([
      sshUint32(check),
      sshUint32(check),
      sshString(keyType),
      sshString(pub32),
      sshString(privCombined),
      sshString(new TextEncoder().encode(comment)),
    ]);
    // pad to 8-byte block with 1,2,3...
    var padLen = (8 - (privateSection.length % 8)) % 8;
    if (padLen) {
      var pad = new Uint8Array(padLen);
      for (var i = 0; i < padLen; i++) pad[i] = i + 1;
      privateSection = concatBytes([privateSection, pad]);
    }
    var none = new TextEncoder().encode("none");
    var empty = new Uint8Array(0);
    var body = concatBytes([
      new TextEncoder().encode("openssh-key-v1\0"),
      sshString(none), // cipher
      sshString(none), // kdf
      sshString(empty), // kdf options
      sshUint32(1), // nkeys
      sshString(pubBlob),
      sshString(privateSection),
    ]);
    var lines = b64(body).match(/.{1,70}/g) || [];
    return "-----BEGIN OPENSSH PRIVATE KEY-----\n" + lines.join("\n") + "\n-----END OPENSSH PRIVATE KEY-----\n";
  }




  function copyText(text, okMsg, emptyMsg) {
    text = String(text == null ? "" : text);
    if (!text.trim()) {
      toast(emptyMsg || "Nothing to copy", "warn");
      return;
    }
    var done = function () { toast(okMsg || "Copied", "ok"); };
    var fail = function () { toast("Copy failed", "err"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fail);
      return;
    }
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) done(); else fail();
    } catch (e) {
      fail();
    }
  }

  function smartScrollTo(el, opts) {
    opts = opts || {};
    if (!el || !el.getBoundingClientRect) return;
    try {
      var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      var margin = typeof opts.margin === "number" ? opts.margin : 72;
      var rect = el.getBoundingClientRect();
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var fullyVisible = rect.top >= margin && rect.bottom <= vh - 16;
      if (fullyVisible && !opts.force) return;
      var top = window.pageYOffset + rect.top - margin;
      if (top < 0) top = 0;
      window.scrollTo({
        top: top,
        behavior: reduce ? "auto" : "smooth",
      });
      // Focus without forcing keyboard popup on mobile when possible
      if (opts.focusId) {
        var f = $(opts.focusId);
        if (f && typeof f.focus === "function") {
          setTimeout(function () {
            try { f.focus({ preventScroll: true }); } catch (e1) {
              try { f.focus(); } catch (e2) {}
            }
          }, reduce ? 0 : 320);
        }
      }
    } catch (e) {}
  }

  var keys = [];
  var rpcOk = false;
  var selectedUser = "";
  var sshTiers = [];
  var entitlement = null;
  var payAddress = "";
  var selectedPlan = "free";
  var pendingSshIntent = null;

  function setRpcPill(ok, label) {
    rpcOk = !!ok;
    var dot = $("rpc-dot");
    var lab = $("rpc-label");
    var help = $("rpc-help");
    if (dot) {
      dot.classList.toggle("online", ok);
      dot.classList.toggle("offline", !ok);
    }
    if (lab) lab.textContent = label || (ok ? "Ready" : "Save only");
    if (help) {
      help.textContent = ok
        ? "Activation publishes your public key for SSH authorization."
        : "You can save keys now. Activation may be temporarily unavailable — try again later.";
    }
  }

  function parseHostPort(raw) {
    raw = String(raw || "").trim();
    var host = raw;
    var port = "";
    // IPv6 in brackets: [2001:db8::1]:22
    var m6 = raw.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
    if (m6) {
      return { host: m6[1], port: m6[2] || "" };
    }
    // host:port or IPv4:port (single colon)
    if (raw.indexOf(":") >= 0 && raw.indexOf("::") < 0) {
      var parts = raw.split(":");
      if (parts.length === 2 && /^\d{1,5}$/.test(parts[1])) {
        return { host: parts[0], port: parts[1] };
      }
    }
    return { host: host, port: port };
  }

  function updateCmd() {
    var raw = ($("ssh-host") && $("ssh-host").value || "").trim();
    var user = selectedUser || "";
    var hp = parseHostPort(raw);
    var host = hp.host;
    var port = hp.port;
    var cmd = "";
    if (user && host) {
      cmd = port
        ? ("ssh -p " + port + " " + user + "@" + host)
        : ("ssh " + user + "@" + host);
    } else if (user) {
      cmd = "ssh " + user + "@<host>";
    } else if (host) {
      cmd = port
        ? ("ssh -p " + port + " <user>@" + host)
        : ("ssh <user>@" + host);
    }
    if ($("ssh-cmd")) $("ssh-cmd").value = cmd;
  }

  function statusBadge(st) {
    var c = "badge ";
    if (st === "active") c += "badge-active";
    else if (st === "pending") c += "badge-pending";
    else c += "badge-revoked";
    return '<span class="' + c + '">' + esc(st) + "</span>";
  }

  function renderKeys() {
    var list = $("keys-list");
    var empty = $("keys-empty");
    if (!list) return;
    list.innerHTML = "";
    if (!keys.length) {
      if (empty) empty.style.display = "";
      var sc0 = $("keys-scroll");
      if (sc0) sc0.classList.remove("is-scrollable");
      return;
    }
    if (empty) empty.style.display = "none";
    keys.forEach(function (k) {
      var row = document.createElement("div");
      row.className = "ssh-key-row";
      var sel = (selectedUser === k.username) ? " is-selected" : "";
      row.className = "ssh-key-row" + sel;
      row.innerHTML =
        '<div class="ssh-key-top">' +
          '<span class="ssh-fp">' + esc(k.fingerprint) + "</span>" +
          statusBadge(k.status) +
        "</div>" +
        '<div class="ssh-meta">user <span class="mono">' + esc(k.username) + "</span>" +
          (k.key_type ? " · " + esc(k.key_type) : "") +
          (k.nvs_name ? " · NVS " + esc(k.nvs_name) : "") +
        "</div>" +
        '<div class="ssh-key-actions" data-id="' + esc(String(k.id)) + '" data-user="' + esc(k.username) + '">' +
          '<button type="button" class="btn btn-sm btn-ghost btn-use">Use in command</button>' +
          (k.status === "pending" ? '<button type="button" class="btn btn-sm btn-activate">Activate</button>' : "") +
          (k.status !== "revoked" ? '<button type="button" class="btn btn-sm btn-ghost btn-revoke">Revoke</button>' : "") +
        "</div>";
      list.appendChild(row);
    });
    list.querySelectorAll(".btn-use").forEach(function (btn) {
      btn.addEventListener("click", function () {
        selectedUser = btn.closest("[data-user]").getAttribute("data-user") || "";
        try { localStorage.setItem(SELECT_USER_KEY, selectedUser); } catch (e) {}
        updateCmd();
        renderKeys();
        toast("Command updated for " + selectedUser, "ok");
      });
    });
    list.querySelectorAll(".btn-activate").forEach(function (btn) {
      btn.addEventListener("click", function () {
        activateKey(btn.closest("[data-id]").getAttribute("data-id"), btn);
      });
    });
    list.querySelectorAll(".btn-revoke").forEach(function (btn) {
      btn.addEventListener("click", function () {
        revokeKey(btn.closest("[data-id]").getAttribute("data-id"));
      });
    });
    var sc = $("keys-scroll");
    if (sc) {
      if (keys.length >= 2) {
        sc.classList.add("is-scrollable");
        /* Inline fallback: some mobile WebViews ignore max-height without explicit style */
        sc.style.maxHeight = "13.5rem";
        sc.style.overflowY = "scroll";
        sc.style.webkitOverflowScrolling = "touch";
      } else {
        sc.classList.remove("is-scrollable");
        sc.style.maxHeight = "";
        sc.style.overflowY = "";
        sc.style.webkitOverflowScrolling = "";
      }
    }
  }

  function loadKeys() {
    fetch("/api/ssh/keys", { headers: deviceHeaders(), credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.success) {
          toast((data && data.error) || "Could not load keys", "err");
          return;
        }
        if (data.anon) toast("Device id missing — enable storage so keys stay yours.", "warn");
        keys = data.items || [];
        renderKeys();
      })
      .catch(function () { toast("Could not load keys", "err"); });
  }

  function loadStatus() {
    fetch("/api/ssh/status", { headers: deviceHeaders(), credentials: "same-origin" })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.success) return;
        setRpcPill(!!data.rpc_configured,
          data.rpc_configured ? "Ready" : "Save only");
        payAddress = data.pay_address || "";
        sshTiers = data.tiers || [];
        entitlement = data.entitlement || null;
        renderPlans();
        renderEntitlement();
      })
      .catch(function () { setRpcPill(false, "Status unavailable"); });
  }

  function renderEntitlement() {
    var el = $("entitlement-line");
    if (!el || !entitlement) return;
    var line = "Current: " + (entitlement.label || entitlement.plan) +
      " · " + entitlement.max_keys + " key" + (entitlement.max_keys === 1 ? "" : "s");
    if (entitlement.paid && entitlement.expires_at) {
      line += " · until " + String(entitlement.expires_at).replace("T", " ").slice(0, 16) + " UTC";
    }
    el.textContent = line;
  }

  function renderPlans() {
    var grid = $("ssh-plans");
    if (!grid || !sshTiers.length) return;
    grid.innerHTML = "";
    sshTiers.forEach(function (tier) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "purpose-card" + (tier.id === selectedPlan ? " selected" : "");
      btn.setAttribute("data-plan", tier.id);
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", tier.id === selectedPlan ? "true" : "false");
      var price = int(tier.price_nch) <= 0 ? "Free" : (tier.price_nch + " NCH");
      btn.innerHTML =
        '<span class="purpose-label">' + esc(tier.label) + "</span>" +
        '<span class="purpose-hint">' + esc(tier.hint || price) + "</span>" +
        '<span class="purpose-hint mono">' + esc(price) + "</span>";
      btn.addEventListener("click", function () { selectPlan(tier.id); });
      grid.appendChild(btn);
    });
  }

  function int(n) { return parseInt(n, 10) || 0; }

  function selectPlan(planId) {
    selectedPlan = planId;
    renderPlans();
    var tier = null;
    for (var i = 0; i < sshTiers.length; i++) {
      if (sshTiers[i].id === planId) { tier = sshTiers[i]; break; }
    }
    var pay = $("ssh-pay");
    if (!tier || int(tier.price_nch) <= 0) {
      if (pay) pay.style.display = "none";
      pendingSshIntent = null;
      return;
    }
    if (pay) pay.style.display = "";
    if ($("ssh-pay-addr")) $("ssh-pay-addr").value = payAddress || "";
    if ($("ssh-pay-amount")) {
      $("ssh-pay-amount").textContent = tier.price_nch + " NCH · " + (tier.hint || "");
    }
    // Create intent
    fetch("/api/ssh/intent", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, deviceHeaders()),
      credentials: "same-origin",
      body: JSON.stringify({ plan: planId }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (pack) {
        if (!pack.d || !pack.d.success) {
          toast((pack.d && pack.d.error) || "Could not start payment", "err");
          return;
        }
        pendingSshIntent = {
          intent_id: pack.d.intent_id,
          plan: planId,
          amount_nch: pack.d.amount_nch,
        };
        try {
          sessionStorage.setItem("ness_pay_intent_ssh", JSON.stringify(pendingSshIntent));
        } catch (e) {}
        if ($("ssh-pay-addr") && pack.d.pay_address) {
          $("ssh-pay-addr").value = pack.d.pay_address;
        }
        toast("Send " + pack.d.amount_nch + " NCH, then paste the tx hash", "ok");
      })
      .catch(function () { toast("Could not start payment", "err"); });
  }

  function verifySshPay() {
    var tx = ($("ssh-pay-tx") && $("ssh-pay-tx").value || "").trim();
    if (!pendingSshIntent) {
      try {
        pendingSshIntent = JSON.parse(sessionStorage.getItem("ness_pay_intent_ssh") || "null");
      } catch (e) { pendingSshIntent = null; }
    }
    if (!pendingSshIntent || !pendingSshIntent.intent_id) {
      toast("Select a paid plan first", "warn");
      return;
    }
    if (tx.length < 16) { toast("Paste a valid transaction hash", "warn"); return; }
    var btn = $("btn-ssh-verify");
    if (btn) { btn.disabled = true; btn.textContent = "Verifying…"; }
    fetch("/api/ssh/verify", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, deviceHeaders()),
      credentials: "same-origin",
      body: JSON.stringify({
        tx_hash: tx,
        intent_id: pendingSshIntent.intent_id,
        plan: pendingSshIntent.plan || selectedPlan,
      }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (pack) {
        if (!pack.d || !pack.d.success) {
          var err = (pack.d && pack.d.error) || "Verification failed";
          if (String(err).toLowerCase().indexOf("already used") >= 0) {
            err = "This transaction already confirmed another payment.";
          }
          toast(err, "err");
          return;
        }
        toast("Plan active — you can register more public keys", "ok");
        pendingSshIntent = null;
        try { sessionStorage.removeItem("ness_pay_intent_ssh"); } catch (e) {}
        if ($("ssh-pay")) $("ssh-pay").style.display = "none";
        selectedPlan = "free";
        loadStatus();
        loadKeys();
      })
      .catch(function () { toast("Verification failed", "err"); })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Verify payment"; }
      });
  }

  function postKey(username, public_key) {
    return fetch("/api/ssh/keys", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, deviceHeaders()),
      credentials: "same-origin",
      body: JSON.stringify({ username: username, public_key: public_key }),
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    });
  }

  function saveKey() {
    var username = ($("ssh-username") && $("ssh-username").value || "").trim().toLowerCase();
    var public_key = ($("ssh-pubkey") && $("ssh-pubkey").value || "").trim();
    if (!username) { toast("Enter SSH username", "warn"); return; }
    if (!public_key) { toast("Paste a public key", "warn"); return; }
    var btn = $("btn-save-key");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    postKey(username, public_key)
      .then(function (pack) {
        if (!pack.d || !pack.d.success) {
          var err = (pack.d && pack.d.error) || "Save failed";
          if (pack.d && pack.d.need_upgrade) {
            toast(err, "warn");
            requestAnimationFrame(function () {
              smartScrollTo($("plans-card") || $("ssh-plans"), { force: true });
            });
          } else {
            toast(err, "err");
          }
          return;
        }
        toast("Key saved (pending)", "ok");
        $("add-card").style.display = "none";
        if ($("ssh-pubkey")) $("ssh-pubkey").value = "";
        selectedUser = username;
        try { localStorage.setItem(SELECT_USER_KEY, selectedUser); } catch (e) {}
        updateCmd();
        loadKeys();
        requestAnimationFrame(function () {
          var sc = $("keys-scroll");
          if (sc) {
            sc.scrollTop = 0;
            smartScrollTo(sc, { force: true });
          }
        });
      })
      .catch(function () { toast("Save failed", "err"); })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Save key"; }
      });
  }

  function activateKey(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    fetch("/api/ssh/keys/" + encodeURIComponent(id) + "/activate", {
      method: "POST", headers: deviceHeaders(), credentials: "same-origin",
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (pack) {
        if (!pack.d || !pack.d.success) {
          toast((pack.d && pack.d.error) || "Activation failed", "err");
          return;
        }
        if (pack.d.local_only) toast(pack.d.warning || "Activated in lab mode", "warn");
        else toast("Key activated", "ok");
        loadKeys();
      })
      .catch(function () { toast("Activation failed", "err"); })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Activate"; }
      });
  }

  function revokeKey(id) {
    var go = window.nessConfirm
      ? window.nessConfirm({
          title: "Revoke key?",
          message: "SSH logins with this key will fail after revoke.",
          confirmLabel: "Revoke",
          danger: true,
        })
      : Promise.resolve(true);
    Promise.resolve(go).then(function (ok) {
      if (!ok) return;
      fetch("/api/ssh/keys/" + encodeURIComponent(id), {
        method: "DELETE", headers: deviceHeaders(), credentials: "same-origin",
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (!data || !data.success) {
            toast((data && data.error) || "Revoke failed", "err");
            return;
          }
          toast("Key revoked", "ok");
          loadKeys();
        })
        .catch(function () { toast("Revoke failed", "err"); });
    });
  }


  function mpintFromBigInt(bi) {
    if (bi < 0n) throw new Error("negative mpint");
    var hex = bi.toString(16);
    if (hex.length % 2) hex = "0" + hex;
    var bytes = [];
    for (var i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    if (bytes.length && (bytes[0] & 0x80)) bytes.unshift(0);
    if (!bytes.length) bytes = [0];
    return sshString(new Uint8Array(bytes));
  }

  function toOpenSshRsa(nBytes, eBytes, comment) {
    var type = new TextEncoder().encode("ssh-rsa");
    // nBytes/eBytes as unsigned big-endian
    function asMp(u8) {
      var a = Array.from(u8);
      while (a.length > 1 && a[0] === 0) a.shift();
      if (a[0] & 0x80) a.unshift(0);
      return sshString(new Uint8Array(a));
    }
    var body = concatBytes([sshString(type), asMp(eBytes), asMp(nBytes)]);
    return "ssh-rsa " + b64(body) + (comment ? " " + comment : "");
  }

  function toOpenSshEcdsa(curve, rawUncompressed, comment) {
    // curve: nistp256 | nistp384 | nistp521
    var typeStr = "ecdsa-sha2-" + curve;
    var type = new TextEncoder().encode(typeStr);
    var curveB = new TextEncoder().encode(curve);
    var body = concatBytes([sshString(type), sshString(curveB), sshString(rawUncompressed)]);
    return typeStr + " " + b64(body) + (comment ? " " + comment : "");
  }

  async function generateKeypair() {
    if (!window.crypto || !crypto.subtle) {
      toast("WebCrypto unavailable in this browser", "err");
      return;
    }
    var algo = ($("gen-algo") && $("gen-algo").value) || "ed25519";
    var btn = $("btn-generate");
    if (btn) { btn.disabled = true; btn.textContent = "Generating…"; }
    var comment = "ness-" + new Date().toISOString().slice(0, 10);
    try {
      var pubLine = "";
      var pem = "";
      if (algo === "ed25519") {
        var kp;
        try {
          kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        } catch (e1) {
          toast("Ed25519 not supported — try ECDSA or RSA, or paste from ssh-keygen", "warn");
          if (btn) { btn.disabled = false; btn.textContent = "Generate keypair"; }
          return;
        }
        var rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
        var pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
        pubLine = toOpenSshPublic(rawPub, comment);
        var seed = ed25519SeedFromPkcs8(pkcs8);
        if (seed && seed.length === 32) {
          pem = toOpenSshPrivateEd25519(seed, rawPub, comment);
        } else {
          pem = toPemPkcs8(pkcs8);
        }
      } else if (algo === "ecdsa256" || algo === "ecdsa384") {
        var named = algo === "ecdsa256" ? "P-256" : "P-384";
        var curve = algo === "ecdsa256" ? "nistp256" : "nistp384";
        var ekp = await crypto.subtle.generateKey(
          { name: "ECDSA", namedCurve: named }, true, ["sign", "verify"]
        );
        var raw = new Uint8Array(await crypto.subtle.exportKey("raw", ekp.publicKey));
        // raw is uncompressed 0x04||x||y for ECDSA
        var epkcs8 = await crypto.subtle.exportKey("pkcs8", ekp.privateKey);
        pubLine = toOpenSshEcdsa(curve, raw, comment);
        pem = toPemPkcs8(epkcs8);
      } else if (algo === "rsa2048" || algo === "rsa4096") {
        var mod = algo === "rsa4096" ? 4096 : 2048;
        var rkp = await crypto.subtle.generateKey(
          { name: "RSASSA-PKCS1-v1_5", modulusLength: mod, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
          true, ["sign", "verify"]
        );
        var jwk = await crypto.subtle.exportKey("jwk", rkp.publicKey);
        function b64urlToBytes(s) {
          s = s.replace(/-/g, "+").replace(/_/g, "/");
          while (s.length % 4) s += "=";
          var bin = atob(s);
          var out = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
          return out;
        }
        var nBytes = b64urlToBytes(jwk.n);
        var eBytes = b64urlToBytes(jwk.e);
        var rpkcs8 = await crypto.subtle.exportKey("pkcs8", rkp.privateKey);
        pubLine = toOpenSshRsa(nBytes, eBytes, comment);
        pem = toPemPkcs8(rpkcs8);
      } else {
        toast("Unknown algorithm", "err");
        if (btn) { btn.disabled = false; btn.textContent = "Generate keypair"; }
        return;
      }
      $("gen-card").style.display = "";
      $("gen-public").value = pubLine;
      $("gen-private").value = pem;
      if ($("gen-username") && !$("gen-username").value) {
        try {
          var hint = (selectedUser || localStorage.getItem(SELECT_USER_KEY) || "").trim();
          if (hint) $("gen-username").value = hint;
        } catch (e) {}
      }
      toast("Keypair ready — download the private key before leaving", "ok");
      requestAnimationFrame(function () {
        smartScrollTo($("gen-card"), { force: true, focusId: "btn-dl-private" });
      });
    } catch (e) {
      console.error(e);
      toast("Key generation failed for this type — try another algorithm", "err");
    }
    if (btn) { btn.disabled = false; btn.textContent = "Generate keypair"; }
  }

  function wipeGenSecrets() {
    if ($("gen-private")) $("gen-private").value = "";
    if ($("gen-public")) $("gen-public").value = "";
  }

  function downloadPrivate() {
    var pem = ($("gen-private") && $("gen-private").value) || "";
    if (!pem) return;
    var blob = new Blob([pem], { type: "application/x-pem-file" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    if (pem.indexOf("OPENSSH PRIVATE KEY") >= 0) a.download = "id_ed25519";
    else if (pem.indexOf("BEGIN PRIVATE KEY") >= 0) a.download = "ness-ssh-private.pem";
    else a.download = "ness-ssh-key.txt";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      try { URL.revokeObjectURL(a.href); a.remove(); } catch (e) {}
    }, 500);
    toast("Private key downloaded", "ok");
  }

  function registerGenerated() {
    var username = ($("gen-username") && $("gen-username").value || "").trim().toLowerCase();
    var public_key = ($("gen-public") && $("gen-public").value || "").trim();
    if (!username) { toast("Enter SSH username", "warn"); return; }
    if (!public_key) { toast("Missing public key", "err"); return; }
    var btn = $("btn-register-gen");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    postKey(username, public_key)
      .then(function (pack) {
        if (!pack.d || !pack.d.success) {
          var err2 = (pack.d && pack.d.error) || "Save failed";
          if (pack.d && pack.d.need_upgrade) {
            toast(err2, "warn");
            requestAnimationFrame(function () {
              smartScrollTo($("plans-card") || $("ssh-plans"), { force: true });
            });
          } else {
            toast(err2, "err");
          }
          return;
        }
        toast("Public key added (pending) — activate when ready", "ok");
        selectedUser = username;
        try { localStorage.setItem(SELECT_USER_KEY, selectedUser); } catch (e) {}
        updateCmd();
        $("gen-card").style.display = "none";
        wipeGenSecrets();
        loadKeys();
        requestAnimationFrame(function () {
          smartScrollTo($("keys-list") || $("keys-empty"), { force: true });
        });
      })
      .catch(function () { toast("Save failed", "err"); })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = "Add public key"; }
      });
  }

  function bindTheme() {
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

  function boot() {
    bindTheme();
    try {
      var h = localStorage.getItem(HOST_KEY) || "";
      if ($("ssh-host") && h) $("ssh-host").value = h;
      selectedUser = localStorage.getItem(SELECT_USER_KEY) || "";
    } catch (e) {}
    updateCmd();
    if ($("ssh-host")) {
      $("ssh-host").addEventListener("input", function () {
        try { localStorage.setItem(HOST_KEY, $("ssh-host").value.trim()); } catch (e) {}
        updateCmd();
      });
    }
    if ($("btn-copy-cmd")) {
      $("btn-copy-cmd").addEventListener("click", function () {
        var cmd = ($("ssh-cmd") && $("ssh-cmd").value) || "";
        if (!cmd || cmd.indexOf("<") >= 0) {
          toast("Set host and pick a key first", "warn");
          return;
        }
        copyText(cmd, "Command copied", "Nothing to copy");
      });
    }

    var bootVault = window.NessVault && NessVault.ensureVault
      ? NessVault.ensureVault()
      : Promise.resolve({ ok: true });
    bootVault.then(function () {
      loadStatus();
      loadKeys();
    });

    if ($("btn-add-key")) {
      $("btn-add-key").addEventListener("click", function () {
        $("add-card").style.display = "";
        $("gen-card").style.display = "none";
        requestAnimationFrame(function () {
          smartScrollTo($("add-card"), { force: true, focusId: "ssh-username" });
        });
      });
    }
    if ($("btn-cancel-add")) {
      $("btn-cancel-add").addEventListener("click", function () {
        $("add-card").style.display = "none";
      });
    }
    if ($("btn-save-key")) $("btn-save-key").addEventListener("click", saveKey);
    if ($("btn-generate")) $("btn-generate").addEventListener("click", generateKeypair);
    if ($("btn-cancel-gen")) {
      $("btn-cancel-gen").addEventListener("click", function () {
        $("gen-card").style.display = "none";
        wipeGenSecrets();
      });
    }
    if ($("btn-dl-private")) $("btn-dl-private").addEventListener("click", downloadPrivate);
    if ($("btn-copy-private")) {
      $("btn-copy-private").addEventListener("click", function () {
        var pem = ($("gen-private") && $("gen-private").value) || "";
        if (!pem.trim()) { toast("Nothing to copy", "warn"); return; }
        copyText(pem, "Private key copied — store it safely", "Nothing to copy");
      });
    }
    if ($("btn-register-gen")) $("btn-register-gen").addEventListener("click", registerGenerated);

    if ($("ssh-pubfile")) {
      $("ssh-pubfile").addEventListener("change", function (ev) {
        var f = ev.target.files && ev.target.files[0];
        if (!f) return;
        var reader = new FileReader();
        reader.onload = function () {
          var text = String(reader.result || "").trim().split(/\r?\n/).filter(Boolean)[0] || "";
          if ($("ssh-pubkey")) $("ssh-pubkey").value = text;
          toast("Public key loaded from file", "ok");
        };
        reader.readAsText(f);
      });
    }

    if ($("btn-invite")) {
      $("btn-invite").addEventListener("click", function () {
        var url = location.origin + "/ssh-access?invite=1";
        $("invite-card").style.display = "";
        if ($("invite-url")) $("invite-url").value = url;
      });
    }
    if ($("btn-copy-invite")) {
      $("btn-copy-invite").addEventListener("click", function () {
        copyText(($("invite-url") && $("invite-url").value) || "", "Invite link copied", "Nothing to copy");
      });
    }
    if ($("btn-close-invite")) {
      $("btn-close-invite").addEventListener("click", function () {
        $("invite-card").style.display = "none";
      });
    }

    if ($("btn-copy-pay-addr")) {
      $("btn-copy-pay-addr").addEventListener("click", function () {
        var addr = ($("ssh-pay-addr") && $("ssh-pay-addr").value) || payAddress || "";
        copyText(addr, "Payment address copied", "No payment address yet — select a paid plan first");
      });
    }
    if ($("btn-ssh-verify")) {
      $("btn-ssh-verify").addEventListener("click", function () {
        verifySshPay();
      });
    }

    if ($("btn-copy-sshd")) {
      $("btn-copy-sshd").addEventListener("click", function () {
        copyText(($("sshd-snippet") && $("sshd-snippet").textContent) || "", "Snippet copied", "Nothing to copy");
      });
    }

    // Invite deep-link opens add form
    try {
      if (/[?&]invite=1(?:&|$)/.test(location.search)) {
        $("add-card").style.display = "";
        toast("Add your public key to join SSH Access on this suite", "ok");
      }
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
