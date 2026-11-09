/* Shared suite navigation — products + companion tools (identical on every page) */
(function () {
  var POISONER_REPO = "https://github.com/Jeff-Bouchard/privateness-data-poisoner";
  /* Archive of default branch (master) — verified downloadable */
  var POISONER_ZIP =
    "https://github.com/Jeff-Bouchard/privateness-data-poisoner/archive/refs/heads/master.zip";

  function ensureNav() {
    if (document.getElementById("suite-root")) return;

    const root = document.createElement("div");
    root.id = "suite-root";
    root.innerHTML =
      '<button type="button" class="suite-burger" id="suite-burger" aria-label="Open suite menu" aria-expanded="false">' +
        '<span></span><span></span><span></span>' +
      "</button>" +
      '<div class="suite-backdrop" id="suite-backdrop" hidden></div>' +
      '<nav class="suite-drawer" id="suite-drawer" aria-hidden="true">' +
        '<div class="suite-drawer-head">NESS Suite</div>' +
        '<a class="suite-link" data-suite="mail" href="/">NESS TempMail</a>' +
        '<a class="suite-link" data-suite="burn" href="/burn">NESS Burn <span class="suite-link-hint">(notes · files · voice)</span></a>' +
        '<a class="suite-link" data-suite="invoice" href="/invoice">NESS Pay</a>' +
        '<a class="suite-link" data-suite="storage" href="/storage">NESS Storage</a>' +
        '<a class="suite-link" data-suite="wormhole" href="/wormhole">NESS Wormhole</a>' +
        '<a class="suite-link" data-suite="ssh" href="/ssh-access">EmerSSH (SSH Access)</a>' +
        '<div class="suite-sep" role="separator" aria-hidden="true"></div>' +
        '<div class="suite-section-label">Companion</div>' +
        '<button type="button" class="suite-link suite-link-ext suite-link-btn" data-suite="poisoner" id="suite-poisoner-btn" ' +
          'aria-haspopup="dialog" ' +
          'aria-label="Install Data Poisoner browser extension, free beta">' +
          '<span class="suite-link-row">' +
            '<span class="suite-link-main">Data Poisoner</span>' +
            '<span class="suite-badge" title="Free browser extension, beta">Free · Beta</span>' +
          '</span>' +
          '<span class="suite-link-hint">Browser extension · offensive privacy</span>' +
        '</button>' +
        '<p class="suite-drawer-note">Offensive privacy, not only defense.</p>' +
        '<p class="suite-drawer-foot">PrivateNess Network</p>' +
      "</nav>";
    document.body.appendChild(root);

    const path = location.pathname || "/";
    let active = "mail";
    if (path.indexOf("/burn") === 0) active = "burn";
    else if (path.indexOf("/invoice") === 0) active = "invoice";
    else if (path.indexOf("/storage") === 0) active = "storage";
    else if (path.indexOf("/wormhole") === 0) active = "wormhole";
    else if (path.indexOf("/ssh") === 0) active = "ssh";
    root.querySelectorAll(".suite-link[data-suite]").forEach(function (a) {
      const id = a.getAttribute("data-suite");
      if (id === active) {
        a.classList.add("is-active");
        a.setAttribute("aria-current", "page");
      }
    });

    const burger = document.getElementById("suite-burger");
    const drawer = document.getElementById("suite-drawer");
    const backdrop = document.getElementById("suite-backdrop");

    function open() {
      drawer.classList.add("open");
      backdrop.hidden = false;
      requestAnimationFrame(function () { backdrop.classList.add("open"); });
      burger.setAttribute("aria-expanded", "true");
      drawer.setAttribute("aria-hidden", "false");
    }
    function close() {
      drawer.classList.remove("open");
      backdrop.classList.remove("open");
      burger.setAttribute("aria-expanded", "false");
      drawer.setAttribute("aria-hidden", "true");
      setTimeout(function () {
        if (!drawer.classList.contains("open")) backdrop.hidden = true;
      }, 200);
    }

    burger.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (drawer.classList.contains("open")) close();
      else open();
    });
    backdrop.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      close();
    });
    drawer.addEventListener("click", function (e) {
      e.stopPropagation();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (document.getElementById("poisoner-guide-overlay")) return;
      close();
    });

    var poisonBtn = document.getElementById("suite-poisoner-btn");
    if (poisonBtn) {
      poisonBtn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        close();
        // After drawer starts closing so backdrop does not cover the guide
        setTimeout(function () {
          openPoisonerGuide();
        }, 180);
      });
    }
  }

  function openPoisonerGuide() {
    var existing = document.getElementById("poisoner-guide-overlay");
    if (existing) {
      existing.classList.add("open");
      existing.style.display = "flex";
      return;
    }

    var overlay = document.createElement("div");
    overlay.id = "poisoner-guide-overlay";
    // .overlay defaults to display:none — must also have .open
    overlay.className = "overlay open poisoner-guide-overlay";
    overlay.style.display = "flex";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "poisoner-guide-title");

    overlay.innerHTML =
      '<div class="modal poisoner-guide-modal">' +
        '<h3 id="poisoner-guide-title">Data Poisoner</h3>' +
        '<p class="poisoner-lead">Free browser extension (beta). It reduces tracking and can feed trackers synthetic data — on your device.</p>' +
        '<p class="poisoner-honest">Browsers do not allow websites to install extensions with one click. Install once with these steps:</p>' +
        '<ol class="poisoner-steps">' +
          '<li><strong>Download</strong> the extension folder (ZIP).</li>' +
          '<li><strong>Unpack</strong> the ZIP on your computer.</li>' +
          '<li>Open <strong>brave://extensions</strong> or <strong>chrome://extensions</strong> (paste in the address bar).</li>' +
          '<li>Turn on <strong>Developer mode</strong>.</li>' +
          '<li>Click <strong>Load unpacked</strong> and select the unpacked folder.</li>' +
        '</ol>' +
        '<div class="modal-actions poisoner-actions">' +
          '<a class="btn" id="poisoner-dl" href="' + POISONER_ZIP + '" target="_blank" rel="noopener noreferrer">Download ZIP</a>' +
          '<a class="btn btn-ghost" id="poisoner-gh" href="' + POISONER_REPO + '" target="_blank" rel="noopener noreferrer">Open on GitHub</a>' +
          '<button type="button" class="btn btn-ghost" id="poisoner-close">Close</button>' +
        '</div>' +
        '<p class="poisoner-foot">After install: choose a mode on the options page (Baseline, Moderate, or Strict + Data Poisoning).</p>' +
      '</div>';

    document.body.appendChild(overlay);

    function dismiss() {
      try { overlay.remove(); } catch (e) {}
      document.removeEventListener("keydown", onKey);
    }
    function onKey(e) {
      if (e.key === "Escape") dismiss();
    }
    document.addEventListener("keydown", onKey);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) dismiss();
    });
    var closeBtn = document.getElementById("poisoner-close");
    if (closeBtn) closeBtn.addEventListener("click", dismiss);

    // Prefer primary ZIP; if user hits 404 on ness-network, GitHub button still works
    var dl = document.getElementById("poisoner-dl");
    if (dl) {
      dl.addEventListener("click", function () {
        /* keep default navigation; fallback documented in GitHub link */
      });
    }

    var focusEl = document.getElementById("poisoner-dl") || closeBtn;
    if (focusEl) {
      try { focusEl.focus(); } catch (e) {}
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureNav);
  } else {
    ensureNav();
  }
})();
