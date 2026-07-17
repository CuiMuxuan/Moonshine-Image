export const BACKEND_ENVIRONMENT_ITEM_KEYS = Object.freeze([
  "python",
  "project",
  "venv",
  "dependencies",
]);

const FAILURE_ITEMS_BY_CODE = Object.freeze({
  INVALID_PROJECT_VENV: ["venv"],
  SYSTEM_PYTHON_UNSUPPORTED: ["python"],
});

const FAILURE_ITEMS_BY_STAGE = Object.freeze({
  initialization: ["project"],
  "sync-backend-mode": ["project"],
  "check-service-status": ["project"],
  "path-validation": ["project"],
  "check-project": ["project"],
  "prepare-project-python": ["python", "venv"],
  "check-dependencies": ["dependencies"],
});

const normalizeFailureStage = (failure = {}) =>
  String(failure.stage || failure.diagnostic?.stage || "").trim().toLowerCase();

const normalizeFailureCode = (failure = {}) =>
  String(failure.code || failure.diagnostic?.code || "").trim().toUpperCase();

export const mapEnvironmentFailureToItems = (
  failure = {},
  { completedItems = [], lifecycleStage = "" } = {}
) => {
  const completed = new Set(
    completedItems.filter((item) => BACKEND_ENVIRONMENT_ITEM_KEYS.includes(item))
  );
  const code = normalizeFailureCode(failure);
  const reportedStage = normalizeFailureStage(failure);
  const normalizedLifecycleStage = String(lifecycleStage || "").trim().toLowerCase();
  const failureCandidates =
    FAILURE_ITEMS_BY_CODE[code] ||
    FAILURE_ITEMS_BY_STAGE[normalizedLifecycleStage] ||
    FAILURE_ITEMS_BY_STAGE[reportedStage] ||
    ["project"];
  let failedItems = [...failureCandidates].filter((item) => !completed.has(item));
  if (failedItems.length === 0) {
    failedItems = BACKEND_ENVIRONMENT_ITEM_KEYS.filter(
      (item) => !completed.has(item)
    ).slice(0, 1);
  }
  const failed = new Set(failedItems);
  const blockedItems = BACKEND_ENVIRONMENT_ITEM_KEYS.filter(
    (item) => !completed.has(item) && !failed.has(item)
  );

  return {
    failedItems,
    blockedItems,
    states: Object.fromEntries(
      BACKEND_ENVIRONMENT_ITEM_KEYS.map((item) => [
        item,
        completed.has(item) ? "success" : failed.has(item) ? "failure" : "blocked",
      ])
    ),
  };
};

export const finalizeEnvironmentItemStates = (states = {}) =>
  Object.fromEntries(
    BACKEND_ENVIRONMENT_ITEM_KEYS.map((item) => {
      const state = states[item];
      return [item, ["success", "failure", "blocked"].includes(state) ? state : "blocked"];
    })
  );

export const resolveEnvironmentItemGroupState = (states = {}, itemKeys = []) => {
  const resolvedStates = Array.from(
    new Set(Array.isArray(itemKeys) ? itemKeys : [itemKeys])
  )
    .filter(Boolean)
    .map((item) => states[item] || "idle");

  if (resolvedStates.includes("checking")) return "checking";
  if (resolvedStates.includes("failure")) return "failure";
  if (resolvedStates.includes("blocked")) return "blocked";
  if (resolvedStates.length > 0 && resolvedStates.every((state) => state === "success")) {
    return "success";
  }
  return "idle";
};
