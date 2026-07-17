import { api } from 'src/boot/axios';
import { useFileManagerStore } from 'src/stores/fileManager'
import { useConfigStore } from 'src/stores/config'
import { classifyMoonshineError } from 'src/services/ErrorClassifier';
import { buildImageOutputRequestOptions } from 'src/utils/imageOutputOptions';
import { withImageProcessingSummary } from 'src/utils/imageProcessingResults';

// Extract raw base64 from a data URL.
const getBase64FromDataURL = (dataUrl) => {
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw new Error('Invalid data URL');
  }
  return dataUrl.split(',')[1];
};

// Convert file to base64 data URL.
const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = error => reject(error);
  });
};

const getRequestItemId = (requestData, index) => {
  if (Array.isArray(requestData?.data) && requestData.data[index]) {
    return requestData.data[index].id;
  }
  return undefined;
};

const extractPreparedRequestMetadata = (requestData = {}) => {
  const {
    _clientFailures = [],
    _sourceIndexes = [],
    _requestedCount,
    _cleanupDirectory,
    ...payload
  } = requestData || {};
  return {
    payload,
    metadata: {
      clientFailures: Array.isArray(_clientFailures) ? _clientFailures : [],
      sourceIndexes: Array.isArray(_sourceIndexes) ? _sourceIndexes : [],
      requestedCount: Number.isFinite(Number(_requestedCount))
        ? Math.max(0, Math.floor(Number(_requestedCount)))
        : undefined,
      cleanupDirectory: String(_cleanupDirectory || ''),
    },
  };
};

const resolveInpaintColorStabilization = () => {
  const configStore = useConfigStore();
  const mode = String(configStore.config.video?.inpaintColorStabilization || 'auto');
  return ['off', 'auto', 'enhanced'].includes(mode) ? mode : 'auto';
};

const attachInpaintOptions = (requestData = {}) => ({
  ...requestData,
  inpaint: {
    ...(requestData.inpaint || {}),
    color_stabilization: resolveInpaintColorStabilization(),
  },
});

const performInpainting = async (fileId) => {
  try {
    const fileManagerStore = useFileManagerStore();
    const file = fileManagerStore.files.find(f => f.id === fileId);

    if (!file || !file.mask?.data) {
      throw new Error('文件或蒙版数据不存在');
    }

    let imageBase64;
    const latestImage = file.history[file.history.length - 1];
    const configStore = useConfigStore();

    if (latestImage.type === 'base64') {
      imageBase64 = `data:image/png;base64,${latestImage.data}`;
    } else {
      imageBase64 = await fileManagerStore.fileToBase64(file.originalFile);
    }

    const requestData = attachInpaintOptions({
      data: [{
        id: fileId,
        image: getBase64FromDataURL(imageBase64),
        mask: getBase64FromDataURL(file.mask.displayUrl),
      }],
      image_type: 'base64',
      mask_type: 'base64',
      response_type: 'base64',
      ...buildImageOutputRequestOptions(configStore.config)
    });

    const response = await performBatchInpainting(requestData);

    if (response.results && response.results.length > 0) {
      return response.results[0];
    }

    throw new Error('处理结果为空');
  } catch (error) {
    console.error('单文件处理失败:', error);
    throw error;
  }
};

// Call batch inpaint API.
const performBatchInpainting = async (requestData) => {
  try {
    const preparedRequest = extractPreparedRequestMetadata(requestData);
    const payload = attachInpaintOptions(preparedRequest.payload);
    if (
      Array.isArray(payload.data) &&
      payload.data.length === 0 &&
      preparedRequest.metadata.clientFailures.length > 0
    ) {
      return await processBatchResults(
        { processed_count: 0, success_count: 0, results: [] },
        payload,
        preparedRequest.metadata
      );
    }
    validateRequestData(payload);
    console.log('发送批量处理请求:', payload);

    const response = await api.post('/api/v1/batch_inpaint', payload, {
      headers: {
        'Content-Type': 'application/json',
      }
    });

    return await processBatchResults(response, payload, preparedRequest.metadata);
  } catch (error) {
    console.error('调用batch_inpaint API时出错:', error);

    if (error.response) {
      throw new Error(classifyMoonshineError(error, '图像处理失败').message);
    }
    if (error.request) {
      throw new Error(classifyMoonshineError(error, '图像处理失败').message);
    }
    throw new Error(`请求配置错误: ${error.message}`);
  }
};

const performMoonshineImageProcessing = async (requestData) => {
  try {
    const preparedRequest = extractPreparedRequestMetadata(requestData);
    const payload = preparedRequest.payload;
    if (payload.data?.length === 0 && preparedRequest.metadata.clientFailures.length > 0) {
      return await processBatchResults(
        { processed_count: 0, success_count: 0, results: [] },
        payload,
        preparedRequest.metadata
      );
    }
    validateMoonshineImageRequestData(payload);
    const response = await api.post('/api/v1/moonshine/image/process', payload, {
      headers: {
        'Content-Type': 'application/json',
      }
    });

    return await processBatchResults(response, payload, preparedRequest.metadata);
  } catch (error) {
    console.error('调用Moonshine图片处理API时出错:', error);

    if (error.response) {
      throw new Error(classifyMoonshineError(error, 'Moonshine图片处理失败').message);
    }
    if (error.request) {
      throw new Error(classifyMoonshineError(error, 'Moonshine图片处理失败').message);
    }
    throw new Error(`请求配置错误: ${error.message}`);
  }
};

const processBatchResults = async (response, requestData = {}, metadata = {}) => {
  const fileManagerStore = useFileManagerStore();
  const processedResults = [];

  if (response.results && Array.isArray(response.results)) {
    for (let i = 0; i < response.results.length; i++) {
      const result = response.results[i] || {};
      const resultIndex = Number.isInteger(result.index) ? result.index : i;
      const resultId = result.id || getRequestItemId(requestData, resultIndex);
      const sourceIndex = Number.isInteger(metadata.sourceIndexes?.[resultIndex])
        ? metadata.sourceIndexes[resultIndex]
        : resultIndex;
      const resultPayload = result.result;

      if (result.success && resultPayload) {
        try {
          if (resultId) {
            await fileManagerStore.addProcessingResult(resultId, resultPayload, {
              format: result.format,
              mimeType: result.mime_type,
              extension: result.extension,
              applyScope: result.apply_scope,
              inferenceStrategy: result.inference_strategy,
            });
          }

          processedResults.push({
            id: resultId,
            success: true,
            index: sourceIndex,
            result: resultPayload,
            format: result.format,
            mime_type: result.mime_type,
            extension: result.extension,
            apply_scope: result.apply_scope,
            inference_strategy: result.inference_strategy,
            bboxEmptyRatio: result.bboxEmptyRatio,
            effectiveMaskCoverage: result.effectiveMaskCoverage,
            fullTileCount: result.fullTileCount,
            localTileCount: result.localTileCount,
            tileSavingRatio: result.tileSavingRatio,
            fallback_reason: result.fallback_reason,
          });
        } catch (error) {
          console.error(`处理文件 ${resultId} 的结果时出错:`, error);
          processedResults.push({
            id: resultId,
            success: false,
            error: error.message,
            error_code: 'RESULT_WRITE_FAILED',
            index: sourceIndex
          });
        }
      } else {
        processedResults.push({
          id: resultId,
          success: false,
          error: result.error || '处理失败',
          error_code: result.error_code,
          skipped: result.skipped === true,
          apply_scope: result.apply_scope,
          index: sourceIndex
        });
      }
    }
  }

  processedResults.push(...(metadata.clientFailures || []));
  processedResults.sort((left, right) => (left?.index ?? 0) - (right?.index ?? 0));

  return withImageProcessingSummary({
    success: response.success,
    status: undefined,
    total_count: metadata.requestedCount ?? response.total_count,
    processed_count: response.processed_count,
    success_count: response.success_count,
    failed_count: response.failed_count,
    skipped_count: response.skipped_count,
    total_time: response.total_time,
    results: processedResults
  });
};

// Call folder batch API.
const performFolderInpainting = async (folderData) => {
  try {
    folderData = {
      ...folderData,
      color_stabilization: resolveInpaintColorStabilization(),
    };
    const response = await api.post('/api/v1/batch_inpaint_by_folder', folderData, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return withImageProcessingSummary(response);
  } catch (error) {
    console.error('调用batch_inpaint_by_folder API时出错:', error);

    if (error.response) {
      throw new Error(classifyMoonshineError(error, '文件夹批处理失败').message);
    }
    if (error.request) {
      throw new Error(classifyMoonshineError(error, '文件夹批处理失败').message);
    }
    throw new Error(`请求配置错误: ${error.message}`);
  }
};

const performMoonshineFolderProcessing = async (folderData) => {
  try {
    const response = await api.post('/api/v1/moonshine/image/process_folder', folderData, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return withImageProcessingSummary(response);
  } catch (error) {
    console.error('调用Moonshine文件夹处理API时出错:', error);

    if (error.response) {
      throw new Error(classifyMoonshineError(error, 'Moonshine文件夹处理失败').message);
    }
    if (error.request) {
      throw new Error(classifyMoonshineError(error, 'Moonshine文件夹处理失败').message);
    }
    throw new Error(`请求配置错误: ${error.message}`);
  }
};

const inspectMoonshineFolderMasks = async (folderData) => {
  try {
    return await api.post('/api/v1/moonshine/image/inspect_folder_masks', folderData, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('调用SLBR文件夹蒙版预检API时出错:', error);
    throw new Error(classifyMoonshineError(error, 'SLBR文件夹蒙版预检失败').message);
  }
};

const validateMoonshineImageRequestData = (requestData) => {
  if (!requestData) {
    throw new Error('请求数据不能为空');
  }

  if (!requestData.model_id) {
    throw new Error('请求必须包含 model_id');
  }

  if (!Array.isArray(requestData.data) || requestData.data.length === 0) {
    throw new Error('data 数组不能为空');
  }

  const idSet = new Set();
  for (const item of requestData.data) {
    if (!item || typeof item !== 'object') {
      throw new Error('data 中存在无效项');
    }
    if (!item.id) {
      throw new Error('data 中每项都必须包含 id');
    }
    if (!item.image) {
      throw new Error('data 中每项都必须包含 image');
    }
    if (idSet.has(item.id)) {
      throw new Error(`data 中存在重复id: ${item.id}`);
    }
    idSet.add(item.id);
  }
};

// Validate request payload for both old/new protocol.
const validateRequestData = (requestData) => {
  if (!requestData) {
    throw new Error('请求数据不能为空');
  }

  const hasNewFormat = Array.isArray(requestData.data);
  const hasLegacyFormat = Array.isArray(requestData.images) || Array.isArray(requestData.masks);

  if (!hasNewFormat && !hasLegacyFormat) {
    throw new Error('请求必须包含 data 或 images/masks 字段');
  }

  if (hasNewFormat) {
    if (requestData.data.length === 0) {
      throw new Error('data 数组不能为空');
    }

    const idSet = new Set();
    for (const item of requestData.data) {
      if (!item || typeof item !== 'object') {
        throw new Error('data 中存在无效项');
      }
      if (!item.id) {
        throw new Error('data 中每项都必须包含 id');
      }
      if (!item.image || !item.mask) {
        throw new Error('data 中每项都必须包含 image 和 mask');
      }
      if (idSet.has(item.id)) {
        throw new Error(`data 中存在重复 id: ${item.id}`);
      }
      idSet.add(item.id);
    }
  }

  if (hasLegacyFormat) {
    if (!Array.isArray(requestData.images) || !Array.isArray(requestData.masks)) {
      throw new Error('images 和 masks 必须同时为数组');
    }
    if (requestData.images.length !== requestData.masks.length) {
      throw new Error('images 和 masks 数量必须一致');
    }
    if (requestData.images.length === 0) {
      throw new Error('images 和 masks 不能为空');
    }
  }
};

export default {
  performInpainting,
  performBatchInpainting,
  performMoonshineImageProcessing,
  performFolderInpainting,
  performMoonshineFolderProcessing,
  inspectMoonshineFolderMasks,
  getBase64FromDataURL,
  fileToBase64,
  validateRequestData
};
