const SAFE_IDENTIFIER = /^[A-Za-z0-9_-]{8,128}$/;
const SAFE_RESULT_IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const SAFE_STATUS = /^[a-z_]{2,64}$/;
const SAFE_MEDIA_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
const SAFE_SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,95}$/;
function isSafeText(value) {
  return typeof value === "string" && value.length <= 4096 && [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}

function safeIdentifier(value) {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : null;
}

function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeFiniteNumber(value, maximum = 1_000_000_000) {
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= maximum ? number : null;
}

function projectMcpCandidate(value) {
  const input = value && typeof value === "object" ? value : {};
  const id = safeIdentifier(input.id ?? input.region_id ?? input.mask_id);
  if (!id) return null;
  const candidate = { id };
  const confidence = safeFiniteNumber(input.confidence ?? input.score, 1);
  if (confidence !== null && confidence >= 0 && confidence <= 1) candidate.confidence = confidence;
  const text = isSafeText(input.text) ? input.text : null;
  if (text) candidate.text = text;
  const artifactId = safeIdentifier(input.artifact_id);
  if (artifactId) candidate.artifact_id = artifactId;
  const sourceRegionId = safeIdentifier(input.source_region_id);
  if (sourceRegionId) candidate.source_region_id = sourceRegionId;
  if (Array.isArray(input.polygon) && input.polygon.length === 4) {
    const polygon = input.polygon.map((point) => {
      if (!Array.isArray(point) || point.length !== 2) return null;
      const x = safeFiniteNumber(point[0]);
      const y = safeFiniteNumber(point[1]);
      return x === null || y === null || x < 0 || y < 0 ? null : [x, y];
    });
    if (polygon.every(Boolean)) candidate.polygon = polygon;
  }
  const bbox = input.bbox && typeof input.bbox === "object" ? input.bbox : null;
  if (bbox) {
    const x = safeFiniteNumber(bbox.x);
    const y = safeFiniteNumber(bbox.y);
    const width = safeFiniteNumber(bbox.width);
    const height = safeFiniteNumber(bbox.height);
    if ([x, y, width, height].every((item) => item !== null) && x >= 0 && y >= 0 && width > 0 && height > 0) {
      candidate.bbox = { x, y, width, height };
    }
  }
  return candidate;
}

export function projectMcpArtifact(value) {
  const input = value && typeof value === "object" ? value : {};
  const artifactId = safeIdentifier(input.artifact_id);
  if (!artifactId) return null;
  const asset = input.asset && typeof input.asset === "object" ? input.asset : input;
  const artifact = { artifact_id: artifactId };
  const mediaType = asset.media_type ?? input.mime_type;
  if (typeof mediaType === "string" && SAFE_MEDIA_TYPE.test(mediaType) && mediaType.length <= 128) {
    artifact.mime_type = mediaType;
  }
  const sizeBytes = safeNonNegativeInteger(asset.size_bytes ?? input.size_bytes);
  if (sizeBytes !== null) artifact.size_bytes = sizeBytes;
  const sha256 = asset.sha256 ?? input.sha256;
  if (typeof sha256 === "string" && SAFE_SHA256.test(sha256)) artifact.sha256 = sha256;
  return artifact;
}

export function projectMcpArtifacts(value, limit = 100) {
  const source = Array.isArray(value) ? value : [];
  return source.map(projectMcpArtifact).filter(Boolean).slice(0, Math.max(0, Math.min(limit, 1000)));
}

function projectMcpJobResult(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : null;
  if (!input || typeof input.success !== "boolean") return null;
  const result = { success: input.success };
  if (typeof input.id === "string" && SAFE_RESULT_IDENTIFIER.test(input.id)) result.id = input.id;
  const artifactId = safeIdentifier(input.artifact_id);
  if (artifactId) result.artifact_id = artifactId;
  if (typeof input.error_code === "string" && SAFE_ERROR_CODE.test(input.error_code)) {
    result.error_code = input.error_code;
  }
  return result;
}

export function projectMcpJob(value, { includeArtifacts = false } = {}) {
  const input = value && typeof value === "object" ? value : {};
  const result = {};
  const jobId = safeIdentifier(input.job_id);
  if (jobId) result.job_id = jobId;
  if (typeof input.status === "string" && SAFE_STATUS.test(input.status)) result.status = input.status;
  if (typeof input.error_code === "string" && /^[A-Z0-9_]{2,96}$/.test(input.error_code)) result.error_code = input.error_code;
  if (Array.isArray(input.artifact_ids)) {
    const artifactIds = input.artifact_ids.map(safeIdentifier).filter(Boolean).slice(0, 1000);
    if (artifactIds.length) result.artifact_ids = artifactIds;
  }
  if (includeArtifacts) {
    const artifacts = projectMcpArtifacts(input.artifacts);
    if (artifacts.length) result.artifacts = artifacts;
  }
  if (Array.isArray(input.candidates)) {
    const candidates = input.candidates.map(projectMcpCandidate).filter(Boolean).slice(0, 256);
    if (candidates.length) result.candidates = candidates;
  }
  if (Array.isArray(input.results)) {
    const results = input.results.slice(0, 1000).map(projectMcpJobResult).filter(Boolean);
    if (results.length) result.results = results;
  }
  const summary = input.result && typeof input.result === "object" ? input.result : input.summary;
  if (summary && typeof summary === "object") {
    const safeSummary = {};
    for (const key of ["processed_count", "success_count", "failed_count", "cancelled_count", "item_count"]) {
      const count = safeNonNegativeInteger(summary[key]);
      if (count !== null) safeSummary[key] = count;
    }
    if (Object.keys(safeSummary).length) result.summary = safeSummary;
  }
  return result;
}

export { SAFE_IDENTIFIER, SAFE_STATUS, projectMcpCandidate };
