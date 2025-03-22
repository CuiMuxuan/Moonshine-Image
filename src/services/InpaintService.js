import { api } from 'src/boot/axios';

// 从data:image/png;base64,前缀中提取纯base64部分
const getBase64FromDataURL = (dataUrl) => {
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

// 调用inpaint API
const performInpainting = async (imageFile, maskData) => {
  try {
    // 将图片文件转换为base64
    const imageBase64 = await fileToBase64(imageFile);

    // 构造请求体
    const requestData = {
      image: getBase64FromDataURL(imageBase64),
      mask: getBase64FromDataURL(maskData),
    };

    // 发送请求
    const response = await api.post('/api/v1/inpaint', requestData, {
      responseType: 'arraybuffer', // 因为返回的是图像数据
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // 将返回的图像数据转换为base64以便显示
    const base64Image = btoa(
      new Uint8Array(response)
        .reduce((data, byte) => data + String.fromCharCode(byte), '')
    );

    const imageUrl = `data:image/png;base64,${base64Image}`;
    return imageUrl;
  } catch (error) {
    console.error('调用inpaint API时出错:', error);
    throw error;
  }
};

// 调用批量inpaint API
const performBatchInpainting = async (requestData) => {
  try {
    // 发送请求
    const response = await api.post('/api/v1/batch_inpaint', requestData, {
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // 返回处理结果
    return response;
  } catch (error) {
    console.error('调用batch_inpaint API时出错:', error);
    throw error;
  }
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
export default {
  performInpainting,
  performBatchInpainting,
  performFolderInpainting,
  getBase64FromDataURL,
  fileToBase64
};