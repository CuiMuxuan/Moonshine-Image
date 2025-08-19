import { ref } from 'vue'
import { useQuasar } from 'quasar'
import { useConfigStore } from '../stores/config'

class VideoService {
  constructor() {
    this.$q = useQuasar()
    this.configStore = useConfigStore()
    this.ffmpegPath = null
    this.isProcessing = ref(false)
    this.currentProgress = ref(0)
  }

  // 初始化FFmpeg路径
  async initFFmpeg() {
    try {
      if (window.electron) {
        this.ffmpegPath = await window.electron.ipcRenderer.invoke('get-ffmpeg-path')
      }
      return this.ffmpegPath !== null
    } catch (error) {
      console.error('FFmpeg初始化失败:', error)
      return false
    }
  }

  // 解析视频信息
  async getVideoInfo(videoPath) {
    try {
      if (!this.ffmpegPath) {
        await this.initFFmpeg()
      }

      const videoInfo = await window.electron.ipcRenderer.invoke('get-video-info', videoPath)
      return {
        duration: videoInfo.duration,
        frameRate: videoInfo.frameRate,
        width: videoInfo.width,
        height: videoInfo.height,
        totalFrames: Math.ceil(videoInfo.duration * videoInfo.frameRate),
        hasAudio: videoInfo.hasAudio
      }
    } catch (error) {
      console.error('获取视频信息失败:', error)
      throw error
    }
  }

  // 提取视频帧
  async extractFrame(videoPath, timestamp) {
    try {
      const frameData = await window.electron.ipcRenderer.invoke('extract-video-frame', {
        videoPath,
        timestamp,
        format: this.configStore.getConfig('videoProcessing.frameExtractionFormat')
      })
      return frameData
    } catch (error) {
      console.error('提取视频帧失败:', error)
      throw error
    }
  }

  // 批量提取所有帧
  async extractAllFrames(videoPath, outputDir, progressCallback) {
    try {
      this.isProcessing.value = true
      const result = await window.electron.ipcRenderer.invoke('extract-all-frames', {
        videoPath,
        outputDir,
        format: this.configStore.getConfig('videoProcessing.frameExtractionFormat')
      })

      // 监听进度更新
      window.electron.ipcRenderer.on('frame-extraction-progress', (event, progress) => {
        this.currentProgress.value = progress
        if (progressCallback) progressCallback(progress)
      })

      return result
    } catch (error) {
      console.error('批量提取帧失败:', error)
      throw error
    } finally {
      this.isProcessing.value = false
    }
  }

  // 合成视频
  async composeVideo(framesDir, outputPath, videoInfo, progressCallback) {
    try {
      this.isProcessing.value = true
      const quality = this.configStore.getConfig('videoProcessing.videoQualityPresets.medium')

      const result = await window.electron.ipcRenderer.invoke('compose-video', {
        framesDir,
        outputPath,
        frameRate: videoInfo.frameRate,
        width: videoInfo.width,
        height: videoInfo.height,
        quality,
        preserveAudio: this.configStore.getConfig('videoProcessing.preserveOriginalAudio'),
        originalVideoPath: videoInfo.originalPath
      })

      // 监听进度更新
      window.electron.ipcRenderer.on('video-composition-progress', (event, progress) => {
        this.currentProgress.value = progress
        if (progressCallback) progressCallback(progress)
      })

      return result
    } catch (error) {
      console.error('合成视频失败:', error)
      throw error
    } finally {
      this.isProcessing.value = false
    }
  }

  // 清理临时文件
  async cleanupTempFiles(tempDir) {
    try {
      if (this.configStore.getConfig('videoProcessing.tempFileCleanup')) {
        await window.electron.ipcRenderer.invoke('cleanup-temp-files', tempDir)
      }
    } catch (error) {
      console.error('清理临时文件失败:', error)
    }
  }
}

export const videoService = new VideoService()
export default VideoService
