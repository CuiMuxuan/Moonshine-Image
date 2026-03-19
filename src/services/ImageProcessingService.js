import { api } from 'src/boot/axios';
import { useFileManagerStore } from 'src/stores/fileManager'

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

const formatDetailItem = (item) => {
  if (item == null) return '';
  if (typeof item === 'string') return item;
  if (typeof item === 'number' || typeof item === 'boolean') return String(item);

  if (Array.isArray(item)) {
    return item.map(formatDetailItem).filter(Boolean).join('; ');
  }

  if (typeof item === 'object') {
    if (Array.isArray(item.loc) && item.msg) {
      const fieldPath = item.loc.join('.');
      return `${fieldPath}: ${item.msg}`;
    }
    if (item.msg) {
      return String(item.msg);
    }
    if (item.message) {
      return formatDetailItem(item.message);
    }
    if (item.detail) {
      return formatDetailItem(item.detail);
    }

    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  }

  return String(item);
};

const extractApiErrorMessage = (error, fallback = '服务器处理失败') => {
  const data = error?.response?.data;
  if (!data) return fallback;

  const message = formatDetailItem(data.message);
  const detail = formatDetailItem(data.detail);
  const bodyError = formatDetailItem(data.error);
  return message || detail || bodyError || fallback;
};

const getRequestItemId = (requestData, index) => {
  if (Array.isArray(requestData?.data) && requestData.data[index]) {
    return requestData.data[index].id;
  }
  return undefined;
};

// Single-file wrapper (kept for compatibility).
const performInpainting = async (fileId) => {
  try {
    const fileManagerStore = useFileManagerStore();
    const file = fileManagerStore.files.find(f => f.id === fileId);

    if (!file || !file.mask?.data) {
      throw new Error('文件或蒙版数据不存在');
    }

    let imageBase64;
    const latestImage = file.history[file.history.length - 1];

    if (latestImage.type === 'base64') {
      imageBase64 = `data:image/png;base64,${latestImage.data}`;
    } else {
      imageBase64 = await fileManagerStore.fileToBase64(file.originalFile);
    }

    const requestData = {
      data: [{
        id: fileId,
        image: getBase64FromDataURL(imageBase64),
        mask: getBase64FromDataURL(file.mask.displayUrl),
      }],
      image_type: 'base64',
      mask_type: 'base64',
      response_type: 'base64'
    };

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
    validateRequestData(requestData);
    console.log('发送批量处理请求:', requestData);

    const response = await api.post('/api/v1/batch_inpaint', requestData, {
      headers: {
        'Content-Type': 'application/json',
      }
    });

    return await processBatchResults(response, requestData);
  } catch (error) {
    console.error('调用batch_inpaint API时出错:', error);

    if (error.response) {
      const errorMessage = extractApiErrorMessage(error, '服务器处理失败');
      throw new Error(`服务器错误 (${error.response.status}): ${errorMessage}`);
    }
    if (error.request) {
      throw new Error('网络连接失败，请检查后端服务是否正常运行');
    }
    throw new Error(`请求配置错误: ${error.message}`);
  }
};

const processBatchResults = async (response, requestData = {}) => {
  const fileManagerStore = useFileManagerStore();
  const processedResults = [];

  if (response.results && Array.isArray(response.results)) {
    for (let i = 0; i < response.results.length; i++) {
      const result = response.results[i] || {};
      const resultIndex = Number.isInteger(result.index) ? result.index : i;
      const resultId = result.id || getRequestItemId(requestData, resultIndex);
      const resultPayload = result.result || result.image;

      if (result.success && resultPayload) {
        try {
          if (resultId) {
            await fileManagerStore.addProcessingResult(resultId, resultPayload);

            const targetFile = fileManagerStore.files.find(f => f.id === resultId);
            if (targetFile) {
              targetFile.mask = null;
            }
          }

          processedResults.push({
            id: resultId,
            success: true,
            index: resultIndex,
            result: resultPayload
          });
        } catch (error) {
          console.error(`处理文件 ${resultId} 的结果时出错:`, error);
          processedResults.push({
            id: resultId,
            success: false,
            error: error.message,
            index: resultIndex
          });
        }
      } else {
        processedResults.push({
          id: resultId,
          success: false,
          error: result.error || '处理失败',
          index: resultIndex
        });
      }
    }
  }

  return {
    processed_count: response.processed_count,
    success_count: response.success_count,
    total_time: response.total_time,
    results: processedResults
  };
};

// Call folder batch API.
const performFolderInpainting = async (folderData) => {
  try {
    return await api.post('/api/v1/batch_inpaint_by_folder', folderData, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    console.error('调用batch_inpaint_by_folder API时出错:', error);

    if (error.response) {
      const errorMessage = extractApiErrorMessage(error, '文件夹批处理失败');
      throw new Error(`服务器错误 (${error.response.status}): ${errorMessage}`);
    }
    if (error.request) {
      throw new Error('网络连接失败，请检查后端服务是否正常运行');
    }
    throw new Error(`请求配置错误: ${error.message}`);
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
  performFolderInpainting,
  getBase64FromDataURL,
  fileToBase64,
  validateRequestData
};
