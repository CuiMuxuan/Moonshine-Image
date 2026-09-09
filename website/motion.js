// Progressive enhancement: content is always visible without animation support.
(() => {
  const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (preference.matches || window.location.hash) return;
  if (!("IntersectionObserver" in window) || !Element.prototype.animate) return;
  const running = new Map();
  const tokens = getComputedStyle(document.documentElement);
  const duration = parseFloat(tokens.getPropertyValue("--motion-enter")) || 500;
  const easing = tokens.getPropertyValue("--ease-out").trim() || "ease-out";
  const selectors =
    ".section-heading, .feature-card, .workspace-panel, .mask-flow, .model-row, .download-option, .docs-inner";
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        if (preference.matches || entry.target.contains(document.activeElement))
          continue;
        const siblings = [...entry.target.parentElement.children];
        const delay = entry.target.matches(".feature-card, .download-option")
          ? (siblings.indexOf(entry.target) % 3) * 50
          : 0;
        const animation = entry.target.animate(
          [
            { opacity: 0.35, transform: "translateY(16px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration, delay, easing, fill: "backwards" },
        );
        running.set(entry.target, animation);
        animation.finished
          .then(() => running.delete(entry.target))
          .catch(() => {});
      }
    },
    { threshold: 0.08 },
  );
  for (const element of document.querySelectorAll(selectors)) {
    // Never animate initial content or a restored/deep-linked reading position.
    if (element.getBoundingClientRect().top >= window.innerHeight)
      observer.observe(element);
  }
  function finishMotion() {
    for (const animation of running.values()) animation.cancel();
    running.clear();
  }
  preference.addEventListener("change", () => {
    if (preference.matches) {
      observer.disconnect();
      finishMotion();
    }
  });
  document.addEventListener("focusin", (event) => {
    for (const [element, animation] of running) {
      if (element.contains(event.target)) {
        animation.cancel();
        running.delete(element);
      }
    }
  });
  // Keyboard and anchor navigation must land on still, immediately readable content.
  document.addEventListener("keydown", (event) => {
    if (
      ["Tab", "Enter", " ", "Home", "End", "PageDown", "PageUp"].includes(
        event.key,
      )
    ) {
      observer.disconnect();
      finishMotion();
    }
  });
  window.addEventListener("hashchange", () => {
    observer.disconnect();
    finishMotion();
  });
  window.addEventListener("pagehide", () => {
    observer.disconnect();
    finishMotion();
  });
})();
