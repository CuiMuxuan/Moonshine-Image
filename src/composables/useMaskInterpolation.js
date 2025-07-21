export function useMaskInterpolation() {
  /**
   * 根据时间获取当前蒙版数据
   * @param {Object} mask - 蒙版对象
   * @param {number} time - 当前时间
   * @returns {Object|null} 当前时间的蒙版数据
   */
  function getCurrentMaskData(mask, time) {
    if (!mask || !mask.keyframes || mask.keyframes.length === 0) {
      return null
    }

    // 过滤并排序关键帧
    const keyframes = mask.keyframes
      .filter(kf => kf.time <= time)
      .sort((a, b) => a.time - b.time)

    if (keyframes.length === 0) {
      // 如果没有在当前时间之前的关键帧，返回第一个关键帧
      const firstKeyframe = mask.keyframes.sort((a, b) => a.time - b.time)[0]
      return firstKeyframe ? firstKeyframe.maskData : null
    }

    const currentKeyframe = keyframes[keyframes.length - 1]
    const nextKeyframe = mask.keyframes
      .filter(kf => kf.time > time)
      .sort((a, b) => a.time - b.time)[0]

    // 如果没有下一个关键帧，直接返回当前关键帧数据
    if (!nextKeyframe) {
      return currentKeyframe.maskData
    }

    // 计算插值进度
    const progress = (time - currentKeyframe.time) / (nextKeyframe.time - currentKeyframe.time)
    return interpolateMaskData(currentKeyframe.maskData, nextKeyframe.maskData, progress)
  }

  /**
   * 在两个蒙版数据之间进行插值
   * @param {Object} maskData1 - 起始蒙版数据
   * @param {Object} maskData2 - 结束蒙版数据
   * @param {number} progress - 插值进度 (0-1)
   * @returns {Object} 插值后的蒙版数据
   */
  function interpolateMaskData(maskData1, maskData2, progress) {
    if (!maskData1 || !maskData2) {
      return maskData1 || maskData2
    }

    // 如果类型不同，返回起始数据
    if (maskData1.type !== maskData2.type) {
      return maskData1
    }

    const clampedProgress = Math.max(0, Math.min(1, progress))

    switch (maskData1.type) {
      case 'polygon':
        return interpolatePolygon(maskData1, maskData2, clampedProgress)
      case 'rectangle':
        return interpolateRectangle(maskData1, maskData2, clampedProgress)
      case 'circle':
        return interpolateCircle(maskData1, maskData2, clampedProgress)
      case 'ellipse':
        return interpolateEllipse(maskData1, maskData2, clampedProgress)
      default:
        return maskData1
    }
  }

  /**
   * 多边形插值
   */
  function interpolatePolygon(maskData1, maskData2, progress) {
    if (!maskData1.points || !maskData2.points) {
      return maskData1
    }

    const minLength = Math.min(maskData1.points.length, maskData2.points.length)
    const interpolatedPoints = []

    for (let i = 0; i < minLength; i++) {
      const point1 = maskData1.points[i]
      const point2 = maskData2.points[i]

      interpolatedPoints.push({
        x: point1.x + (point2.x - point1.x) * progress,
        y: point1.y + (point2.y - point1.y) * progress
      })
    }

    return {
      ...maskData1,
      points: interpolatedPoints
    }
  }

  /**
   * 矩形插值
   */
  function interpolateRectangle(maskData1, maskData2, progress) {
    if (!maskData1.rect || !maskData2.rect) {
      return maskData1
    }

    const rect1 = maskData1.rect
    const rect2 = maskData2.rect

    return {
      ...maskData1,
      rect: {
        x: rect1.x + (rect2.x - rect1.x) * progress,
        y: rect1.y + (rect2.y - rect1.y) * progress,
        width: rect1.width + (rect2.width - rect1.width) * progress,
        height: rect1.height + (rect2.height - rect1.height) * progress
      }
    }
  }

  /**
   * 圆形插值
   */
  function interpolateCircle(maskData1, maskData2, progress) {
    if (!maskData1.circle || !maskData2.circle) {
      return maskData1
    }

    const circle1 = maskData1.circle
    const circle2 = maskData2.circle

    return {
      ...maskData1,
      circle: {
        x: circle1.x + (circle2.x - circle1.x) * progress,
        y: circle1.y + (circle2.y - circle1.y) * progress,
        radius: circle1.radius + (circle2.radius - circle1.radius) * progress
      }
    }
  }

  /**
   * 椭圆插值
   */
  function interpolateEllipse(maskData1, maskData2, progress) {
    if (!maskData1.ellipse || !maskData2.ellipse) {
      return maskData1
    }

    const ellipse1 = maskData1.ellipse
    const ellipse2 = maskData2.ellipse

    return {
      ...maskData1,
      ellipse: {
        x: ellipse1.x + (ellipse2.x - ellipse1.x) * progress,
        y: ellipse1.y + (ellipse2.y - ellipse1.y) * progress,
        radiusX: ellipse1.radiusX + (ellipse2.radiusX - ellipse1.radiusX) * progress,
        radiusY: ellipse1.radiusY + (ellipse2.radiusY - ellipse1.radiusY) * progress,
        rotation: ellipse1.rotation + (ellipse2.rotation - ellipse1.rotation) * progress
      }
    }
  }

  /**
   * 获取蒙版在指定时间范围内的所有关键帧
   * @param {Object} mask - 蒙版对象
   * @param {number} startTime - 开始时间
   * @param {number} endTime - 结束时间
   * @returns {Array} 关键帧数组
   */
  function getKeyframesInRange(mask, startTime, endTime) {
    if (!mask || !mask.keyframes) {
      return []
    }

    return mask.keyframes
      .filter(kf => kf.time >= startTime && kf.time <= endTime)
      .sort((a, b) => a.time - b.time)
  }

  /**
   * 检查蒙版在指定时间是否可见
   * @param {Object} mask - 蒙版对象
   * @param {number} time - 时间
   * @returns {boolean} 是否可见
   */
  function isMaskVisibleAtTime(mask, time) {
    if (!mask) return false

    const startTime = mask.startTime || 0
    const endTime = mask.endTime || Infinity

    return time >= startTime && time <= endTime
  }

  /**
   * 获取蒙版的边界框
   * @param {Object} maskData - 蒙版数据
   * @returns {Object|null} 边界框 {x, y, width, height}
   */
  function getMaskBounds(maskData) {
    if (!maskData) return null

    switch (maskData.type) {
      case 'polygon': {
        if (!maskData.points || maskData.points.length === 0) return null

        const xs = maskData.points.map(p => p.x)
        const ys = maskData.points.map(p => p.y)
        const minX = Math.min(...xs)
        const maxX = Math.max(...xs)
        const minY = Math.min(...ys)
        const maxY = Math.max(...ys)

        return {
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY
        }
      }

      case 'rectangle':
        return maskData.rect ? { ...maskData.rect } : null

      case 'circle': {
        if (!maskData.circle) return null
        const { x, y, radius } = maskData.circle
        return {
          x: x - radius,
          y: y - radius,
          width: radius * 2,
          height: radius * 2
        }
      }

      case 'ellipse': {
        if (!maskData.ellipse) return null
        const { x: ex, y: ey, radiusX, radiusY } = maskData.ellipse
        return {
          x: ex - radiusX,
          y: ey - radiusY,
          width: radiusX * 2,
          height: radiusY * 2
        }
      }

      default:
        return null
    }
  }

  /**
   * 计算两个蒙版数据之间的差异
   * @param {Object} maskData1 - 第一个蒙版数据
   * @param {Object} maskData2 - 第二个蒙版数据
   * @returns {number} 差异值 (0-1)
   */
  function calculateMaskDifference(maskData1, maskData2) {
    if (!maskData1 || !maskData2) return 1
    if (maskData1.type !== maskData2.type) return 1

    switch (maskData1.type) {
      case 'polygon': {
        if (!maskData1.points || !maskData2.points) return 1
        if (maskData1.points.length !== maskData2.points.length) return 1

        let totalDiff = 0
        for (let i = 0; i < maskData1.points.length; i++) {
          const p1 = maskData1.points[i]
          const p2 = maskData2.points[i]
          const diff = Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2)
          totalDiff += diff
        }
        return Math.min(1, totalDiff / maskData1.points.length)
      }

      case 'rectangle': {
        if (!maskData1.rect || !maskData2.rect) return 1
        const r1 = maskData1.rect
        const r2 = maskData2.rect
        const posDiff = Math.sqrt((r1.x - r2.x) ** 2 + (r1.y - r2.y) ** 2)
        const sizeDiff = Math.abs(r1.width - r2.width) + Math.abs(r1.height - r2.height)
        return Math.min(1, (posDiff + sizeDiff) / 4)
      }

      default:
        return 0
    }
  }

  return {
    getCurrentMaskData,
    interpolateMaskData,
    getKeyframesInRange,
    isMaskVisibleAtTime,
    getMaskBounds,
    calculateMaskDifference,
    // 内部插值函数也可以暴露出来供高级用户使用
    interpolatePolygon,
    interpolateRectangle,
    interpolateCircle,
    interpolateEllipse
  }
}
