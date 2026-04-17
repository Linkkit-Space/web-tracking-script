(() => {
  var pageInfo = {};
  var events = [];
  var script = document.currentScript;
  var siteId = script.getAttribute("data-site");
  var excludeDomains = script.getAttribute("data-exclude-domains") ?? [];
  var external;
  var attachedHandlers = {
    links: [],
    forms: [],
    downloads: [],
    custom: [],
  };
  var maxScrollDepth = 0;

  // --- Time tracking (tab-visibility aware) ---
  var pageStartTime = performance.now();
  var hiddenAt = null;        // when the tab was hidden
  var totalHiddenTime = 0;    // accumulated hidden ms for the current page

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      hiddenAt = performance.now();
    } else {
      if (hiddenAt !== null) {
        totalHiddenTime += performance.now() - hiddenAt;
        hiddenAt = null;
      }
    }
  });

  // Returns active seconds spent on the current page, excluding hidden time.
  function getActiveTimeSpent() {
    var now = performance.now();
    var currentHidden = hiddenAt !== null ? now - hiddenAt : 0;
    var active = now - pageStartTime - totalHiddenTime - currentHidden;
    return Math.max(0, active / 1000);
  }

  // Call after recording time for a page to reset for the next page.
  function resetPageTimer() {
    pageStartTime = performance.now();
    totalHiddenTime = 0;
    hiddenAt = document.hidden ? performance.now() : null;
  }
  // --- end time tracking ---

  var trackFileExtensions = [
    "pdf", "xlsx", "docx", "txt", "rtf", "csv", "exe", "key",
    "pps", "ppt", "pptx", "7z", "pkg", "rar", "gz", "zip",
    "avi", "mov", "mp4", "mpeg", "wmv", "midi", "mp3", "wav", "wma", "dmg",
  ];

  function handleFormSubmit() {
    const getFormName = (form) => {
      if (form.getAttribute("id")) return form.getAttribute("id");
      else if (form.getAttribute("name")) return form.getAttribute("name");
      else return `Form on ${window.location.pathname}`;
    };
    attachedHandlers.forms.forEach(({ element, handler }) => {
      element.removeEventListener("submit", handler);
    });
    attachedHandlers.forms = [];
    document.querySelectorAll("form").forEach((form) => {
      const handler = function () {
        const form_name = getFormName(form);
        events.push(["form_submit", { ...pageInfo, form_name }]);
      };
      form.addEventListener("submit", handler);
      attachedHandlers.forms.push({ element: form, handler });
    });
  }

  function isTrackingEnabled() {
    const { hostname, pathname } = window.location;
    return pathname && hostname && siteId && !excludeDomains?.includes(hostname);
  }

  function sendAnalyticsBeacon(data) {
    if (!isTrackingEnabled()) return;
    if (!data.events || data.events.length === 0) return;
    const evts = data.events;
    data.events = encodeURIComponent(JSON.stringify(evts));
    data.cid = Math.floor(1e8 * Math.random()) + 1;
    data.sid = siteId;
    const searchParams = new URLSearchParams(data).toString();
    const url = "https://track.flooanalytics.com" + "?" + searchParams;
    navigator.sendBeacon(url);
  }

  window.addEventListener("scroll", updateScrollDepth);

  // Build initial pageInfo immediately (works for both SPA and traditional sites).
  function buildPageInfo() {
    const searchParams = new URLSearchParams(window.location.search);
    return {
      host: window.location.hostname,
      path: window.location.pathname,
      ...(document.referrer && { referer: document.referrer }),
      ...Object.fromEntries([...searchParams].filter(([k]) => k !== 'host' && k !== 'path' && k !== 'referer')),
    };
  }

  pageInfo = buildPageInfo();

  if (typeof history !== "undefined") {
    historyBasedTracking();
  } else {
    console.warn("History API not supported. Tracking may not work as expected.");
  }

  function handleExternalLink() {
    attachedHandlers.links.forEach(({ element, handler }) => {
      element.removeEventListener("click", handler);
    });
    attachedHandlers.links = [];

    document.querySelectorAll("a").forEach((link) => {
      const handler = function (event) {
        const href = link.getAttribute("href");
        if (!href) return;
        let linkUrl;
        try {
          linkUrl = new URL(href, window.location.href);
        } catch {
          return;
        }
        const fileExtension = linkUrl.pathname.split(".").pop().toLowerCase();
        if (trackFileExtensions.includes(fileExtension)) return;
        if (linkUrl.hostname !== window.location.hostname) {
          event.preventDefault();
          external = linkUrl;
          events.push(["external_link", { ...pageInfo, external_link: external.href }]);
          if (link.target === "_blank") {
            window.open(link.href, "_blank");
          } else {
            window.location.href = link.href;
          }
        }
      };
      link.addEventListener("click", handler);
      attachedHandlers.links.push({ element: link, handler });
    });
  }

  function handleCustomEventElements() {
    if (attachedHandlers.custom) {
      attachedHandlers.custom.forEach(({ element, handler }) => {
        element.removeEventListener("click", handler);
      });
    }
    attachedHandlers.custom = [];

    document.querySelectorAll("[class*='floo-event-name=']").forEach((el) => {
      const match = el.className.match(/floo-event-name=([^\s]+)/);
      const eventName = match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : null;
      if (!eventName) return;

      const handler = () => {
        const props = {
          text: el.innerText || el.value || null,
          tag: el.tagName.toLowerCase(),
          url: el.href || window.location.href,
        };
        events.push([eventName, { ...pageInfo, ...props, timestamp: Date.now() }]);
        setTimeout(() => {
          sendAnalyticsBeacon({ events: events.slice() });
          events.length = 0;
        }, 0);
      };

      el.addEventListener("click", handler);
      attachedHandlers.custom.push({ element: el, handler });
    });
  }

  function initializeScrollDepth() {
    const { scrollHeight } = document.documentElement;
    const viewportHeight = window.innerHeight;
    maxScrollDepth = Math.min((viewportHeight / scrollHeight) * 100, 100);
  }

  function updateScrollDepth() {
    const { scrollHeight } = document.documentElement;
    const viewportHeight = window.innerHeight;
    const currentScrollDepth =
      scrollHeight === 0
        ? null
        : scrollHeight <= viewportHeight
          ? 100
          : (Math.min(window.scrollY + viewportHeight, scrollHeight) / scrollHeight) * 100;
    maxScrollDepth = Math.min(Math.max(maxScrollDepth, currentScrollDepth), 100);
  }

  // Guards against browsers that fire popstate on initial page load.
  var isFirstLoad = true;

  function historyBasedTracking() {
    if (!history) return;

    handleExternalLink();
    handleFormSubmit();
    handleCustomEventElements();
    initializeScrollDepth();

    const originalPushState = history.pushState;
    history.pushState = function (...args) {
      const result = originalPushState.apply(history, args);
      window.dispatchEvent(new Event("pushstate"));
      window.dispatchEvent(new Event("location-change"));
      return result;
    };

    window.addEventListener("popstate", () => {
      // Some browsers fire popstate on the initial page load — ignore it.
      if (isFirstLoad) {
        isFirstLoad = false;
        return;
      }
      window.dispatchEvent(new Event("location-change"));
    });

    window.addEventListener("location-change", () => {
      isFirstLoad = false;
      const timeSpent = getActiveTimeSpent();
      resetPageTimer();

      // Record page_view for the page the user is LEAVING.
      events.push([
        "page_view",
        {
          ...pageInfo,
          scroll_depth: maxScrollDepth,
          timestamp: Date.now(),
          time_spent: timeSpent,
          viewport_height: window.innerHeight,
          viewport_width: window.innerWidth,
        },
      ]);
      const eventsCopy = events.slice();
      events.length = 0;
      setTimeout(() => sendAnalyticsBeacon({ events: eventsCopy }), 0);

      initializeScrollDepth();
      // Update pageInfo to the new page.
      pageInfo = buildPageInfo();

      // Re-attach handlers so new DOM elements on the new route are covered.
      handleExternalLink();
      handleFormSubmit();
      handleCustomEventElements();
    });
  }

  // DOMContentLoaded: re-attach handlers and refresh pageInfo for traditional sites.
  // For SPAs this is a no-op since historyBasedTracking already handled it.
  if (document.readyState !== "loading") {
    handleExternalLink();
    handleFormSubmit();
    handleCustomEventElements();
  }

  document.addEventListener("DOMContentLoaded", function () {
    handleExternalLink();
    handleFormSubmit();
    handleCustomEventElements();
    pageInfo = buildPageInfo();
  });

  // Fires when the user leaves the page (traditional navigation or tab close).
  // Also fires on SPA page unload for the last page in the session.
  window.addEventListener("beforeunload", function () {
    const timeSpent = getActiveTimeSpent();
    events.push([
      "page_view",
      {
        ...pageInfo,
        scroll_depth: maxScrollDepth,
        timestamp: Date.now(),
        time_spent: timeSpent,
        viewport_height: window.innerHeight,
        viewport_width: window.innerWidth,
      },
    ]);
    sendAnalyticsBeacon({ events: events.slice() });
  });
})();
