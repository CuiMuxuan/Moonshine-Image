import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useConfigStore } from './config'

export const useVideoMaskStore = defineStore('videoMask', () => {
  const configStore = useConfigStore()

  // 视频蒙版数据
  const videoMasks = ref(new Map()) // videoFileName -> { keyframes, metadata }
  const draftSaves = ref(new Map()) // videoFileName -> draftData

  // 保存关键帧蒙版
  const saveKeyframeMask = async (videoFileName, frame, maskData) => {
  try {
    if (!videoFileName || frame < 0 || !maskData) {
      throw new Error('无效的参数')
    }

    let videoData = videoMasks.value.get(videoFileName)
    if (!videoData) {
      videoData = {
        keyframes: [],
        metadata: {
          created: Date.now(),
          modified: Date.now(),
          totalFrames: 0
        }
      }
      videoMasks.value.set(videoFileName, videoData)
    }

    // 检查是否已存在该帧的关键帧
    const existingIndex = videoData.keyframes.findIndex(kf => kf.frame === frame)
    const keyframeData = {
      id: existingIndex >= 0 ? videoData.keyframes[existingIndex].id : Date.now().toString(),
      frame,
      maskData,
      timestamp: Date.now()
    }

    if (existingIndex >= 0) {
      videoData.keyframes[existingIndex] = keyframeData
    } else {
      videoData.keyframes.push(keyframeData)
    }

    videoData.metadata.modified = Date.now()
    await autoSave(videoFileName)

    return { success: true, keyframe: keyframeData }
  } catch (error) {
    console.error('保存关键帧蒙版失败:', error)
    throw error
  }
}

  // 获取视频蒙版数据
  const getVideoMasks = (videoFileName) => {
    return videoMasks.value.get(videoFileName) || {
      keyframes: [],
      metadata: { created: Date.now(), modified: Date.now(), version: '1.0' }
    }
  }

  // 删除关键帧
  const deleteKeyframe = async (videoFileName, keyframeId) => {
  try {
    const videoData = videoMasks.value.get(videoFileName)
    if (!videoData) {
      throw new Error('视频数据不存在')
    }

    const index = videoData.keyframes.findIndex(kf => kf.id === keyframeId)
    if (index === -1) {
      throw new Error('关键帧不存在')
    }

    videoData.keyframes.splice(index, 1)
    videoData.metadata.modified = Date.now()
    await autoSave(videoFileName)

    return { success: true }
  } catch (error) {
    console.error('删除关键帧失败:', error)
    throw error
  }
}

  // 自动保存草稿
  const autoSave = async (videoFileName) => {
  try {
    const videoData = videoMasks.value.get(videoFileName)
    if (!videoData) return

    const draftData = {
      keyframes: [...videoData.keyframes],
      metadata: { ...videoData.metadata },
      autoSaveTime: Date.now()
    }

    draftSaves.value.set(videoFileName, draftData)

    if (window.electron?.saveVideoMaskDraft) {
      await window.electron.saveVideoMaskDraft(videoFileName, draftData)
    }
  } catch (error) {
    console.error('自动保存失败:', error)
  }
}

  // 加载草稿
  const loadDraft = async (videoFileName) => {
    try {
      if (window.electron?.loadVideoMaskDraft) {
        const draftData = await window.electron.loadVideoMaskDraft(videoFileName)
        if (draftData) {
          draftSaves.value.set(videoFileName, draftData)
          return draftData
        }
      }
      return null
    } catch (error) {
      console.error('加载草稿失败:', error)
      return null
    }
  }

  // 恢复草稿
  const restoreDraft = (videoFileName) => {
    const draftData = draftSaves.value.get(videoFileName)
    if (draftData) {
      videoMasks.value.set(videoFileName, {
        keyframes: [...draftData.keyframes],
        metadata: { ...draftData.metadata }
      })
      return true
    }
    return false
  }

  // 清理过期草稿
  const cleanupExpiredDrafts = async () => {
    try {
      const retentionDays = configStore.getConfig('video.maxDraftRetention') || 7
      const expireTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000)

      for (const [fileName, draftData] of draftSaves.value.entries()) {
        if (draftData.autoSaveTime < expireTime) {
          draftSaves.value.delete(fileName)
          if (window.electron?.deleteVideoMaskDraft) {
            await window.electron.deleteVideoMaskDraft(fileName)
          }
        }
      }
    } catch (error) {
      console.error('清理过期草稿失败:', error)
    }
  }

  // 处理蒙版冲突
  const resolveMaskConflict = async (videoFileName, frame, conflictResolution) => {
  try {
    const videoData = videoMasks.value.get(videoFileName)
    if (!videoData) return { success: false, error: '视频数据不存在' }

    const frameKeyframes = videoData.keyframes.filter(kf => kf.frame === frame)
    if (frameKeyframes.length <= 1) return { success: true }

    switch (conflictResolution) {
      case 'merge': {
        // 合并多个蒙版
        const mergedMask = await mergeMasks(frameKeyframes.map(kf => kf.maskData))
        // 保留第一个关键帧，更新蒙版数据
        frameKeyframes[0].maskData = mergedMask
        // 删除其他关键帧
        for (let i = 1; i < frameKeyframes.length; i++) {
          const index = videoData.keyframes.findIndex(kf => kf.id === frameKeyframes[i].id)
          if (index !== -1) {
            videoData.keyframes.splice(index, 1)
          }
        }
        break
      }

      case 'useOld': {
        // 使用旧蒙版，删除新蒙版
        const oldestKeyframe = frameKeyframes.reduce((oldest, current) =>
          current.timestamp < oldest.timestamp ? current : oldest
        )
        for (const kf of frameKeyframes) {
          if (kf.id !== oldestKeyframe.id) {
            const index = videoData.keyframes.findIndex(k => k.id === kf.id)
            if (index !== -1) {
              videoData.keyframes.splice(index, 1)
            }
          }
        }
        break
      }

      case 'useNew': {
        // 使用新蒙版，删除旧蒙版
        const newestKeyframe = frameKeyframes.reduce((newest, current) =>
          current.timestamp > newest.timestamp ? current : newest
        )
        for (const kf of frameKeyframes) {
          if (kf.id !== newestKeyframe.id) {
            const index = videoData.keyframes.findIndex(k => k.id === kf.id)
            if (index !== -1) {
              videoData.keyframes.splice(index, 1)
            }
          }
        }
        break
      }
    }

    videoData.metadata.modified = Date.now()
    await autoSave(videoFileName)

    return { success: true }
  } catch (error) {
    console.error('解决蒙版冲突失败:', error)
    throw error
  }
}

  // 合并蒙版
  const mergeMasks = async (maskDataArray) => {
    // 实现蒙版合并逻辑
    // 这里需要根据具体的蒙版数据格式来实现
    return maskDataArray[0] // 简化实现
  }

  // 生成最终处理用的蒙版序列
  const generateProcessingMasks = (videoFileName) => {
    const videoData = videoMasks.value.get(videoFileName)
    if (!videoData || !videoData.keyframes.length) {
      return []
    }

    const sortedKeyframes = [...videoData.keyframes].sort((a, b) => a.frame - b.frame)
    const processingMasks = []

    // 为每一帧生成蒙版数据
    for (let frame = 0; frame < videoData.metadata.totalFrames; frame++) {
      const keyframe = sortedKeyframes.find(kf => kf.frame === frame)
      if (keyframe) {
        // 直接使用关键帧蒙版
        processingMasks.push({
          frame,
          maskData: keyframe.maskData
        })
      } else {
        // 插值计算中间帧蒙版
        const interpolatedMask = interpolateFrameMask(frame, sortedKeyframes)
        if (interpolatedMask) {
          processingMasks.push({
            frame,
            maskData: interpolatedMask
          })
        }
      }
    }

    return processingMasks
  }

  // 插值计算帧蒙版
  const interpolateFrameMask = (frame, sortedKeyframes) => {
    for (let i = 0; i < sortedKeyframes.length - 1; i++) {
      const current = sortedKeyframes[i]
      const next = sortedKeyframes[i + 1]

      if (frame > current.frame && frame < next.frame) {
        const ratio = (frame - current.frame) / (next.frame - current.frame)
        return interpolateMaskData(current.maskData, next.maskData, ratio)
      }
    }
    return null
  }

  // 蒙版数据插值
  const interpolateMaskData = (mask1, mask2, ratio) => {
  if (!mask1 || !mask2 || ratio < 0 || ratio > 1) {
    return mask1
  }

  try {
    // 简化的插值实现，实际应用中需要更复杂的算法
    if (typeof mask1 === 'string' && typeof mask2 === 'string') {
      // 对于base64图像数据，可以考虑透明度插值
      return ratio < 0.5 ? mask1 : mask2
    }

    // 对于其他类型的蒙版数据，实现相应的插值逻辑
    return mask1
  } catch (error) {
    console.error('蒙版插值失败:', error)
    return mask1
  }
}

  // 清理视频蒙版数据
  const clearVideoMasks = (videoFileName) => {
    videoMasks.value.delete(videoFileName)
    draftSaves.value.delete(videoFileName)
  }

  return {
    // 状态
    videoMasks,
    draftSaves,

    // 方法
    saveKeyframeMask,
    getVideoMasks,
    deleteKeyframe,
    autoSave,
    loadDraft,
    restoreDraft,
    cleanupExpiredDrafts,
    resolveMaskConflict,
    generateProcessingMasks,
    clearVideoMasks
  }
})
