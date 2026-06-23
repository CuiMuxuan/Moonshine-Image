import { defineStore } from "pinia";
import { computed, ref } from "vue";

const normalizeCudaPayload = (info = {}, sessionKey = "") => {
  const available = Boolean(info?.cuda_available && info?.cuda_compatible !== false);
  return {
    available,
    info: info || {},
    checkedAt: Date.now(),
    sessionKey: String(sessionKey || ""),
  };
};

export const useRuntimeDiagnosticsStore = defineStore("runtimeDiagnostics", () => {
  const cudaStatus = ref({
    available: false,
    info: null,
    checkedAt: 0,
    sessionKey: "",
    refreshing: false,
    error: "",
  });

  const cudaAvailable = computed(() => cudaStatus.value.available);
  const cudaInfo = computed(() => cudaStatus.value.info);
  const hasCudaStatus = computed(() => Boolean(cudaStatus.value.checkedAt));
  const cudaRefreshing = computed(() => cudaStatus.value.refreshing);
  const getCudaStatusMatchesSession = (sessionKey = "") =>
    hasCudaStatus.value && cudaStatus.value.sessionKey === String(sessionKey || "");

  const setCudaStatus = (info = {}, sessionKey = "") => {
    cudaStatus.value = {
      ...normalizeCudaPayload(info, sessionKey),
      refreshing: false,
      error: "",
    };
    return cudaStatus.value;
  };

  const setCudaUnavailable = (message = "后端服务未启动") => {
    cudaStatus.value = {
      available: false,
      info: { message },
      checkedAt: 0,
      sessionKey: "",
      refreshing: false,
      error: message,
    };
    return cudaStatus.value;
  };

  const setCudaRefreshing = (sessionKey = "") => {
    cudaStatus.value = {
      ...cudaStatus.value,
      sessionKey: String(sessionKey || cudaStatus.value.sessionKey || ""),
      refreshing: true,
      error: "",
    };
  };

  const resetCudaStatus = () => {
    cudaStatus.value = {
      available: false,
      info: null,
      checkedAt: 0,
      sessionKey: "",
      refreshing: false,
      error: "",
    };
  };

  return {
    cudaStatus,
    cudaAvailable,
    cudaInfo,
    hasCudaStatus,
    cudaRefreshing,
    getCudaStatusMatchesSession,
    setCudaStatus,
    setCudaUnavailable,
    setCudaRefreshing,
    resetCudaStatus,
  };
});
