import { api } from 'src/boot/axios';
import { useFileManagerStore } from 'src/stores/fileManager'

// 从data:image/png;base64,前缀中提取纯base64部分
const getBase64FromDataURL = (dataUrl) => {
  if (!dataUrl || typeof dataUrl !== 'string') {
    throw new Error('Invalid data URL');
  }
  return dataUrl.split(',')[1];
};

// 将文件转换为base64
const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = error => reject(error);
  });
};

// 单文件处理API（保留向后兼容性）
const performInpainting = async (fileId) => {
  try {
    const fileManagerStore = useFileManagerStore();
    const file = fileManagerStore.files.find(f => f.id === fileId);

    if (!file || !file.mask?.data) {
      throw new Error('文件或蒙版数据不存在');
    }

    // 获取图像数据
    let imageBase64;
    const latestImage = file.history[file.history.length - 1];

    if (latestImage.type === 'base64') {
      imageBase64 = `data:image/png;base64,${latestImage.data}`;
    } else {
      imageBase64 = await fileManagerStore.fileToBase64(file.originalFile);
    }

    // 构造请求数据
    const requestData = {
      data: [{
        id: fileId,
        image: getBase64FromDataURL(imageBase64),
        mask: getBase64FromDataURL(file.mask.displayUrl),
      }],
      image_type: "base64",
      mask_type: "base64",
      response_type: "base64"
    };

    // 调用批量处理API
    const response = await performBatchInpainting(requestData);

    // 处理单文件结果
    if (response.results && response.results.length > 0) {
      const result = response.results[0];
      if (result.success) {
        await fileManagerStore.addProcessingResult(fileId, result.result);

        // 重置蒙版
        const targetFile = fileManagerStore.files.find(f => f.id === fileId);
        if (targetFile) {
          targetFile.mask = null;
        }
      }
      return result;
    } else {
      throw new Error('处理结果为空');
    }
  } catch (error) {
    console.error('单文件处理失败:', error);
    throw error;
  }
};

// 调用批量inpaint API
const performBatchInpainting = async (requestData) => {
  try {
    console.log('发送批量处理请求:', requestData);

    // 发送请求到后端API
    const response = await api.post('/api/v1/batch_inpaint', requestData, {
      headers: {
        'Content-Type': 'application/json',
      }
    });
    const processedResults = await processBatchResults(response);
    return processedResults;
  } catch (error) {
    console.error('调用batch_inpaint API时出错:', error);
    // 处理不同类型的错误
    if (error.response) {
      // 服务器响应了错误状态码
      const errorMessage = error.response.data?.message || error.response.data?.detail || '服务器处理失败';
      throw new Error(`服务器错误 (${error.response.status}): ${errorMessage}`);
    } else if (error.request) {
      // 请求已发出但没有收到响应
      throw new Error('网络连接失败，请检查后端服务是否正常运行');
    } else {
      // 其他错误
      throw new Error(`请求配置错误: ${error.message}`);
    }
  }
};
const processBatchResults = async (response) => {
  const fileManagerStore = useFileManagerStore();
  const processedResults = [];

  if (response.results && Array.isArray(response.results)) {
    for (const result of response.results) {
      if (result.success && result.result) {
        try {
          // 将处理结果添加到对应文件的历史记录
          await fileManagerStore.addProcessingResult(result.id, result.result);

          // 重置对应文件的蒙版
          const targetFile = fileManagerStore.files.find(f => f.id === result.id);
          if (targetFile) {
            targetFile.mask = null;
          }

          processedResults.push({
            id: result.id,
            success: true,
            index: result.index
          });
        } catch (error) {
          console.error(`处理文件 ${result.id} 的结果时出错:`, error);
          processedResults.push({
            id: result.id,
            success: false,
            error: error.message,
            index: result.index
          });
        }
      } else {
        processedResults.push({
          id: result.id,
          success: false,
          error: '处理失败',
          index: result.index
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

// 调用文件夹批量处理API
const performFolderInpainting = async (folderData) => {
  try {
    // 发送请求
    const response = await api.post('/api/v1/batch_inpaint_by_folder', folderData, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // 返回处理结果
    return response;
  } catch (error) {
    console.error('调用batch_inpaint_by_folder API时出错:', error);
    throw error;
  }
};
// 验证请求数据格式
const validateRequestData = (requestData) => {
  if (!requestData) {
    throw new Error('请求数据不能为空');
  }

  if (!requestData.images || !Array.isArray(requestData.images)) {
    throw new Error('images字段必须是数组');
  }

  if (!requestData.masks || !Array.isArray(requestData.masks)) {
    throw new Error('masks字段必须是数组');
  }

  if (requestData.images.length !== requestData.masks.length) {
    throw new Error('图像和蒙版数量必须一致');
  }

  if (requestData.images.length === 0) {
    throw new Error('至少需要一张图像和对应的蒙版');
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
