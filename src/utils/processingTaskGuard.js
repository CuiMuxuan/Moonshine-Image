const sendProcessingTaskState = (payload) => {
  if (!window.electron?.ipcRenderer?.send) {
    return;
  }

  window.electron.ipcRenderer.send("set-active-processing-task", payload);
};

export const setActiveProcessingTask = ({ taskId, type, label, active }) => {
  if (!taskId) {
    return;
  }

  sendProcessingTaskState({
    taskId,
    type: type || "task",
    label: label || "处理中任务",
    active: active !== false,
  });
};

export const clearActiveProcessingTask = (taskId) => {
  if (!taskId) {
    return;
  }

  sendProcessingTaskState({
    taskId,
    active: false,
  });
};
