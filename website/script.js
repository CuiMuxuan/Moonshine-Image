const body = document.body;
const themeToggle = document.querySelector("[data-theme-toggle]");
const menuToggle = document.querySelector("[data-menu-toggle]");
const mobileNav = document.querySelector("[data-mobile-nav]");

let storedTheme;
try {
  storedTheme = localStorage.getItem("moonshine-theme");
} catch {
  /* Storage can be disabled. */
}
if (
  storedTheme === "dark" ||
  (!storedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches)
) {
  body.classList.add("dark");
}

function updateThemeLabel() {
  const isDark = body.classList.contains("dark");
  themeToggle.setAttribute(
    "aria-label",
    isDark ? "切换浅色模式" : "切换深色模式",
  );
  themeToggle.setAttribute("title", isDark ? "切换浅色模式" : "切换深色模式");
  themeToggle.innerHTML = `<i data-lucide="${isDark ? "sun" : "moon"}"></i>`;
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}

themeToggle.addEventListener("click", () => {
  body.classList.toggle("dark");
  try {
    localStorage.setItem(
      "moonshine-theme",
      body.classList.contains("dark") ? "dark" : "light",
    );
  } catch {
    /* Theme still works without persistence. */
  }
  updateThemeLabel();
});
updateThemeLabel();

function setMenuOpen(isOpen) {
  mobileNav.hidden = !isOpen;
  menuToggle.setAttribute("aria-expanded", String(isOpen));
  const label = isOpen ? "关闭菜单" : "打开菜单";
  menuToggle.setAttribute("aria-label", label);
  menuToggle.title = label;
  menuToggle.innerHTML = `<i data-lucide="${isOpen ? "x" : "menu"}"></i>`;
  window.lucide?.createIcons({ attrs: { "aria-hidden": "true" } });
}
menuToggle.addEventListener("click", () => setMenuOpen(mobileNav.hidden));
mobileNav
  .querySelectorAll("a")
  .forEach((link) => link.addEventListener("click", () => setMenuOpen(false)));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !mobileNav.hidden) {
    setMenuOpen(false);
    menuToggle.focus();
  }
});
window.matchMedia("(min-width: 801px)").addEventListener("change", (event) => {
  if (event.matches) setMenuOpen(false);
});

const workflows = {
  image: {
    image: "assets/image-processing.png",
    alt: "图片处理流程预览",
    label: "图片处理工作台",
    source: "导入图片",
    smart: "OCR / SAM 智能选区",
    result: "调用模型 · 导出新文件",
  },
  video: {
    image: "assets/video-processing.png",
    alt: "视频处理流程预览",
    label: "视频时间轴工作台",
    source: "导入视频 / 建立时间轴",
    smart: "SAM 传播 / 关键帧",
    result: "预览试跑 · 分段处理 · 导出视频",
  },
};

const workflowImage = document.querySelector("[data-workspace-image]");
const workflowLabel = document.querySelector("[data-preview-label]");
const workflowPanel = document.querySelector("#workspace-panel");
const workflowTabs = Array.from(document.querySelectorAll("[data-flow]"));

function renderWorkflow(kind) {
  const flow = workflows[kind];
  if (!flow) return;
  workflowImage.src = flow.image;
  workflowImage.alt = flow.alt;
  workflowLabel.textContent = flow.label;
  workflowPanel.setAttribute("aria-labelledby", `tab-${kind}`);
  document.querySelector("[data-flow-source]").textContent = flow.source;
  document.querySelector("[data-flow-smart]").textContent = flow.smart;
  document.querySelector("[data-flow-result]").textContent = flow.result;
  workflowTabs.forEach((tab) => {
    const active = tab.dataset.flow === kind;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
}

workflowTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => renderWorkflow(tab.dataset.flow));
  tab.addEventListener("keydown", (event) => {
    const destinations = {
      ArrowRight: (index + 1) % workflowTabs.length,
      ArrowLeft: (index + workflowTabs.length - 1) % workflowTabs.length,
      Home: 0,
      End: workflowTabs.length - 1,
    };
    if (!(event.key in destinations)) return;
    event.preventDefault();
    const next = workflowTabs[destinations[event.key]];
    renderWorkflow(next.dataset.flow);
    next.focus();
  });
});

const imageDialog = document.querySelector(".image-dialog");
document.querySelector("[data-preview-open]").addEventListener("click", () => {
  const image = imageDialog.querySelector("img");
  image.src = workflowImage.src;
  image.alt = workflowImage.alt;
  imageDialog.showModal();
});
imageDialog.addEventListener("click", (event) => {
  if (event.target !== imageDialog) return;
  const bounds = imageDialog.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    imageDialog.close();
});
