import { api } from "src/boot/axios";

const FALLBACK_IMAGE_MODELS = Object.freeze([
  {
    id: "lama",
    label: "Lama去除模型",
    description: "通用擦除与修复模型",
    installed: true,
    requiresMask: true,
    downloadable: false,
    sourceLinks: [],
  },
]);

const normalizeModel = (model = {}) => ({
  id: String(model.id || model.name || "").trim(),
  label: String(model.label || model.name || model.id || "").trim(),
  description: String(model.description || "").trim(),
  installed: model.installed !== false,
  requiresMask: model.requiresMask !== false,
  downloadable: Boolean(model.downloadable),
  sourceLinks: Array.isArray(model.sourceLinks) ? model.sourceLinks : [],
});

const getImageModels = async () => {
  try {
    const response = await api.get("/api/v1/moonshine/models", {
      params: { type: "image" },
    });
    const models = Array.isArray(response?.models)
      ? response.models.map(normalizeModel).filter((model) => model.id && model.installed)
      : [];

    return models.length > 0 ? models : [...FALLBACK_IMAGE_MODELS];
  } catch (error) {
    console.warn("Failed to load model list, using fallback list:", error);
    return [...FALLBACK_IMAGE_MODELS];
  }
};

export default {
  getImageModels,
};
