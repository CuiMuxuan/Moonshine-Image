import { api } from "src/boot/axios";

const FALLBACK_IMAGE_MODELS = Object.freeze([
  {
    id: "lama",
    label: "Lama去除模型",
    description: "通用擦除与修复模型",
    type: "image",
    installed: true,
    verified: true,
    available: true,
    loaded: false,
    loadState: "not_loaded",
    runtimeReady: false,
    ready: false,
    readiness: { status: "not_loaded", reason: "not_loaded" },
    requiresMask: true,
    downloadable: false,
    sourceLinks: [],
    manualSources: [],
    manualHint: "",
    license: {},
    runCapabilities: {
      scopes: ["selected", "folder"],
      folderInputs: ["imageFolder", "maskFolder"],
      batchActions: ["deleteSelected", "applyCurrentMaskToSelected"],
      outputRequired: true,
    },
    parameters: {},
    parameterHelp: "当前模型参数由服务自动控制，无需手动调整。",
    capabilities: {
      speed: 6.0,
      realImageQuality: 8.0,
      cartoonImageQuality: 6.0,
      simpleSceneQuality: 8.0,
      complexSceneQuality: 6.0,
      textWatermarkAbility: 6.0,
      lowVramFriendly: 6.0,
      stability: 8.0,
    },
  },
]);

const normalizeModel = (model = {}) => ({
  id: String(model.id || model.name || "").trim(),
  label: String(model.label || model.name || model.id || "").trim(),
  description: String(model.description || "").trim(),
  type: String(model.type || "image").trim(),
  family: String(model.family || "").trim(),
  familyLabel: String(model.familyLabel || "").trim(),
  modelVersion: String(model.modelVersion || "").trim(),
  variant: String(model.variant || "").trim(),
  category: String(model.category || "").trim(),
  installed: Boolean(model.installed),
  verified: model.verified == null ? Boolean(model.installed) : Boolean(model.verified),
  available: model.available !== false && Boolean(model.installed),
  loaded: Boolean(model.loaded),
  loadState: String(model.loadState || (model.loaded ? "loaded" : "not_loaded")),
  runtimeReady: Boolean(model.runtimeReady ?? model.ready),
  ready: Boolean(model.ready ?? model.runtimeReady),
  readiness:
    model.readiness && typeof model.readiness === "object"
      ? model.readiness
      : {
          status: model.loaded ? "ready" : "not_loaded",
          reason: model.loaded ? null : "not_loaded",
        },
  fileStatus: String(model.fileStatus || (model.installed ? "verified" : "missing")),
  requiresMask: model.requiresMask !== false,
  downloadable: Boolean(model.downloadable),
  sourceLinks: Array.isArray(model.sourceLinks) ? model.sourceLinks : [],
  manualSources: Array.isArray(model.manualSources) ? model.manualSources : [],
  manualHint: String(model.manualHint || "").trim(),
  license: model.license && typeof model.license === "object" ? model.license : {},
  files: Array.isArray(model.files)
    ? model.files.map((file = {}) => ({
      ...file,
      legacyPaths: Array.isArray(file.legacyPaths) ? file.legacyPaths : [],
      legacyExists: Boolean(file.legacyExists),
      legacyDetected: Boolean(file.legacyDetected),
      legacyPathUsed: String(file.legacyPathUsed || ""),
      resolvedPathKind: String(file.resolvedPathKind || ""),
      migrationTarget: String(file.migrationTarget || ""),
      canonicalPath: String(file.canonicalPath || ""),
    }))
    : [],
  missingFiles: Array.isArray(model.missingFiles) ? model.missingFiles : [],
  corruptFiles: Array.isArray(model.corruptFiles) ? model.corruptFiles : [],
  deviceCompatible: model.deviceCompatible !== false,
  recommendedDevice: model.recommendedDevice || "",
  minimumVram: model.minimumVram || null,
  recommendedVram: model.recommendedVram || model.minimumVram || null,
  recommendedVramWarning:
    model.recommendedVramWarning && typeof model.recommendedVramWarning === "object"
      ? model.recommendedVramWarning
      : null,
  size: model.size || null,
  sha256: model.sha256 || "",
  runCapabilities:
    model.runCapabilities && typeof model.runCapabilities === "object"
      ? model.runCapabilities
      : {},
  officialCapabilities:
    model.officialCapabilities && typeof model.officialCapabilities === "object"
      ? model.officialCapabilities
      : {},
  enabledCapabilities:
    model.enabledCapabilities && typeof model.enabledCapabilities === "object"
      ? model.enabledCapabilities
      : {},
  capabilityNotes:
    model.capabilityNotes && typeof model.capabilityNotes === "object"
      ? model.capabilityNotes
      : {},
  parameters: model.parameters && typeof model.parameters === "object" ? model.parameters : {},
  parameterHelp: String(model.parameterHelp || "").trim(),
  capabilities: model.capabilities && typeof model.capabilities === "object"
    ? model.capabilities
    : {},
});

const buildModelDirectoryPayload = (options = {}) => {
  const modelDir = String(options.modelDir || "").trim();
  const acceptance = options.licenseAcceptance;
  return {
    ...(modelDir ? { model_dir: modelDir, modelDir } : {}),
    ...(acceptance?.accepted
      ? {
          license_accepted: true,
          license_acceptance_id: String(acceptance.acceptanceId || "").trim(),
        }
      : {}),
  };
};

const getModels = async (options = {}) => {
  try {
    const directoryPayload = buildModelDirectoryPayload(options);
    const response = await api.get(
      "/api/v1/moonshine/models",
      directoryPayload.model_dir ? { model_dir: directoryPayload.model_dir } : {}
    );
    const models = Array.isArray(response?.models)
      ? response.models.map(normalizeModel).filter((model) => model.id)
      : [];

    return {
      currentModel: response?.currentModel || "lama",
      modelDir: response?.modelDir || "",
      cuda: response?.cuda || {},
      runtime: response?.runtime || {},
      modelManifest: response?.modelManifest || {},
      models: models.length > 0 ? models : [...FALLBACK_IMAGE_MODELS],
      usingFallback: models.length === 0,
    };
  } catch (error) {
    console.warn("Failed to load model list, using fallback list:", error);
    return {
      currentModel: "lama",
      modelDir: "",
      cuda: {},
      runtime: {},
      modelManifest: {},
      models: [...FALLBACK_IMAGE_MODELS],
      usingFallback: true,
      error,
    };
  }
};

const getImageModels = async ({ installedOnly = true, ...options } = {}) => {
  const registry = await getModels(options);
  const imageModels = registry.models.filter((model) => model.type === "image");
  return installedOnly ? imageModels.filter((model) => model.installed) : imageModels;
};

const refreshModels = async (options = {}) => {
  const response = await api.post(
    "/api/v1/moonshine/models/refresh",
    buildModelDirectoryPayload(options)
  );
  const models = Array.isArray(response?.models)
    ? response.models.map(normalizeModel).filter((model) => model.id)
    : [];
  return {
    currentModel: response?.currentModel || "lama",
    modelDir: response?.modelDir || "",
    cuda: response?.cuda || {},
    runtime: response?.runtime || {},
    modelManifest: response?.modelManifest || {},
    models,
  };
};

const verifyModel = async (modelId, options = {}) => {
  const response = await api.post(
    `/api/v1/moonshine/models/${encodeURIComponent(modelId)}/verify`,
    buildModelDirectoryPayload(options)
  );
  return {
    ...response,
    model: normalizeModel(response?.model || {}),
  };
};

const switchModel = async (modelId) => {
  const normalizedModelId = String(modelId || "").trim() || "lama";
  const response = await api.post("/api/v1/model", { name: normalizedModelId });
  return {
    currentModel: response?.name || normalizedModelId,
    model: response,
  };
};

const startModelDownload = async (modelId, options = {}) => (
  api.post(
    `/api/v1/moonshine/models/${encodeURIComponent(modelId)}/download`,
    buildModelDirectoryPayload(options)
  )
);

const getModelTask = async (taskId) => (
  api.get(`/api/v1/moonshine/models/tasks/${encodeURIComponent(taskId)}`)
);

const prepareModel = async (modelId, options = {}) => {
  const response = await api.post(
    `/api/v1/moonshine/models/${encodeURIComponent(modelId)}/prepare`,
    buildModelDirectoryPayload(options)
  );
  return {
    ...response,
    loaded: Boolean(response?.loaded),
    runtimeReady: Boolean(response?.runtimeReady ?? response?.ready),
    ready: Boolean(response?.ready ?? response?.runtimeReady),
    loadState: String(response?.loadState || (response?.loaded ? "loaded" : "failed")),
    readiness: response?.readiness || {
      status: response?.loaded ? "ready" : "failed",
      reason: response?.loaded ? null : "load_failed",
    },
  };
};

export default {
  getModels,
  getImageModels,
  refreshModels,
  verifyModel,
  switchModel,
  startModelDownload,
  getModelTask,
  prepareModel,
};
