// ==UserScript==
// @name         Job Board Blacklist
// @namespace    https://gitlab.com/austin-millan/tampermonkey-scripts
// @version      2.1.0
// @description  Auto-dislike/dismiss Indeed and LinkedIn job cards from blacklisted companies
// @author       austin-millan
// @match        https://*.indeed.com/*
// @match        https://indeed.com/*
// @match        https://www.linkedin.com/*
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
    "Ladders",
    "TalentHop",
    "Speechify",
    "tether.io",
    "Hired",
    "micro1",
    "Hired Feed",
    "Toptal",
    "Crossover",
    "PulseMediaNL",
    "devjobs",
    "Braintrust",
    "BruntWork",
    "Virtusa",
    "TALENTMATE",
    "ParamInfo",
    "Keystone",
    "Joveo",
    "Quik",
    "Twine",
    "Proxify",
    "Taskify",
    "Referral",
    "Crossing Work",
    "Sundayy",
    "Wiraa",
  ];

  const LOG_PREFIX = "[Job Board Blacklist]";
  const NOTIFICATION_TITLE = "Job Board Company Blacklist";
  const STORAGE_KEY = "jobBoardCompanyBlacklist";
  const HIDDEN_ATTR = "data-job-board-blacklist-hidden";
  const CLICK_MARK_ATTR = "data-job-board-blacklist-click";
  const CLICK_ATTEMPTS_ATTR = "data-job-board-blacklist-click-attempts";
  const SCAN_DEBOUNCE_MS = 250;
  const CLICK_STAGGER_MS = 200;
  const RESCAN_INTERVAL_MS = 1500;
  const MAX_CLICK_ATTEMPTS = 5;
  const UNTITLED_JOB = "(untitled)";

  const INDEED_COMPANY_NAME_SELECTOR = [
    '[data-testid="company-name"]',
    ".jobcard-compact-company",
  ].join(", ");
  const INDEED_DISLIKE_SELECTOR = [
    "button.dislike-tap-target",
    'button[data-testid="dislikeicon"]',
    'button[data-testid="vj-dislikeJobButton"]',
    'button[aria-label="Not interested"]',
  ].join(", ");
  const INDEED_TITLE_SELECTOR = '[id^="jobTitle-"], .jobTitle, .jcs-JobTitle';
  const INDEED_CAROUSEL_ITEM_SELECTOR = '[data-testid="simple-carousel-item"]';
  const INDEED_GROUPING_SECTION_SELECTOR = '[data-testid="serp-grouping-section"]';
  const INDEED_JOB_CARD_SELECTORS = [
    INDEED_CAROUSEL_ITEM_SELECTOR,
    ".jobcard-compact",
    ".cardOutline",
    ".job_seen_beacon",
    ".slider_item",
    "[data-jk]",
    ".tapItem",
    "li.result",
    "li.css-1ac2h1w",
  ];

  const LINKEDIN_JOB_CARD_SELECTOR = [
    '[componentkey^="job-card-component-ref-"]',
    "li[data-occludable-job-id]",
    ".job-card-container",
  ].join(", ");
  const LINKEDIN_DISMISS_SELECTOR = 'button[aria-label^="Dismiss "][aria-label$=" job"]';
  const LINKEDIN_DISMISS_LABEL_PATTERN = /^Dismiss (.+) job$/;
  const LINKEDIN_COMPANY_NAME_SELECTOR = [
    ".artdeco-entity-lockup__subtitle",
    ".job-card-container__primary-description",
    ".job-card-container__company-name",
    'a[href*="/company/"]',
  ].join(", ");

  // ---------------------------------------------------------------------------
  // Blacklist storage and matching
  // ---------------------------------------------------------------------------

  function getBlacklist() {
    const stored = GM_getValue(STORAGE_KEY, null);
    if (stored === null || stored === undefined) {
      return [...DEFAULT_BLACKLIST];
    }
    if (!Array.isArray(stored)) {
      console.warn(`${LOG_PREFIX} Stored blacklist is invalid; using defaults.`);
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

  function firstNonEmptyText(nodes) {
    for (const node of nodes) {
      const text = node.textContent?.trim();
      if (text) {
        return text;
      }
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // Site adapters
  //
  // Each adapter exposes findJobs(), returning
  //   { companyName, title, hideTarget, dismissControl }
  // for every job card currently in the DOM, plus an optional afterHide() hook.
  // ---------------------------------------------------------------------------

  function findIndeedJobCard(element) {
    for (const selector of INDEED_JOB_CARD_SELECTORS) {
      const card = element.closest(selector);
      if (card) {
        return card;
      }
    }

    let current = element.parentElement;
    while (current && current !== document.body) {
      if (current.querySelector(INDEED_DISLIKE_SELECTOR)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  function findIndeedHideTarget(jobCard) {
    return (
      jobCard.closest(INDEED_CAROUSEL_ITEM_SELECTOR) ||
      jobCard.closest("li") ||
      jobCard.closest(".cardOutline") ||
      jobCard.closest("[data-jk]") ||
      jobCard
    );
  }

  function findIndeedJobs() {
    const jobs = [];
    document.querySelectorAll(INDEED_COMPANY_NAME_SELECTOR).forEach((companyNode) => {
      const companyName = companyNode.textContent?.trim();
      if (!companyName) {
        return;
      }

      const jobCard = findIndeedJobCard(companyNode);
      if (!jobCard) {
        return;
      }

      const hideTarget = findIndeedHideTarget(jobCard);
      // Carousel items keep their dislike button outside the card body
      // (carousel-actions-top-right), so fall back to the hide target.
      const dismissControl =
        jobCard.querySelector(INDEED_DISLIKE_SELECTOR) ||
        hideTarget.querySelector(INDEED_DISLIKE_SELECTOR);

      jobs.push({
        companyName,
        title: jobCard.querySelector(INDEED_TITLE_SELECTOR)?.textContent?.trim() || UNTITLED_JOB,
        hideTarget,
        dismissControl,
      });
    });
    return jobs;
  }

  function cleanupEmptyIndeedGroupingSections() {
    document.querySelectorAll(INDEED_GROUPING_SECTION_SELECTOR).forEach((section) => {
      if (section.getAttribute(HIDDEN_ATTR) === "1") {
        return;
      }

      const items = section.querySelectorAll(INDEED_CAROUSEL_ITEM_SELECTOR);
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

  function isOutermostLinkedInCard(card) {
    return !card.parentElement?.closest(LINKEDIN_JOB_CARD_SELECTOR);
  }

  function getLinkedInTitle(dismissControl) {
    const label = dismissControl?.getAttribute("aria-label") || "";
    return label.match(LINKEDIN_DISMISS_LABEL_PATTERN)?.[1]?.trim() || "";
  }

  function textOverlapsTitle(text, title) {
    const normalizedText = normalize(text);
    const normalizedTitle = normalize(title);
    return (
      normalizedTitle !== "" &&
      (normalizedText.includes(normalizedTitle) || normalizedTitle.includes(normalizedText))
    );
  }

  // The newer server-driven LinkedIn UI uses obfuscated class names, so the
  // company is found positionally: the first paragraph after the job title.
  function findLinkedInCompanyByParagraph(card, title) {
    const paragraphs = Array.from(card.querySelectorAll("p"));
    const company = paragraphs.find((paragraph) => {
      const text = paragraph.textContent?.trim();
      return text && !textOverlapsTitle(text, title);
    });
    return company?.textContent?.trim() || "";
  }

  function getLinkedInCompanyName(card, title) {
    return (
      firstNonEmptyText(card.querySelectorAll(LINKEDIN_COMPANY_NAME_SELECTOR)) ||
      findLinkedInCompanyByParagraph(card, title)
    );
  }

  function findLinkedInJobs() {
    return Array.from(document.querySelectorAll(LINKEDIN_JOB_CARD_SELECTOR))
      .filter(isOutermostLinkedInCard)
      .map((card) => {
        const dismissControl = card.querySelector(LINKEDIN_DISMISS_SELECTOR);
        const title = getLinkedInTitle(dismissControl);
        return {
          companyName: getLinkedInCompanyName(card, title),
          title: title || UNTITLED_JOB,
          hideTarget: card.closest("li") || card,
          dismissControl,
        };
      })
      .filter((job) => job.companyName);
  }

  const SITE_ADAPTERS = [
    {
      name: "Indeed",
      hostnamePattern: /(^|\.)indeed\.com$/,
      findJobs: findIndeedJobs,
      afterHide: cleanupEmptyIndeedGroupingSections,
    },
    {
      name: "LinkedIn",
      hostnamePattern: /(^|\.)linkedin\.com$/,
      findJobs: findLinkedInJobs,
    },
  ];

  function detectSite() {
    return (
      SITE_ADAPTERS.find((site) => site.hostnamePattern.test(window.location.hostname)) || null
    );
  }

  // ---------------------------------------------------------------------------
  // Hiding and dismissing
  // ---------------------------------------------------------------------------

  function hideElement(target) {
    if (target.getAttribute(HIDDEN_ATTR) === "1") {
      return target;
    }

    target.setAttribute(HIDDEN_ATTR, "1");
    target.style.setProperty("display", "none", "important");
    target.setAttribute("aria-hidden", "true");
    return target;
  }

  // Returns true when the page-context script ran and clicked the control.
  function clickInPageContext(control) {
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
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Page-context click failed, falling back.`, err);
    }

    return !control.hasAttribute(CLICK_MARK_ATTR);
  }

  function clickDirectly(control) {
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

  function clickDismiss(control) {
    // A strict Content-Security-Policy can silently block the injected script,
    // which leaves the marker attribute in place.
    if (!clickInPageContext(control)) {
      clickDirectly(control);
    }
  }

  function clearScriptMarkers() {
    document
      .querySelectorAll(`[${HIDDEN_ATTR}], [${CLICK_MARK_ATTR}], [${CLICK_ATTEMPTS_ATTR}]`)
      .forEach((node) => {
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

  function hideBlacklistedJob(site, job, description) {
    if (job.hideTarget.getAttribute(HIDDEN_ATTR) === "1") {
      return;
    }

    hideElement(job.hideTarget);
    site.afterHide?.();
    console.info(`${LOG_PREFIX} Hid ${description}`);
  }

  // Returns true when a dismiss click was scheduled.
  function scheduleDismiss(job, description, clickDelay) {
    if (!job.dismissControl) {
      return false;
    }

    const attempts = Number(job.hideTarget.getAttribute(CLICK_ATTEMPTS_ATTR) || "0");
    if (attempts >= MAX_CLICK_ATTEMPTS) {
      return false;
    }

    job.hideTarget.setAttribute(CLICK_ATTEMPTS_ATTR, String(attempts + 1));
    window.setTimeout(() => {
      clickDismiss(job.dismissControl);
      console.info(`${LOG_PREFIX} Dismissed ${description} (attempt ${attempts + 1})`);
    }, clickDelay);
    return true;
  }

  function processJobs(site) {
    const blacklist = getBlacklist();
    if (blacklist.length === 0) {
      return;
    }

    let clickDelay = 0;
    site.findJobs().forEach((job) => {
      const matchedEntry = matchesBlacklist(job.companyName, blacklist);
      if (!matchedEntry) {
        return;
      }

      const description = `"${job.title}" from "${job.companyName}" (matched: "${matchedEntry}")`;
      hideBlacklistedJob(site, job, description);
      if (scheduleDismiss(job, description, clickDelay)) {
        clickDelay += CLICK_STAGGER_MS;
      }
    });
  }

  function debounce(fn, waitMs) {
    let timerId = null;
    return function debounced(...args) {
      window.clearTimeout(timerId);
      timerId = window.setTimeout(() => fn.apply(this, args), waitMs);
    };
  }

  // ---------------------------------------------------------------------------
  // Blacklist editor UI
  // ---------------------------------------------------------------------------

  const EDITOR_ROOT_ID = "job-board-blacklist-editor-root";

  function closeBlacklistEditor() {
    document.getElementById(EDITOR_ROOT_ID)?.remove();
  }

  function openBlacklistEditor({ readOnly = false, onSave }) {
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
      ? "Job board company blacklist"
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
        onSave?.();
        closeBlacklistEditor();
        GM_notification({
          title: NOTIFICATION_TITLE,
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

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  function registerMenuCommands(rescanFromScratch) {
    GM_registerMenuCommand("Job Board Blacklist: View…", () =>
      openBlacklistEditor({ readOnly: true })
    );
    GM_registerMenuCommand("Job Board Blacklist: Edit…", () =>
      openBlacklistEditor({ readOnly: false, onSave: rescanFromScratch })
    );
    GM_registerMenuCommand("Job Board Blacklist: Reset to defaults", () => {
      const confirmed = window.confirm(
        "Reset blacklist to the script defaults?\n\n" + DEFAULT_BLACKLIST.join("\n")
      );
      if (!confirmed) {
        return;
      }

      resetBlacklist();
      rescanFromScratch();
      GM_notification({
        title: NOTIFICATION_TITLE,
        text: "Blacklist reset to defaults.",
        timeout: 2500,
      });
    });
  }

  function startObserver(rescan) {
    const scheduledScan = debounce(rescan, SCAN_DEBOUNCE_MS);

    const observer = new MutationObserver(scheduledScan);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    rescan();
    // Polling backs up the observer for in-place re-renders that don't add nodes.
    window.setInterval(rescan, RESCAN_INTERVAL_MS);
  }

  const site = detectSite();
  if (!site) {
    return;
  }

  const rescan = () => processJobs(site);
  const rescanFromScratch = () => {
    clearScriptMarkers();
    rescan();
  };

  registerMenuCommands(rescanFromScratch);
  startObserver(rescan);

  const activeCount = getBlacklist().length;
  console.info(
    `${LOG_PREFIX} Active on ${site.name} with ${activeCount} compan${
      activeCount === 1 ? "y" : "ies"
    }. Use the Tampermonkey menu to view/edit.`
  );
})();
