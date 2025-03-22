import { defineStore } from 'pinia'

export const useEditorStore = defineStore('editor', {
  state: () => ({
    // 图片相关状态
    imageUrl: '',
    imageHeight: 0,
    imageWidth: 0,
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    mode: 'view',
    createdUrls: [],

    // 裁剪器状态
    cropperState: {
      x: 0,
      y: 0,
      width: 0,
      height: 0
    },
  }),

  actions: {
    // 图片基础操作
    setImageUrl(url) {
      this.imageUrl = url
      // 记录创建的 URL
      if (url && !this.createdUrls.includes(url)) {
        this.createdUrls.push(url)
      }
    },
    // 清理所有创建的 URL
    cleanupUrls() {
      this.createdUrls.forEach(url => {
        URL.revokeObjectURL(url)
      })
      this.createdUrls = []
    },
    setImageSize(width, height) {
      this.imageWidth = width
      this.imageHeight = height
    },
    setOffset(x, y) {
      this.offsetX = x
      this.offsetY = y
    },
    setMode(mode) {
      this.mode = mode
    },

    // 缩放相关
    setScale(scale) {
      this.scale = Math.max(0.1, Math.min(5, scale)) // 限制缩放范围
    },
    zoomIn(relativeX, relativeY) {
      const oldScale = this.scale
      const newScale = Math.min(5, oldScale * 1.1)

      // 计算新的偏移量，保持鼠标位置不变
      this.offsetX -= (relativeX * (newScale - oldScale))
      this.offsetY -= (relativeY * (newScale - oldScale))
      this.scale = newScale
    },

    zoomOut(relativeX, relativeY) {
      const oldScale = this.scale
      const newScale = Math.max(0.1, oldScale / 1.1)

      // 计算新的偏移量，保持鼠标位置不变
      this.offsetX -= (relativeX * (newScale - oldScale))
      this.offsetY -= (relativeY * (newScale - oldScale))
      this.scale = newScale
    },

    updateZoom(newScale, mouseX, mouseY) {
      const scaleDiff = newScale - this.scale
      this.offsetX -= mouseX * scaleDiff
      this.offsetY -= mouseY * scaleDiff
      this.scale = newScale
    },

    // 裁剪器操作
    setCropperX(x) {
      this.cropperState.x = x
    },
    setCropperY(y) {
      this.cropperState.y = y
    },
    setCropperWidth(width) {
      this.cropperState.width = width
    },
    setCropperHeight(height) {
      this.cropperState.height = height
    },
    cropImage() {
      // TODO: 实现裁剪逻辑
      console.log('Cropping image...')
    },

    // 视图重置
    resetView() {
      this.scale = 1
      this.offsetX = 0
      this.offsetY = 0
    },
    resetState() {
      this.mode = 'view'
      this.resetView()
    },

    // 工具函数
    isSD() {
      return true // 根据实际需求修改
    }
  }
})
