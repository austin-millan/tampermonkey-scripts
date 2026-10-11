// ==UserScript==
// @name         Indeed
// @namespace    https://gitlab.com/austin-millan/tampermonkey-scripts
// @version      1.2.0
// @description  Auto-dislike Indeed job cards from blacklisted companies
// @author       austin-millan
// @match        https://*.indeed.com/*
// @match        https://indeed.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_addElement
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const DEFAULT_BLACKLIST = [
    "AfterQuery Experts",
    "AfterQuery",
    "Outlier",
    "Outlier AI",
    "DataAnnotation",
    "Remotasks",
    "Scale AI",
    "Surge AI",
    "Turing",
    "Mercor",
  ];

  const STORAGE_KEY = "indeedCompanyBlacklist";
  const PROCESSED_ATTR = "data-indeed-blacklist-processed";
  const HIDDEN_ATTR = "data-indeed-blacklist-hidden";
  const CLICK_MARK_ATTR = "data-indeed-blacklist-click";
  const CLICK_ATTEMPTS_ATTR = "data-indeed-blacklist-click-attempts";
  const SCAN_DEBOUNCE_MS = 250;
  const CLICK_STAGGER_MS = 200;
  const RESCAN_INTERVAL_MS = 1500;
  const MAX_CLICK_ATTEMPTS = 5;

  const COMPANY_NAME_SELECTOR = [
    '[data-testid="company-name"]',
    ".jobcard-compact-company",
  ].join(", ");
  const DISLIKE_SELECTOR = [
    "button.dislike-tap-target",
    'button[data-testid="dislikeicon"]',
    'button[data-testid="vj-dislikeJobButton"]',
    'button[aria-label="Not interested"]',
  ].join(", ");
  const CAROUSEL_ITEM_SELECTOR = '[data-testid="simple-carousel-item"]';
  const GROUPING_SECTION_SELECTOR = '[data-testid="serp-grouping-section"]';
  const JOB_CARD_SELECTORS = [
    CAROUSEL_ITEM_SELECTOR,
    ".jobcard-compact",
    ".cardOutline",
    ".job_seen_beacon",
    ".slider_item",
    "[data-jk]",
    ".tapItem",
    "li.result",
    "li.css-1ac2h1w",
  ];

  function getBlacklist() {
    const stored = GM_getValue(STORAGE_KEY, null);
    if (stored === null || stored === undefined) {
      return [...DEFAULT_BLACKLIST];
    }
    if (!Array.isArray(stored)) {
      console.warn(
        "[Indeed Blacklist] Stored blacklist is invalid; using defaults."
      );
      return [...DEFAULT_BLACKLIST];
    }
    return stored.map((entry) => String(entry).trim()).filter(Boolean);
  }

  function setBlacklist(entries) {
    const cleaned = entries.map((entry) => String(entry).trim()).filter(Boolean);
    GM_setValue(STORAGE_KEY, cleaned);
    return cleaned;
  }

  function resetBlacklist() {
    GM_setValue(STORAGE_KEY, null);
    return [...DEFAULT_BLACKLIST];
  }

  function normalize(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function matchesBlacklist(companyName, blacklist) {
    const normalizedCompany = normalize(companyName);
    if (!normalizedCompany) {
      return null;
    }

    return (
      blacklist.find((entry) => {
        const normalizedEntry = normalize(entry);
        return (
          normalizedEntry &&
          (normalizedCompany.includes(normalizedEntry) ||
            normalizedEntry.includes(normalizedCompany))
        );
      }) || null
    );
  }

  function findJobCard(element) {
    for (const selector of JOB_CARD_SELECTORS) {
      const card = element.closest(selector);
      if (card) {
        return card;
      }
    }

    let current = element.parentElement;
    while (current && current !== document.body) {
      if (current.querySelector(DISLIKE_SELECTOR)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function findHideTarget(jobCard) {
    return (
      jobCard.closest(CAROUSEL_ITEM_SELECTOR) ||
      jobCard.closest("li") ||
      jobCard.closest(".cardOutline") ||
      jobCard.closest("[data-jk]") ||
      jobCard
    );
  }

  function findDislikeControl(jobCard) {
    const hideTarget = findHideTarget(jobCard);
    // Covers standard cards and carousel items (incl. carousel-actions-top-right).
    return (
      jobCard.querySelector(DISLIKE_SELECTOR) ||
      hideTarget.querySelector(DISLIKE_SELECTOR) ||
      null
    );
  }

  function hideElement(target) {
    if (target.getAttribute(HIDDEN_ATTR) === "1") {
      return target;
    }

    target.setAttribute(HIDDEN_ATTR, "1");
    target.style.setProperty("display", "none", "important");
    target.setAttribute("aria-hidden", "true");
    return target;
  }

  function cleanupEmptyGroupingSections() {
    document.querySelectorAll(GROUPING_SECTION_SELECTOR).forEach((section) => {
      if (section.getAttribute(HIDDEN_ATTR) === "1") {
        return;
      }

      const items = section.querySelectorAll(CAROUSEL_ITEM_SELECTOR);
      if (items.length === 0) {
        return;
      }

      const hasVisibleItem = Array.from(items).some(
        (item) => item.getAttribute(HIDDEN_ATTR) !== "1"
      );
      if (!hasVisibleItem) {
        hideElement(section);
      }
    });
  }

  function hideJobCard(jobCard) {
    const target = hideElement(findHideTarget(jobCard));
    cleanupEmptyGroupingSections();
    return target;
  }

  function clickDislike(control) {
    const marker = `bl-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    control.setAttribute(CLICK_MARK_ATTR, marker);

    const pageScript = `
      (function () {
        var el = document.querySelector('[${CLICK_MARK_ATTR}="${marker}"]');
        if (!el) return;
        el.removeAttribute('${CLICK_MARK_ATTR}');
        try {
          el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        } catch (err) {}
        if (typeof el.click === 'function') {
          el.click();
        } else {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      })();
    `;

    try {
      if (typeof GM_addElement === "function") {
        GM_addElement(document.documentElement, "script", {
          textContent: pageScript,
        });
        return;
      }
    } catch (err) {
      console.warn("[Indeed Blacklist] Page-context click failed, falling back.", err);
    }

    control.removeAttribute(CLICK_MARK_ATTR);
    if (typeof control.click === "function") {
      control.click();
      return;
    }

    control.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })
    );
  }

  function clearProcessedMarkers() {
    document
      .querySelectorAll(
        `[${PROCESSED_ATTR}], [${HIDDEN_ATTR}], [${CLICK_MARK_ATTR}], [${CLICK_ATTEMPTS_ATTR}]`
      )
      .forEach((node) => {
        node.removeAttribute(PROCESSED_ATTR);
        node.removeAttribute(HIDDEN_ATTR);
        node.removeAttribute(CLICK_MARK_ATTR);
        node.removeAttribute(CLICK_ATTEMPTS_ATTR);
        if (node.style && node.style.display === "none") {
          node.style.removeProperty("display");
        }
        if (node.getAttribute("aria-hidden") === "true") {
          node.removeAttribute("aria-hidden");
        }
      });
  }

  function processJobCards() {
    const blacklist = getBlacklist();
    if (blacklist.length === 0) {
      return;
    }

    const companyNodes = document.querySelectorAll(COMPANY_NAME_SELECTOR);
    let clickDelay = 0;

    companyNodes.forEach((companyNode) => {
      const companyName = companyNode.textContent;
      if (!normalize(companyName)) {
        return;
      }

      const matchedEntry = matchesBlacklist(companyName, blacklist);
      if (!matchedEntry) {
        companyNode.setAttribute(PROCESSED_ATTR, "1");
        return;
      }

      if (companyNode.getAttribute(PROCESSED_ATTR) === "1") {
        return;
      }

      const jobCard = findJobCard(companyNode);
      if (!jobCard) {
        return;
      }

      const alreadyHidden = findHideTarget(jobCard).getAttribute(HIDDEN_ATTR) === "1";
      const hideTarget = hideJobCard(jobCard);
      const dislikeControl = findDislikeControl(jobCard) || findDislikeControl(hideTarget);

      const title =
        jobCard.querySelector('[id^="jobTitle-"], .jobTitle, .jcs-JobTitle')
          ?.textContent?.trim() || "(untitled)";

      if (!alreadyHidden) {
        console.info(
          `[Indeed Blacklist] Hid "${title}" from "${companyName.trim()}" (matched: "${matchedEntry}")`
        );
      }

      if (!dislikeControl) {
        return;
      }

      const attempts = Number(hideTarget.getAttribute(CLICK_ATTEMPTS_ATTR) || "0");
      if (attempts >= MAX_CLICK_ATTEMPTS) {
        companyNode.setAttribute(PROCESSED_ATTR, "1");
        hideTarget.setAttribute(PROCESSED_ATTR, "1");
        return;
      }

      hideTarget.setAttribute(CLICK_ATTEMPTS_ATTR, String(attempts + 1));

      window.setTimeout(() => {
        clickDislike(dislikeControl);
        console.info(
          `[Indeed Blacklist] Disliked "${title}" from "${companyName.trim()}" (matched: "${matchedEntry}", attempt ${attempts + 1})`
        );
      }, clickDelay);

      clickDelay += CLICK_STAGGER_MS;
    });
  }

  function debounce(fn, waitMs) {
    let timerId = null;
    return function debounced(...args) {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(() => fn.apply(this, args), waitMs);
    };
  }

  const EDITOR_ROOT_ID = "indeed-blacklist-editor-root";

  function closeBlacklistEditor() {
    document.getElementById(EDITOR_ROOT_ID)?.remove();
  }

  function openBlacklistEditor({ readOnly = false } = {}) {
    closeBlacklistEditor();

    const workingList = getBlacklist();

    const root = document.createElement("div");
    root.id = EDITOR_ROOT_ID;
    Object.assign(root.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "rgba(15, 23, 42, 0.45)",
      fontFamily:
        'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
    });

    const panel = document.createElement("div");
    Object.assign(panel.style, {
      width: "min(440px, calc(100vw - 32px))",
      maxHeight: "min(640px, calc(100vh - 32px))",
      overflow: "auto",
      background: "#fff",
      color: "#0f172a",
      borderRadius: "12px",
      boxShadow: "0 18px 50px rgba(15, 23, 42, 0.28)",
      padding: "20px",
      boxSizing: "border-box",
    });

    const title = document.createElement("h2");
    title.textContent = readOnly
      ? "Indeed company blacklist"
      : "Edit company blacklist";
    Object.assign(title.style, {
      margin: "0 0 6px",
      fontSize: "18px",
      fontWeight: "700",
    });

    const help = document.createElement("p");
    help.textContent = readOnly
      ? "Matching is case-insensitive substring match."
      : "Add one company at a time. Matching is case-insensitive substring match.";
    Object.assign(help.style, {
      margin: "0 0 14px",
      fontSize: "13px",
      color: "#475569",
      lineHeight: "1.4",
    });

    const list = document.createElement("ul");
    Object.assign(list.style, {
      listStyle: "none",
      margin: "0 0 14px",
      padding: "0",
      border: "1px solid #e2e8f0",
      borderRadius: "8px",
      maxHeight: "320px",
      overflow: "auto",
    });

    const empty = document.createElement("div");
    empty.textContent = "No companies in the blacklist.";
    Object.assign(empty.style, {
      padding: "14px",
      fontSize: "13px",
      color: "#64748b",
      textAlign: "center",
    });

    function renderList() {
      list.replaceChildren();
      if (workingList.length === 0) {
        list.appendChild(empty);
        return;
      }

      workingList.forEach((company, index) => {
        const item = document.createElement("li");
        Object.assign(item.style, {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "10px",
          padding: "10px 12px",
          borderBottom:
            index === workingList.length - 1 ? "none" : "1px solid #e2e8f0",
          fontSize: "14px",
        });

        const label = document.createElement("span");
        label.textContent = company;
        label.style.overflowWrap = "anywhere";

        item.appendChild(label);

        if (!readOnly) {
          const removeBtn = document.createElement("button");
          removeBtn.type = "button";
          removeBtn.textContent = "Remove";
          Object.assign(removeBtn.style, {
            flex: "0 0 auto",
            border: "1px solid #cbd5e1",
            background: "#f8fafc",
            color: "#0f172a",
            borderRadius: "6px",
            padding: "4px 8px",
            fontSize: "12px",
            cursor: "pointer",
          });
          removeBtn.addEventListener("click", () => {
            workingList.splice(index, 1);
            renderList();
          });
          item.appendChild(removeBtn);
        }

        list.appendChild(item);
      });
    }

    panel.append(title, help, list);

    if (!readOnly) {
      const addRow = document.createElement("div");
      Object.assign(addRow.style, {
        display: "flex",
        gap: "8px",
        marginBottom: "14px",
      });

      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Company name";
      input.setAttribute("aria-label", "Company name");
      Object.assign(input.style, {
        flex: "1 1 auto",
        minWidth: "0",
        border: "1px solid #cbd5e1",
        borderRadius: "8px",
        padding: "8px 10px",
        fontSize: "14px",
      });

      const addBtn = document.createElement("button");
      addBtn.type = "button";
      addBtn.textContent = "Add";
      Object.assign(addBtn.style, {
        flex: "0 0 auto",
        border: "none",
        background: "#0f172a",
        color: "#fff",
        borderRadius: "8px",
        padding: "8px 14px",
        fontSize: "14px",
        cursor: "pointer",
      });

      function addCompany() {
        const value = input.value.trim();
        if (!value) {
          input.focus();
          return;
        }

        const exists = workingList.some(
          (entry) => normalize(entry) === normalize(value)
        );
        if (!exists) {
          workingList.push(value);
          renderList();
        }
        input.value = "";
        input.focus();
      }

      addBtn.addEventListener("click", addCompany);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          addCompany();
        }
      });

      addRow.append(input, addBtn);
      panel.appendChild(addRow);
    }

    const actions = document.createElement("div");
    Object.assign(actions.style, {
      display: "flex",
      justifyContent: "flex-end",
      gap: "8px",
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = readOnly ? "Close" : "Cancel";
    Object.assign(closeBtn.style, {
      border: "1px solid #cbd5e1",
      background: "#fff",
      color: "#0f172a",
      borderRadius: "8px",
      padding: "8px 14px",
      fontSize: "14px",
      cursor: "pointer",
    });
    closeBtn.addEventListener("click", closeBlacklistEditor);

    actions.appendChild(closeBtn);

    if (!readOnly) {
      const saveBtn = document.createElement("button");
      saveBtn.type = "button";
      saveBtn.textContent = "Save";
      Object.assign(saveBtn.style, {
        border: "none",
        background: "#2557a7",
        color: "#fff",
        borderRadius: "8px",
        padding: "8px 14px",
        fontSize: "14px",
        cursor: "pointer",
      });
      saveBtn.addEventListener("click", () => {
        const next = setBlacklist(workingList);
        clearProcessedMarkers();
        processJobCards();
        closeBlacklistEditor();
        GM_notification({
          title: "Indeed Company Blacklist",
          text: `Saved ${next.length} compan${next.length === 1 ? "y" : "ies"}.`,
          timeout: 2500,
        });
      });
      actions.appendChild(saveBtn);
    }

    panel.appendChild(actions);
    root.appendChild(panel);

    root.addEventListener("click", (event) => {
      if (event.target === root) {
        closeBlacklistEditor();
      }
    });

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        closeBlacklistEditor();
        document.removeEventListener("keydown", onKeyDown, true);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);

    renderList();
    document.documentElement.appendChild(root);

    if (!readOnly) {
      panel.querySelector("input")?.focus();
    }
  }

  function promptEditBlacklist() {
    openBlacklistEditor({ readOnly: false });
  }

  function showCurrentBlacklist() {
    openBlacklistEditor({ readOnly: true });
  }

  function promptResetBlacklist() {
    const confirmed = window.confirm(
      "Reset blacklist to the script defaults?\n\n" +
        DEFAULT_BLACKLIST.join("\n")
    );
    if (!confirmed) {
      return;
    }

    resetBlacklist();
    clearProcessedMarkers();
    processJobCards();

    GM_notification({
      title: "Indeed Company Blacklist",
      text: "Blacklist reset to defaults.",
      timeout: 2500,
    });
  }

  function registerMenuCommands() {
    GM_registerMenuCommand("Indeed Blacklist: View…", showCurrentBlacklist);
    GM_registerMenuCommand("Indeed Blacklist: Edit…", promptEditBlacklist);
    GM_registerMenuCommand("Indeed Blacklist: Reset to defaults", promptResetBlacklist);
  }

  function startObserver() {
    const scheduledScan = debounce(processJobCards, SCAN_DEBOUNCE_MS);

    const observer = new MutationObserver(scheduledScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    processJobCards();
    scheduledScan();
    window.setInterval(processJobCards, RESCAN_INTERVAL_MS);
  }

  registerMenuCommands();
  startObserver();

  const activeCount = getBlacklist().length;
  console.info(
    `[Indeed Blacklist] Active with ${activeCount} compan${
      activeCount === 1 ? "y" : "ies"
    }. Use the Tampermonkey menu to view/edit.`
  );
})();
