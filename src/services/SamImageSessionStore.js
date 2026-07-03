const samImageSessionByContext = new Map();
let lastExecutedSamImageModelId = "";

export const getSamImageSessionStore = () => samImageSessionByContext;

export const getLastExecutedSamImageModelId = () => lastExecutedSamImageModelId;

export const setLastExecutedSamImageModelId = (modelId = "") => {
  lastExecutedSamImageModelId = String(modelId || "").trim();
  return lastExecutedSamImageModelId;
};

export const deleteSamImageSession = (contextId = "") => {
  const normalizedContextId = String(contextId || "").trim();
  if (!normalizedContextId) return false;
  return samImageSessionByContext.delete(normalizedContextId);
};

export const deleteSamImageSessions = (contextIds = []) => {
  let deleted = 0;
  for (const contextId of contextIds) {
    if (deleteSamImageSession(contextId)) {
      deleted += 1;
    }
  }
  return deleted;
};

export const clearSamImageSessionStore = () => {
  samImageSessionByContext.clear();
  lastExecutedSamImageModelId = "";
};
