import { defineStore } from "pinia";
import { computed, ref } from "vue";

import ModelRegistryService from "src/services/ModelRegistryService";
import { useConfigStore } from "src/stores/config";

const POLL_INTERVAL_MS = 900;
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed"]);

const createAbortError = () => {
  const error = new Error("模型准备已取消");
  error.name = "AbortError";
  return error;
};

const normalizePreparationProgress = (value, fallback = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
};

export const useModelRegistryStore = defineStore("modelRegistry", () => {
  const configStore = useConfigStore();
  const models = ref([]);
  const currentModel = ref("lama");
  const modelDir = ref("");
  const cuda = ref({});
  const runtime = ref({});
  const modelManifest = ref({});
  const loading = ref(false);
  const error = ref("");
  const usingFallback = ref(false);
  const tasks = ref({});
  const preparations = ref({});
  const pollTimers = new Map();
  const preparationJobs = new Map();

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
    modelManifest.value = payload.modelManifest || {};
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
    const { poll = true, ...requestOptions } = options;
    const response = await ModelRegistryService.startModelDownload(
      modelId,
      withConfiguredModelDir(requestOptions)
    );
    const task = response?.task;
    if (!task?.id) {
      throw new Error("下载任务创建失败");
    }
    tasks.value = {
      ...tasks.value,
      [task.id]: task,
    };
    if (poll) void pollTask(task.id);
    return task;
  };

  const waitForDownloadTask = async (taskId, onTask) => {
    while (true) {
      const task = await ModelRegistryService.getModelTask(taskId);
      tasks.value = { ...tasks.value, [taskId]: task };
      onTask?.(task);
      if (TERMINAL_TASK_STATUSES.has(task?.status) || task?.done) {
        clearPollTimer(taskId);
        if (task?.status !== "completed") {
          throw new Error(task?.error || task?.message || "模型下载失败");
        }
        return task;
      }
      await new Promise((resolve) => globalThis.setTimeout(resolve, POLL_INTERVAL_MS));
    }
  };

  const updatePreparation = (modelId, payload, listeners = []) => {
    const previous = preparations.value[modelId] || {};
    const next = {
      modelId,
      label: previous.label || modelId,
      message: "",
      error: "",
      ...previous,
      ...payload,
      progress: normalizePreparationProgress(payload.progress, previous.progress || 0),
      updatedAt: Date.now(),
    };
    preparations.value = { ...preparations.value, [modelId]: next };
    for (const listener of listeners) {
      try {
        listener(next);
      } catch (listenerError) {
        console.warn("Model preparation progress listener failed:", listenerError);
      }
    }
    return next;
  };

  const runModelPreparation = async (modelId, options, listeners) => {
    const requestOptions = withConfiguredModelDir(options);
    let model = null;
    const report = (payload) => updatePreparation(modelId, {
      label: model?.label || modelId,
      ...payload,
    }, listeners);

    try {
      report({ stage: "checking", progress: 0, message: "正在检查模型状态。", error: "" });
      const registry = await refreshModels(requestOptions);
      model = registry.models.find((item) => item.id === modelId);
      if (!model) throw new Error(`未找到模型：${modelId}`);
      report({ stage: "checking", progress: 1, message: "模型状态检查完成。" });

      if (!model.installed) {
        if (!model.downloadable) {
          throw new Error(model.manualHint || "该模型需要手动下载并安装。");
        }

        let licenseAcceptance = options.licenseAcceptance || null;
        if (model.license?.requiresAcceptance) {
          if (!licenseAcceptance) {
            if (typeof options.requestLicenseAcceptance !== "function") {
              const licenseError = new Error("下载该模型前必须确认并接受对应许可证。");
              licenseError.code = "MODEL_LICENSE_ACCEPTANCE_REQUIRED";
              throw licenseError;
            }
            licenseAcceptance = await options.requestLicenseAcceptance(model);
          }
          const expectedId = String(model.license.acceptanceId || "").trim();
          if (!licenseAcceptance?.accepted || String(licenseAcceptance.acceptanceId || "").trim() !== expectedId) {
            const licenseError = new Error("下载该模型前必须确认并接受对应许可证。");
            licenseError.code = "MODEL_LICENSE_ACCEPTANCE_REQUIRED";
            throw licenseError;
          }
        }

        report({ stage: "downloading", progress: 0, message: "正在下载模型。" });
        const task = await startDownload(modelId, {
          ...requestOptions,
          licenseAcceptance,
          poll: false,
        });
        await waitForDownloadTask(task.id, (currentTask) => {
          report({
            stage: "downloading",
            progress: normalizePreparationProgress(currentTask?.progress),
            message: currentTask?.message || "正在下载模型。",
          });
        });
      }

      report({ stage: "verifying", progress: 0, message: "正在校验模型文件。" });
      const verification = await verifyModel(modelId, requestOptions);
      model = verification?.model || model;
      if (!model.installed || model.corruptFiles?.length || model.missingFiles?.length) {
        throw new Error("模型文件不完整或校验失败。");
      }
      report({ stage: "verifying", progress: 1, message: "模型文件校验完成。" });

      report({ stage: "loading", progress: 0, message: "正在加载模型。" });
      const response = await ModelRegistryService.prepareModel(modelId, requestOptions);
      if (!response?.loaded || !response?.runtimeReady || !response?.ready) {
        throw new Error(response?.error || response?.readiness?.reason || "模型加载失败。");
      }
      if (response?.currentModel) currentModel.value = response.currentModel;
      models.value = models.value.map((item) => item.id === modelId ? {
        ...item,
        loaded: true,
        loadState: response.loadState || "loaded",
        runtimeReady: true,
        ready: true,
        readiness: response.readiness || { status: "ready", reason: null },
      } : item);
      return report({
        stage: "ready",
        progress: 1,
        message: "模型已就绪。",
        error: "",
        verified: true,
        loaded: true,
        runtimeReady: true,
        ready: true,
        readiness: response.readiness,
      });
    } catch (preparationError) {
      models.value = models.value.map((item) => item.id === modelId ? {
        ...item,
        loaded: false,
        loadState: "failed",
        runtimeReady: false,
        ready: false,
        readiness: preparationError.response?.data?.readiness || {
          status: "failed",
          reason: "load_failed",
        },
      } : item);
      report({
        stage: "failed",
        message: preparationError.message || "模型准备失败。",
        error: preparationError.message || "模型准备失败。",
        loaded: false,
        runtimeReady: false,
        ready: false,
        readiness: preparationError.response?.data?.readiness || {
          status: "failed",
          reason: "load_failed",
        },
      });
      throw preparationError;
    }
  };

  const ensureModelReady = (modelId, options = {}) => {
    const normalizedModelId = String(modelId || "").trim();
    if (!normalizedModelId) return Promise.reject(new Error("缺少模型标识。"));
    if (options.signal?.aborted) return Promise.reject(createAbortError());

    const effectiveOptions = withConfiguredModelDir(options);
    const key = `${effectiveOptions.modelDir || "<default>"}::${normalizedModelId}`;
    let job = preparationJobs.get(key);
    if (!job) {
      const listeners = new Set();
      job = { listeners, promise: null };
      if (typeof options.onProgress === "function") {
        listeners.add(options.onProgress);
      }
      job.promise = runModelPreparation(normalizedModelId, effectiveOptions, listeners)
        .finally(() => preparationJobs.delete(key));
      preparationJobs.set(key, job);
    } else if (typeof options.onProgress === "function") {
      job.listeners.add(options.onProgress);
      const current = preparations.value[normalizedModelId];
      if (current) options.onProgress(current);
    }

    const callerPromise = options.signal ? Promise.race([
      job.promise,
      new Promise((_, reject) => {
        options.signal.addEventListener("abort", () => reject(createAbortError()), { once: true });
      }),
    ]) : job.promise;
    return callerPromise.finally(() => {
      if (typeof options.onProgress === "function") {
        job.listeners.delete(options.onProgress);
      }
    });
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
    modelManifest,
    loading,
    error,
    usingFallback,
    tasks,
    preparations,
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
    ensureModelReady,
  };
});
