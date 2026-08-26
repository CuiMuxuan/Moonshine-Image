const normalizeOperationIndices = (operationIndices = []) =>
  [...new Set(
    (Array.isArray(operationIndices) ? operationIndices : [])
      .filter((index) => Number.isInteger(index) && index >= 0)
  )].sort((left, right) => left - right);

export const getPreviousMaskHistoryIndex = (operationIndices, currentIndex) => {
  const indices = normalizeOperationIndices(operationIndices);
  for (let index = indices.length - 1; index >= 0; index -= 1) {
    if (indices[index] < currentIndex) return indices[index];
  }
  return -1;
};

export const getNextMaskHistoryIndex = (operationIndices, currentIndex) => {
  const indices = normalizeOperationIndices(operationIndices);
  return indices.find((index) => index > currentIndex) ?? -1;
};
