import { ref, computed } from "vue";

export default function useFileService() {
  const files = ref([]);
  const selectedFile = ref(null);
  const selectedFiles = ref([]);
  const fileUrls = ref({});

  // 过滤出图片文件
  const filteredFiles = computed(() =>
    files.value.filter((f) => f.type.startsWith("image/"))
  );

  // 获取文件图标
  const getFileIcon = (file) => {
    const type = file.type?.split("/")[0] || "";
    return (
      {
        image: "photo",
        video: "movie",
        audio: "music_note",
        text: "description",
        application: "insert_drive_file",
      }[type] || "insert_drive_file"
    );
  };

  // 添加文件
  const addFiles = (newFiles) => {
    // 合并文件并创建URL
    files.value = [...files.value, ...newFiles];

    // 为新文件创建URL
    newFiles.forEach((file) => {
      if (file.type.startsWith("image/") && !fileUrls.value[file.name]) {
        fileUrls.value[file.name] = URL.createObjectURL(file);
      }
    });

    // 如果没有选中文件，选择第一个
    if (!selectedFile.value && filteredFiles.value.length > 0) {
      selectedFile.value = filteredFiles.value[0];
    }

    return newFiles;
  };

  // 删除文件
  const removeFile = (index) => {
    const removed = files.value.splice(index, 1)[0];

    // 释放URL
    if (removed && fileUrls.value[removed.name]) {
      URL.revokeObjectURL(fileUrls.value[removed.name]);
      delete fileUrls.value[removed.name];
    }

    // 更新选中文件
    if (selectedFile.value?.name === removed.name) {
      selectedFile.value = filteredFiles.value[0] || null;
    }

    // 从选中文件列表中移除
    selectedFiles.value = selectedFiles.value.filter(
      (f) => f.name !== removed.name
    );

    return removed;
  };

  // 删除选中的文件
  const removeSelectedFiles = () => {
    const filesToRemove = [...selectedFiles.value];

    // 删除文件并释放URL
    filesToRemove.forEach((file) => {
      if (fileUrls.value[file.name]) {
        URL.revokeObjectURL(fileUrls.value[file.name]);
        delete fileUrls.value[file.name];
      }
    });

    // 从文件列表中移除
    files.value = files.value.filter(
      (f) => !selectedFiles.value.some((sf) => sf.name === f.name)
    );

    // 如果当前选中的文件被删除，重新选择第一个文件
    if (
      selectedFile.value &&
      selectedFiles.value.some((f) => f.name === selectedFile.value.name)
    ) {
      selectedFile.value = filteredFiles.value[0] || null;
    }

    // 清空选中文件列表
    selectedFiles.value = [];

    return filesToRemove;
  };

  // 全选/取消全选
  const toggleSelectAll = (select) => {
    if (select) {
      selectedFiles.value = [...filteredFiles.value];
    } else {
      selectedFiles.value = [];
    }
  };

  // 清理资源
  const cleanup = () => {
    Object.values(fileUrls.value).forEach((url) => {
      URL.revokeObjectURL(url);
    });
  };

  return {
    files,
    selectedFile,
    selectedFiles,
    fileUrls,
    filteredFiles,
    getFileIcon,
    addFiles,
    removeFile,
    removeSelectedFiles,
    toggleSelectAll,
    cleanup,
  };
}
