const body = document.body;
const header = document.querySelector("[data-header]");
const themeToggle = document.querySelector("[data-theme-toggle]");
const menuToggle = document.querySelector("[data-menu-toggle]");
const mobileNav = document.querySelector("[data-mobile-nav]");

const storedTheme = localStorage.getItem("moonshine-theme");
if (storedTheme === "dark" || (!storedTheme && window.matchMedia("(prefers-color-scheme: dark)").matches)) {
  body.classList.add("dark");
}

function updateThemeLabel() {
  const isDark = body.classList.contains("dark");
  themeToggle.setAttribute("aria-label", isDark ? "切换浅色模式" : "切换深色模式");
  themeToggle.setAttribute("title", isDark ? "切换浅色模式" : "切换深色模式");
  themeToggle.querySelector("span").textContent = isDark ? "☼" : "◐";
}

themeToggle.addEventListener("click", () => {
  body.classList.toggle("dark");
  localStorage.setItem("moonshine-theme", body.classList.contains("dark") ? "dark" : "light");
  updateThemeLabel();
});
updateThemeLabel();

menuToggle.addEventListener("click", () => {
  const isOpen = mobileNav.classList.toggle("is-open");
  menuToggle.setAttribute("aria-expanded", String(isOpen));
  menuToggle.querySelector("span").textContent = isOpen ? "×" : "☰";
});
mobileNav.querySelectorAll("a").forEach((link) => link.addEventListener("click", () => {
  mobileNav.classList.remove("is-open");
  menuToggle.setAttribute("aria-expanded", "false");
  menuToggle.querySelector("span").textContent = "☰";
}));

const observer = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add("is-visible");
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });
document.querySelectorAll(".reveal").forEach((element) => observer.observe(element));

window.addEventListener("scroll", () => header.classList.toggle("is-scrolled", window.scrollY > 8), { passive: true });

const workflows = {
  image: {
    image: "assets/image-processing.png",
    alt: "图片处理流程预览",
    label: "图片处理工作台",
    steps: [
      ["上传处理源", "选择一张或多张图片。"],
      ["制作或组合蒙版", "手绘、OCR、点选或框选，按你的需要组合。"],
      ["调用模型处理", "选择适合当前素材的处理方式。"],
      ["预览并导出", "确认结果，导出一份全新的文件。"],
    ],
  },
  video: {
    image: "assets/video-processing.png",
    alt: "视频处理流程预览",
    label: "视频时间轴工作台",
    steps: [
      ["导入视频并建立时间轴", "选择视频，定位到需要处理的时间段。"],
      ["建立蒙版轨道", "手绘蒙版，或使用智能传播和关键帧。"],
      ["试跑并处理", "先预览一小段，再处理完整区间。"],
      ["导出并确认结果", "分段导出，完成后打开保存目录。"],
    ],
  },
};

const workflowImage = document.querySelector("[data-workflow-preview] img");
const workflowLabel = document.querySelector("[data-preview-label]");
const workflowSteps = document.querySelector("[data-workflow-steps]");
const workflowPreview = document.querySelector("[data-workflow-preview]");

function renderWorkflow(kind) {
  const flow = workflows[kind];
  workflowPreview.classList.add("is-switching");
  window.setTimeout(() => {
    workflowImage.src = flow.image;
    workflowImage.alt = flow.alt;
    workflowLabel.textContent = flow.label;
    workflowSteps.innerHTML = flow.steps.map((step, index) => `
      <div class="workflow-step${index === 0 ? " is-active" : ""}" tabindex="0">
        <span>0${index + 1}</span><div><strong>${step[0]}</strong><p>${step[1]}</p></div>
      </div>`).join("");
    workflowPreview.classList.remove("is-switching");
    bindStepSelection();
  }, 150);
}

function bindStepSelection() {
  workflowSteps.querySelectorAll(".workflow-step").forEach((step) => {
    const activate = () => {
      workflowSteps.querySelectorAll(".workflow-step").forEach((item) => item.classList.remove("is-active"));
      step.classList.add("is-active");
    };
    step.addEventListener("click", activate);
    step.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); activate(); }
    });
  });
}
bindStepSelection();

document.querySelectorAll("[data-flow]").forEach((tab) => tab.addEventListener("click", () => {
  document.querySelectorAll("[data-flow]").forEach((item) => {
    const active = item === tab;
    item.classList.toggle("is-active", active);
    item.setAttribute("aria-selected", String(active));
  });
  renderWorkflow(tab.dataset.flow);
}));
