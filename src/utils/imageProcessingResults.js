export const IMAGE_PROCESSING_STATUSES = Object.freeze([
  "completed",
  "partial",
  "skipped",
  "failed",
]);

const toCount = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
};

export const isSkippedImageProcessingResult = (result = {}) =>
  result?.skipped === true ||
  result?.status === "skipped" ||
  result?.apply_scope === "skip";

export const summarizeImageProcessingResults = (payload = {}) => {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const totalCount = payload.total_count != null
    ? toCount(payload.total_count, results.length)
    : Math.max(toCount(payload.processed_count), results.length);

  let successCount;
  let skippedCount;
  let failedCount;
  if (results.length > 0) {
    successCount = results.filter((result) => result?.success === true).length;
    skippedCount = results.filter(isSkippedImageProcessingResult).length;
    failedCount = results.filter(
      (result) => result?.success !== true && !isSkippedImageProcessingResult(result)
    ).length;
    failedCount += Math.max(0, totalCount - results.length);
  } else {
    successCount = toCount(payload.success_count);
    skippedCount = toCount(payload.skipped_count);
    failedCount = toCount(
      payload.failed_count,
      Math.max(0, totalCount - successCount - skippedCount)
    );
  }

  let status = IMAGE_PROCESSING_STATUSES.includes(payload.status)
    ? payload.status
    : "";
  if (!status) {
    if (totalCount > 0 && successCount === totalCount) {
      status = "completed";
    } else if (totalCount > 0 && skippedCount === totalCount) {
      status = "skipped";
    } else if (successCount > 0) {
      status = "partial";
    } else if (failedCount > 0 || payload.success === false || totalCount === 0) {
      status = "failed";
    } else {
      status = "skipped";
    }
  }

  return {
    status,
    success: status !== "failed",
    total_count: totalCount,
    success_count: successCount,
    failed_count: failedCount,
    skipped_count: skippedCount,
  };
};

export const withImageProcessingSummary = (payload = {}) => ({
  ...payload,
  ...summarizeImageProcessingResults(payload),
});
