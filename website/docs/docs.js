(function () {
  "use strict";

  var body = document.body;
  var root = document.documentElement;
  var storageKey = "moonshine-theme";

  function icon(name) {
    var node = document.createElement("i");
    node.setAttribute("data-lucide", name);
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function renderIcons() {
    window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
  }

  function readStoredTheme() {
    try {
      return window.localStorage.getItem(storageKey);
    } catch (error) {
      return null;
    }
  }

  function writeStoredTheme(value) {
    try {
      window.localStorage.setItem(storageKey, value);
    } catch (error) {
      // Private browsing and storage restrictions should not break the docs reader.
    }
  }

  function prefersDark() {
    return (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches
    );
  }

  function setTheme(theme, persist) {
    var isDark = theme === "dark";
    body.classList.toggle("dark", isDark);
    root.dataset.theme = isDark ? "dark" : "light";
    if (persist) writeStoredTheme(isDark ? "dark" : "light");

    document.querySelectorAll("[data-theme-toggle]").forEach(function (toggle) {
      var label = isDark ? "切换浅色模式" : "切换深色模式";
      toggle.setAttribute("aria-label", label);
      toggle.setAttribute("title", label);
      toggle.setAttribute("aria-pressed", String(isDark));
      var labelNode = toggle.querySelector("[data-theme-label]");
      if (labelNode) labelNode.textContent = label;
      toggle.replaceChildren(icon(isDark ? "sun" : "moon"));
    });
    renderIcons();
  }

  var storedTheme = readStoredTheme();
  setTheme(
    storedTheme === "dark" || (!storedTheme && prefersDark())
      ? "dark"
      : "light",
    false,
  );

  document.querySelectorAll("[data-theme-toggle]").forEach(function (toggle) {
    toggle.addEventListener("click", function () {
      setTheme(body.classList.contains("dark") ? "light" : "dark", true);
    });
  });

  window.addEventListener("storage", function (event) {
    if (
      event.key === storageKey &&
      (event.newValue === "dark" || event.newValue === "light")
    ) {
      setTheme(event.newValue, false);
    }
  });

  var menuButton =
    document.querySelector("[data-doc-menu]") ||
    document.querySelector(".docs-menu-button");
  var sidebar =
    document.querySelector("[data-doc-sidebar]") ||
    document.querySelector(".docs-sidebar");
  var backdrop =
    document.querySelector("[data-doc-backdrop]") ||
    document.querySelector(".docs-nav-backdrop");
  var menuOpen = false;
  var narrowScreen = window.matchMedia("(max-width: 980px)");
  var readingSurface = document.querySelector(".docs-main");
  var footer = document.querySelector(".docs-footer");

  if (sidebar) {
    var filter = document.createElement("input");
    filter.type = "search";
    filter.placeholder = "筛选目录";
    filter.setAttribute("aria-label", "筛选文档目录");
    filter.className = "docs-filter";
    var searchLabel = document.createElement("label");
    searchLabel.className = "docs-filter-wrap";
    searchLabel.append(icon("search"), filter);
    var searchStatus = document.createElement("p");
    searchStatus.className = "docs-filter-status";
    searchStatus.setAttribute("role", "status");
    var navigation = sidebar.querySelector("nav");
    if (navigation) {
      navigation.before(searchLabel, searchStatus);
      filter.addEventListener("input", function () {
        var query = filter.value.trim().toLocaleLowerCase();
        var count = 0;
        navigation.querySelectorAll("a").forEach(function (link) {
          var group = link.closest(".docs-nav-group");
          var text =
            link.textContent +
            " " +
            (group?.querySelector("p")?.textContent || "");
          link.hidden = Boolean(
            query && !text.toLocaleLowerCase().includes(query),
          );
          if (!link.hidden) count++;
        });
        navigation
          .querySelectorAll(".docs-nav-group")
          .forEach(function (group) {
            group.hidden = !Array.from(group.querySelectorAll("a")).some(
              function (link) {
                return !link.hidden;
              },
            );
          });
        searchStatus.textContent = query
          ? count
            ? count + " 个匹配章节"
            : "没有匹配的章节"
          : "";
      });
    }
  }

  if (sidebar && !backdrop) {
    backdrop = document.createElement("button");
    backdrop.type = "button";
    backdrop.className = "docs-nav-backdrop";
    backdrop.setAttribute("aria-label", "关闭文档目录");
    backdrop.hidden = true;
    document.body.appendChild(backdrop);
  }

  function setMenu(open) {
    var wasOpen = menuOpen;
    menuOpen = Boolean(open && sidebar && narrowScreen.matches);
    if (sidebar) {
      sidebar.classList.toggle("is-open", menuOpen);
      sidebar.inert = narrowScreen.matches && !menuOpen;
    }
    if (readingSurface) readingSurface.inert = menuOpen;
    if (footer) footer.inert = menuOpen;
    body.classList.toggle("docs-nav-open", menuOpen);
    if (menuButton) {
      menuButton.setAttribute("aria-expanded", String(menuOpen));
      menuButton.setAttribute(
        "aria-label",
        menuOpen ? "关闭文档目录" : "打开文档目录",
      );
      menuButton.setAttribute(
        "title",
        menuOpen ? "关闭文档目录" : "打开文档目录",
      );
      menuButton.replaceChildren(icon(menuOpen ? "x" : "menu"));
    }
    if (backdrop) {
      backdrop.hidden = !menuOpen;
      backdrop.classList.toggle("is-visible", menuOpen);
    }
    renderIcons();
    if (menuOpen && filter) filter.focus({ preventScroll: true });
    else if (wasOpen && narrowScreen.matches && menuButton)
      menuButton.focus({ preventScroll: true });
  }

  setMenu(false);
  narrowScreen.addEventListener("change", function () {
    setMenu(false);
  });
  if (menuButton && sidebar)
    menuButton.addEventListener("click", function (event) {
      body.classList.toggle("docs-nav-keyboard", event.detail === 0);
      setMenu(!menuOpen);
    });
  if (backdrop)
    backdrop.addEventListener("click", function () {
      setMenu(false);
    });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && menuOpen) {
      setMenu(false);
      if (menuButton) menuButton.focus();
    }
    if (event.key === "Tab" && menuOpen) {
      var focusable = [menuButton]
        .concat(Array.from(sidebar.querySelectorAll("input, a[href]")))
        .filter(function (element) {
          return (
            element &&
            element.getClientRects().length &&
            !element.closest("[hidden]")
          );
        });
      var first = focusable[0];
      var last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  if (sidebar) {
    sidebar.querySelectorAll("a").forEach(function (link) {
      link.addEventListener("click", function () {
        var wasOpen = menuOpen;
        setMenu(false);
        if (wasOpen && menuButton) menuButton.focus({ preventScroll: true });
      });
    });
  }

  var header =
    document.querySelector("[data-doc-header]") ||
    document.querySelector(".docs-header");
  function updateHeader() {
    if (header) header.classList.toggle("is-scrolled", window.scrollY > 8);
  }
  updateHeader();
  window.addEventListener("scroll", updateHeader, { passive: true });

  function normalisePath(path) {
    var value = (path || "").split("#")[0].split("?")[0];
    value = value.replace(/\\/g, "/").replace(/index\.html$/i, "");
    if (!value.endsWith("/")) value += "/";
    return value;
  }

  var currentPath = normalisePath(window.location.pathname);
  var sidebarLinks = Array.from(
    document.querySelectorAll(".docs-sidebar a[href]"),
  );
  var authoredCurrentLink = sidebarLinks.some(function (link) {
    return link.matches(".is-active, [aria-current='page']");
  });
  if (!authoredCurrentLink) {
    var currentLink = sidebarLinks.find(function (link) {
      var href = link.getAttribute("href");
      if (!href || href.charAt(0) === "#" || href.indexOf("javascript:") === 0)
        return false;
      try {
        var resolved = new URL(href, window.location.href);
        return (
          !resolved.hash && normalisePath(resolved.pathname) === currentPath
        );
      } catch (error) {
        return false;
      }
    });
    if (currentLink) {
      currentLink.classList.add("is-active");
      currentLink.setAttribute("aria-current", "page");
    }
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      try {
        var copied = document.execCommand("copy");
        document.body.removeChild(textarea);
        if (copied) resolve();
        else reject(new Error("Copy command failed"));
      } catch (error) {
        document.body.removeChild(textarea);
        reject(error);
      }
    });
  }

  function targetForCopy(button) {
    var target = button.getAttribute("data-copy-target");
    var value = button.getAttribute("data-copy");
    if (
      !target &&
      value &&
      value !== "true" &&
      value !== "" &&
      value.charAt(0) === "#"
    )
      target = value;
    if (target) {
      try {
        var targetNode = document.querySelector(target);
        if (targetNode) return targetNode;
      } catch (error) {
        // An invalid selector can fall through to the nearest code block.
      }
    }
    return (
      button
        .closest(".doc-code, .code-block, .code-sample, .code-panel, pre")
        ?.querySelector("pre code, pre, code") || button.closest("pre")
    );
  }

  function copyLabel(button, copied) {
    if (!button.dataset.originalLabel)
      button.dataset.originalLabel =
        button.getAttribute("aria-label") || "复制代码";
    var label = copied ? "已复制" : button.dataset.originalLabel;
    button.setAttribute("aria-label", label);
    button.title = label;
    button.replaceChildren(icon(copied ? "check" : "copy"));
    renderIcons();
  }

  document
    .querySelectorAll("[data-copy], .copy-button")
    .forEach(function (button) {
      copyLabel(button, false);
      if (button.tagName !== "BUTTON") button.setAttribute("role", "button");
      button.addEventListener("click", function () {
        var target = targetForCopy(button);
        var text = target
          ? target.textContent
          : button.getAttribute("data-copy-text");
        if (!text) return;
        copyText(text.trim())
          .then(function () {
            button.classList.add("is-copied");
            button.setAttribute("aria-live", "polite");
            copyLabel(button, true);
            window.setTimeout(function () {
              button.classList.remove("is-copied");
              copyLabel(button, false);
            }, 1600);
          })
          .catch(function () {
            button.setAttribute("title", "无法自动复制，请手动选择代码");
          });
      });
    });

  var tocLinks = Array.from(
    document.querySelectorAll(
      ".docs-toc a[href^='#'], [data-doc-toc] a[href^='#']",
    ),
  );
  var sections = tocLinks
    .map(function (link) {
      var id = link.getAttribute("href").slice(1);
      return document.getElementById(id);
    })
    .filter(Boolean);
  if (!sections.length) {
    sections = Array.from(
      document.querySelectorAll("[data-section][id], .docs-section[id]"),
    );
    tocLinks = Array.from(
      document.querySelectorAll(
        ".docs-toc a[href^='#'], [data-doc-toc] a[href^='#']",
      ),
    );
  }

  function setActiveSection(id) {
    if (!id) return;
    tocLinks.forEach(function (link) {
      var active = link.getAttribute("href").slice(1) === id;
      link.classList.toggle("is-active", active);
      if (active) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
    sections.forEach(function (section) {
      section.classList.toggle("is-current", section.id === id);
    });
  }

  if (sections.length && "IntersectionObserver" in window) {
    var sectionObserver = new IntersectionObserver(
      function (entries) {
        var visible = entries.filter(function (entry) {
          return entry.isIntersecting;
        });
        if (visible.length) {
          visible.sort(function (a, b) {
            return a.boundingClientRect.top - b.boundingClientRect.top;
          });
          setActiveSection(visible[0].target.id);
        }
      },
      { rootMargin: "-16% 0px -68% 0px", threshold: [0, 0.1, 0.5, 1] },
    );
    sections.forEach(function (section) {
      sectionObserver.observe(section);
    });

    tocLinks.forEach(function (link) {
      link.addEventListener("click", function () {
        setActiveSection(link.getAttribute("href").slice(1));
        setMenu(false);
      });
    });
    var initialId = window.location.hash
      ? window.location.hash.slice(1)
      : sections[0].id;
    if (document.getElementById(initialId)) setActiveSection(initialId);
  }

  if (window.matchMedia) {
    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    reduceMotion.addEventListener?.("change", function () {
      document.documentElement.classList.toggle(
        "reduce-motion",
        reduceMotion.matches,
      );
    });
  }
})();
