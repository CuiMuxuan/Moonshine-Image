import { ref } from "vue";

export default function useMaskService() {
  const masks = ref({});
  const currentMask = ref(null);

  // 更新蒙版数据
  const updateMask = (fileName, maskData) => {
    if (masks.value[fileName]) {
      masks.value[fileName] = maskData;
    }
  };

  // 为文件创建蒙版
  const createMaskForFile = (file) => {
    if (!masks.value[file.name] && file.type.startsWith("image/")) {
      masks.value[file.name] = {
        data: null,
        width: 0,
        height: 0,
      };
    }
  };

  // 删除文件的蒙版
  const deleteMask = (fileName) => {
    if (masks.value[fileName]) {
      delete masks.value[fileName];
    }
  };

  // 获取图片尺寸的辅助函数
  const getImageDimensions = (file) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
        URL.revokeObjectURL(img.src); // 释放内存
      };
      img.onerror = () => {
        reject(new Error("无法加载图片"));
        URL.revokeObjectURL(img.src);
      };
      img.src = URL.createObjectURL(file);
    });
  };

  // 调整蒙版大小的函数
  const resizeMaskData = (
    sourceData,
    sourceWidth,
    sourceHeight,
    targetWidth,
    targetHeight
  ) => {
    return new Promise((resolve, reject) => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = targetWidth;
        canvas.height = targetHeight;
        const ctx = canvas.getContext("2d");

        const img = new Image();
        img.onload = () => {
          ctx.clearRect(0, 0, targetWidth, targetHeight);
          ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
          resolve(canvas.toDataURL());
        };
        img.onerror = () => reject(new Error("无法加载蒙版图像"));
        img.src = sourceData;
      } catch (error) {
        reject(error);
      }
    });
  };

  // 将当前蒙版应用到选中文件
  const applyMaskToFiles = async (sourceMask, files, currentFileName) => {
    if (!sourceMask || !sourceMask.data) {
      return false;
    }

    const results = [];

    for (const file of files) {
      if (file.name !== currentFileName && file.type.startsWith("image/")) {
        try {
          // 获取目标图片的尺寸
          const targetDimensions = await getImageDimensions(file);

          // 调整蒙版大小
          const resizedMaskData = await resizeMaskData(
            sourceMask.data,
            sourceMask.width,
            sourceMask.height,
            targetDimensions.width,
            targetDimensions.height
          );

          // 更新蒙版数据
          masks.value[file.name] = {
            data: resizedMaskData,
            width: targetDimensions.width,
            height: targetDimensions.height,
          };

          results.push({
            fileName: file.name,
            success: true,
          });
        } catch (error) {
          console.error(`调整蒙版失败: ${file.name}`, error);
          results.push({
            fileName: file.name,
            success: false,
            error,
          });
        }
      }
    }

    return results;
  };

  return {
    masks,
    currentMask,
    updateMask,
    createMaskForFile,
    deleteMask,
    getImageDimensions,
    resizeMaskData,
    applyMaskToFiles,
  };
}
