import { defineStore } from "pinia";
import { computed, ref } from "vue";

import ModelRegistryService from "src/services/ModelRegistryService";
import { useConfigStore } from "src/stores/config";

const POLL_INTERVAL_MS = 900;

export const useModelRegistryStore = defineStore("modelRegistry", () => {
  const configStore = useConfigStore();
  const models = ref([]);
  const currentModel = ref("lama");
  const modelDir = ref("");
  const cuda = ref({});
  const runtime = ref({});
  const loading = ref(false);
  const error = ref("");
  const usingFallback = ref(false);
  const tasks = ref({});
  const pollTimers = new Map();

  const imageModels = computed(() => models.value.filter((model) => model.type === "image"));
  const installedImageModels = computed(() =>
    imageModels.value.filter((model) => model.installed)
  );
  const maskModels = computed(() => models.value.filter((model) => model.type === "mask"));
  const installedMaskModels = computed(() =>
    maskModels.value.filter((model) => model.installed)
  );

  const setRegistryPayload = (payload = {}) => {
    models.value = Array.isArray(payload.models) ? payload.models : [];
    currentModel.value = payload.currentModel || currentModel.value || "lama";
    modelDir.value = payload.modelDir || "";
    cuda.value = payload.cuda || {};
    runtime.value = payload.runtime || {};
    usingFallback.value = Boolean(payload.usingFallback);
    error.value = payload.error?.message || "";
  };

  const withConfiguredModelDir = (options = {}) => {
    if (options.modelDir) return options;
    const generalConfig = configStore.config?.general || {};
    return {
      ...options,
      modelDir: generalConfig.modelDir || "",
    };
  };

  const loadModels = async (options = {}) => {
    loading.value = true;
    try {
      const payload = await ModelRegistryService.getModels(withConfiguredModelDir(options));
      setRegistryPayload(payload);
      return payload;
    } catch (loadError) {
      error.value = loadError.message || "模型列表加载失败";
      throw loadError;
    } finally {
      loading.value = false;
    }
  };

  const refreshModels = async (options = {}) => {
    loading.value = true;
    try {
      const payload = await ModelRegistryService.refreshModels(withConfiguredModelDir(options));
      setRegistryPayload(payload);
      return payload;
    } catch (refreshError) {
      error.value = refreshError.message || "模型状态刷新失败";
      throw refreshError;
    } finally {
      loading.value = false;
    }
  };

  const verifyModel = async (modelId, options = {}) => {
    const response = await ModelRegistryService.verifyModel(
      modelId,
      withConfiguredModelDir(options)
    );
    if (response?.model?.id) {
      models.value = models.value.map((model) =>
        model.id === response.model.id ? response.model : model
      );
    }
    return response;
  };

  const switchModel = async (modelId) => {
    const response = await ModelRegistryService.switchModel(modelId);
    currentModel.value = response?.currentModel || modelId || currentModel.value || "lama";
    return response;
  };

  const clearPollTimer = (taskId) => {
    const timer = pollTimers.get(taskId);
    if (timer) {
      window.clearTimeout(timer);
      pollTimers.delete(taskId);
    }
  };

  const pollTask = async (taskId) => {
    try {
      const task = await ModelRegistryService.getModelTask(taskId);
      tasks.value = {
        ...tasks.value,
        [taskId]: task,
      };

      if (task?.done) {
        clearPollTimer(taskId);
        await refreshModels();
        return task;
      }

      clearPollTimer(taskId);
      pollTimers.set(
        taskId,
        window.setTimeout(() => {
          void pollTask(taskId);
        }, POLL_INTERVAL_MS)
      );
      return task;
    } catch (pollError) {
      clearPollTimer(taskId);
      tasks.value = {
        ...tasks.value,
        [taskId]: {
          id: taskId,
          status: "failed",
          done: true,
          error: pollError.message || "下载任务状态获取失败",
        },
      };
      throw pollError;
    }
  };

  const startDownload = async (modelId, options = {}) => {
    const response = await ModelRegistryService.startModelDownload(
      modelId,
      withConfiguredModelDir(options)
    );
    const task = response?.task;
    if (!task?.id) {
      throw new Error("下载任务创建失败");
    }
    tasks.value = {
      ...tasks.value,
      [task.id]: task,
    };
    void pollTask(task.id);
    return task;
  };

  const getTaskForModel = (modelId) => {
    const taskList = Object.values(tasks.value || {});
    return taskList
      .filter((task) => task?.modelId === modelId)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0] || null;
  };

  return {
    models,
    currentModel,
    modelDir,
    cuda,
    runtime,
    loading,
    error,
    usingFallback,
    tasks,
    imageModels,
    installedImageModels,
    maskModels,
    installedMaskModels,
    loadModels,
    refreshModels,
    verifyModel,
    switchModel,
    startDownload,
    pollTask,
    getTaskForModel,
  };
});
