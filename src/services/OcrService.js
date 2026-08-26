const OCR_CAPABILITIES_PATH = "/api/v1/moonshine/ocr/capabilities";
const OCR_RECOGNIZE_PATH = "/api/v1/moonshine/ocr/recognize";
const OCR_REQUEST_TIMEOUT_MS = 15000;
const OCR_ENGINE_ID = "ocr_rapid_onnx_mobile";
const OCR_BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const unavailableCapabilities = (message = "OCR 组件或模型尚未就绪") => ({
  schema_version: "ocr-capabilities/v1",
  engine_id: OCR_ENGINE_ID,
  status: "missing",
  enabled: false,
  languages: [],
  supports_orientation: false,
  message,
});

const unwrapPayload = (response) => response?.data ?? response ?? {};

const normalizeBase64 = (value) => {
  const source = String(value || "").trim();
  const dataUrlMatch = source.match(/^data:([^;]+);base64,(.+)$/is);
  if (dataUrlMatch && !/^image\/[a-z0-9.+-]+$/i.test(dataUrlMatch[1])) {
    throw new Error("OCR 输入不是有效的图片数据");
  }
  const encoded = dataUrlMatch ? dataUrlMatch[2].trim() : source;
  if (
    !encoded ||
    encoded.length > 20 * 1024 * 1024 ||
    encoded.length % 4 !== 0 ||
    !OCR_BASE64_RE.test(encoded)
  ) {
    throw new Error("OCR 输入不是有效的内存图片数据");
  }
  return encoded;
};

const normalizeCapabilities = (response) => {
  const payload = unwrapPayload(response);
  const status = ["missing", "ready", "incompatible", "integrity_error"].includes(payload.status)
    ? payload.status
    : "incompatible";
  const engineId = typeof payload.engine_id === "string" && /^ocr_[a-z0-9]+(?:_[a-z0-9]+)+$/.test(payload.engine_id)
    ? payload.engine_id
    : OCR_ENGINE_ID;
  const languages = Array.isArray(payload.languages)
    ? payload.languages.filter((language) => typeof language === "string").slice(0, 64)
    : [];
  return {
    schema_version: "ocr-capabilities/v1",
    engine_id: engineId,
    status,
    enabled: Boolean(payload.enabled) && status === "ready",
    languages,
    supports_orientation: Boolean(payload.supports_orientation),
    message: status === "ready" ? "识别结果会回到中央画布供审阅和编辑。" : "OCR 组件或模型尚未就绪",
  };
};

const normalizeRecognizeResponse = (response) => {
  const payload = unwrapPayload(response);
  if (!Array.isArray(payload.regions) || payload.regions.length > 128) {
    throw new Error("OCR 返回结果不可用");
  }
  if (
    typeof payload.engine_id !== "string" ||
    !/^ocr_[a-z0-9]+(?:_[a-z0-9]+)+$/.test(payload.engine_id)
  ) {
    throw new Error("OCR 返回结果不可用");
  }
  return {
    schema_version: typeof payload.schema_version === "string" ? payload.schema_version : "ocr-recognize/v1",
    engine_id: payload.engine_id,
    regions: payload.regions.map((region) => ({
      ...region,
      polygon: normalizePolygon(region),
      confidence: normalizeConfidence(region),
    })),
  };
};

const normalizePoint = (point) => {
  if (!Array.isArray(point) || point.length !== 2) return null;
  const x = Number(point[0]);
  const y = Number(point[1]);
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 ? [x, y] : null;
};

const normalizePolygon = (region = {}) => {
  const source = region?.polygon || region?.points || region?.quad || [];
  if (!Array.isArray(source)) return [];
  return source.map(normalizePoint);
};

const normalizeConfidence = (region = {}) => {
  const raw = Number(
    region?.confidence ??
      region?.recognition_confidence ??
      region?.detection_confidence ??
      region?.score ??
      region?.probability
  );
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
};

const polygonArea = (polygon) =>
  Math.abs(
    polygon.reduce((area, point, index) => {
      const next = polygon[(index + 1) % polygon.length];
      return area + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2
  );

export const createOcrPolygonMaskDataUrl = ({ width, height, polygon = [], canvasFactory } = {}) => {
  const imageWidth = Math.floor(Number(width));
  const imageHeight = Math.floor(Number(height));
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight) || imageWidth < 1 || imageHeight < 1) {
    throw new Error("OCR 图片尺寸不可用");
  }
  const validPolygon = normalizePolygon({ polygon })
    .filter(Boolean)
    .slice(0, 4)
    .map(([x, y]) => [Math.min(imageWidth, x), Math.min(imageHeight, y)]);
  if (
    validPolygon.length !== 4 ||
    new Set(validPolygon.map(([x, y]) => `${x}:${y}`)).size !== 4 ||
    polygonArea(validPolygon) <= 0
  ) {
    throw new Error("OCR 未返回可用文本区域");
  }

  const canvas = canvasFactory
    ? canvasFactory(imageWidth, imageHeight)
    : document.createElement("canvas");
  if (!canvas) throw new Error("OCR 遮罩画布不可用");
  canvas.width = imageWidth;
  canvas.height = imageHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("OCR 遮罩画布不可用");

  context.clearRect(0, 0, imageWidth, imageHeight);
  context.fillStyle = "#ffffff";
  context.beginPath();
  context.moveTo(validPolygon[0][0], validPolygon[0][1]);
  validPolygon.slice(1).forEach(([x, y]) => context.lineTo(x, y));
  context.closePath();
  context.fill();
  const dataUrl = canvas.toDataURL("image/png");
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
    throw new Error("OCR 遮罩输出不可用");
  }
  return dataUrl;
};

export const createOcrMaskDataUrl = ({ width, height, regions = [], canvasFactory } = {}) => {
  if (!Array.isArray(regions) || regions.length > 128) {
    throw new Error("OCR 返回区域超出限制");
  }
  const imageWidth = Math.floor(Number(width));
  const imageHeight = Math.floor(Number(height));
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight) || imageWidth < 1 || imageHeight < 1) {
    throw new Error("OCR 图片尺寸不可用");
  }
  const canvas = canvasFactory
    ? canvasFactory(imageWidth, imageHeight)
    : document.createElement("canvas");
  if (!canvas) throw new Error("OCR 遮罩画布不可用");
  canvas.width = imageWidth;
  canvas.height = imageHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("OCR 遮罩画布不可用");
  context.clearRect(0, 0, imageWidth, imageHeight);
  context.fillStyle = "#ffffff";
  const validPolygons = regions
    .map((region) => normalizePolygon(region).filter(Boolean).slice(0, 4))
    .filter(
      (item) =>
        item.length === 4 &&
        new Set(item.map(([x, y]) => `${x}:${y}`)).size === 4 &&
        polygonArea(item) > 0
    )
    .map((item) => item.map(([x, y]) => [Math.min(imageWidth, x), Math.min(imageHeight, y)]));
  if (!validPolygons.length) throw new Error("OCR 未返回可用文本区域");
  for (const item of validPolygons) {
    context.beginPath();
    context.moveTo(item[0][0], item[0][1]);
    item.slice(1).forEach(([x, y]) => context.lineTo(x, y));
    context.closePath();
    context.fill();
  }
  const dataUrl = canvas.toDataURL("image/png");
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) {
    throw new Error("OCR 遮罩输出不可用");
  }
  return dataUrl;
};

export const buildOcrCandidates = ({
  width,
  height,
  regions = [],
  highThreshold = 0.9,
  lowThreshold = 0.8,
  canvasFactory,
} = {}) => {
  const high = Math.max(0, Math.min(1, Number(highThreshold)));
  const low = Math.max(0, Math.min(high, Number(lowThreshold)));
  return regions
    .map((region, index) => ({
      ...region,
      polygon: normalizePolygon(region),
      confidence: normalizeConfidence(region),
      index,
    }))
    .filter((region) => region.confidence > low && region.polygon.length === 4)
    .map((region, index) => ({
      localId: `ocr-${Date.now()}-${region.index}-${index}`,
      label: `OCR 文本 ${index + 1}`,
      score: region.confidence,
      confidence: region.confidence,
      text: typeof region.text === "string" ? region.text : "",
      polygon: region.polygon,
      source: "ocr",
      enabled: region.confidence > high,
      mask: createOcrPolygonMaskDataUrl({
        width,
        height,
        polygon: region.polygon,
        canvasFactory,
      }),
      prompt: { type: "ocr", polygon: region.polygon, text: region.text || "" },
    }));
};

export const createOcrService = (httpClient) => {
  if (!httpClient || typeof httpClient.get !== "function" || typeof httpClient.post !== "function") {
    throw new TypeError("OCR service requires an HTTP client");
  }

  return {
    async getCapabilities() {
      try {
        const response = httpClient.instance?.get
          ? await httpClient.instance.get(OCR_CAPABILITIES_PATH, { timeout: OCR_REQUEST_TIMEOUT_MS })
          : await httpClient.get(OCR_CAPABILITIES_PATH, { timeout: OCR_REQUEST_TIMEOUT_MS });
        return normalizeCapabilities(response);
      } catch {
        return unavailableCapabilities("OCR 服务暂不可用");
      }
    },

    async recognize({ imageBase64, modelId = "", regions = [], options = {}, signal } = {}) {
      const normalizedModelId = String(modelId || "").trim();
      const payload = {
        image_base64: normalizeBase64(imageBase64),
        ...(normalizedModelId ? { model_id: normalizedModelId } : {}),
        regions: Array.isArray(regions) ? regions.slice(0, 128) : [],
        options: options && typeof options === "object" ? Object.fromEntries(Object.entries(options).slice(0, 16)) : {},
      };
      try {
        return normalizeRecognizeResponse(await httpClient.post(OCR_RECOGNIZE_PATH, payload, {
          timeout: OCR_REQUEST_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
          headers: { "Content-Type": "application/json" },
        }));
      } catch (error) {
        if (error?.name === "AbortError" || error?.name === "CanceledError" || error?.code === "ERR_CANCELED") {
          throw error;
        }
        if (error instanceof Error && error.message.startsWith("OCR ")) throw error;
        throw new Error("OCR 识别暂时失败");
      }
    },
  };
};

export {
  OCR_CAPABILITIES_PATH,
  OCR_RECOGNIZE_PATH,
  normalizeBase64,
  normalizeCapabilities,
  normalizeRecognizeResponse,
  normalizePolygon,
  normalizeConfidence,
};
