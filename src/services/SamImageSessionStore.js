const samImageSessionByContext = new Map();
let lastExecutedSamImageModelId = "";

export const getSamImageSessionStore = () => samImageSessionByContext;

export const getLastExecutedSamImageModelId = () => lastExecutedSamImageModelId;

export const setLastExecutedSamImageModelId = (modelId = "") => {
  lastExecutedSamImageModelId = String(modelId || "").trim();
  return lastExecutedSamImageModelId;
};

export const clearSamImageSessionStore = () => {
  samImageSessionByContext.clear();
  lastExecutedSamImageModelId = "";
};
