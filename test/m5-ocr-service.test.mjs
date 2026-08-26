import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOcrCandidates,
  createOcrMaskDataUrl,
  createOcrService,
  OCR_CAPABILITIES_PATH,
  OCR_RECOGNIZE_PATH,
} from "../src/services/OcrService.js";

test("OCR service keeps capability and recognize routes allowlisted", async () => {
  const calls = [];
  const service = createOcrService({
    async get(path, options) {
      calls.push({ method: "GET", path, options });
      return {
        status: "ready",
        enabled: true,
        engine_id: "ocr_rapid_onnx_mobile",
        languages: ["eng"],
      };
    },
    async post(path, payload, options) {
      calls.push({ method: "POST", path, payload, options });
      return {
        schema_version: "ocr-recognize/v1",
        engine_id: "ocr_rapid_onnx_mobile",
        regions: [{
          polygon: [[1, 1], [9, 1], [9, 9], [1, 9]],
          bbox: [1, 1, 9, 9],
          text: "ignored by renderer provenance",
          detection_confidence: 0.82,
          recognition_confidence: 0.94,
        }],
      };
    },
  });

  const capabilities = await service.getCapabilities();
  assert.equal(capabilities.enabled, true);
  const requestController = new AbortController();
  const result = await service.recognize({
    imageBase64: "data:image/png;base64,AAAA",
    modelId: "ocr_rapid_onnx_mobile",
    signal: requestController.signal,
  });
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0].confidence, 0.94);
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    `GET ${OCR_CAPABILITIES_PATH}`,
    `POST ${OCR_RECOGNIZE_PATH}`,
  ]);
  assert.equal(calls[1].payload.image_base64, "AAAA");
  assert.equal(calls[1].payload.model_id, "ocr_rapid_onnx_mobile");
  assert.equal(calls[1].options.timeout, 15000);
  assert.equal(calls[1].options.signal, requestController.signal);
});

test("OCR capability errors fail closed and path-like input is rejected", async () => {
  let recognizeCalls = 0;
  const service = createOcrService({
    async get() {
      throw new Error("network details must not escape");
    },
    async post() {
      recognizeCalls += 1;
    },
  });

  const capabilities = await service.getCapabilities();
  assert.equal(capabilities.enabled, false);
  assert.equal(capabilities.status, "missing");
  await assert.rejects(
    () => service.recognize({ imageBase64: "C:/private/image.png" }),
    /内存图片数据/
  );
  await assert.rejects(
    () => service.recognize({ imageBase64: "foo/bar" }),
    /内存图片数据/
  );
  await assert.rejects(
    () => service.recognize({ imageBase64: "data:text/plain;base64,AAAA" }),
    /图片数据/
  );
  assert.equal(recognizeCalls, 0);
});

test("OCR polygons become a source-sized binary mask", () => {
  const operations = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        clearRect: (...args) => operations.push(["clearRect", ...args]),
        beginPath: () => operations.push(["beginPath"]),
        moveTo: (...args) => operations.push(["moveTo", ...args]),
        lineTo: (...args) => operations.push(["lineTo", ...args]),
        closePath: () => operations.push(["closePath"]),
        fill: () => operations.push(["fill"]),
      };
    },
    toDataURL: (format) => `data:${format};base64,mask`,
  };

  const dataUrl = createOcrMaskDataUrl({
    width: 100,
    height: 80,
    regions: [{ polygon: [[0, 2], [150, 2], [150, 20], [0, 20]] }],
    canvasFactory: () => canvas,
  });
  assert.equal(dataUrl, "data:image/png;base64,mask");
  assert.equal(canvas.width, 100);
  assert.equal(canvas.height, 80);
  assert.equal(operations.filter(([name]) => name === "fill").length, 1);
  assert.throws(
    () => createOcrMaskDataUrl({
      width: 100,
      height: 80,
      regions: [{ polygon: [[1, 1], [9, 1], [9, 1], [1, 9]] }],
      canvasFactory: () => canvas,
    }),
    /可用文本区域/
  );
});

test("OCR candidates apply confidence tiers before entering smart-selection", () => {
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return {
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        fill() {},
      };
    },
    toDataURL: () => "data:image/png;base64,mask",
  };
  const candidates = buildOcrCandidates({
    width: 100,
    height: 80,
    highThreshold: 0.9,
    lowThreshold: 0.8,
    canvasFactory: () => canvas,
    regions: [
      { confidence: 0.95, polygon: [[1, 1], [9, 1], [9, 9], [1, 9]] },
      { confidence: 0.85, polygon: [[11, 1], [19, 1], [19, 9], [11, 9]] },
      { confidence: 0.8, polygon: [[21, 1], [29, 1], [29, 9], [21, 9]] },
    ],
  });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => candidate.enabled), [true, false]);
  assert.deepEqual(candidates.map((candidate) => candidate.source), ["ocr", "ocr"]);
  assert.ok(candidates.every((candidate) => candidate.mask.startsWith("data:image/png")));
});
