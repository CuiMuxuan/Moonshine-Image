/**
 * Canvas工具函数 - JavaScript版本
 * 基于clip项目的canvasUtil.ts改写
 */

// 格式化时间显示
export function formatTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    str: `${minutes.toString().padStart(2, "0")}:${seconds
      .toString()
      .padStart(2, "0")}`,
  };
}

// 标尺中每小格代表的宽度(根据scale的不同实时变化)
const getGridSize = (scale) => {
  const scaleMap = new Map([
    // 切换比例：最小单位为帧
    [100, 100],
    [90, 50],
    [80, 20],
    [70, 10],
    // 切换比例：最小单位为秒
    [60, 80],
    [50, 40],
    [40, 20],
    [30, 10],
    // 切换比例：最小单位为6秒 一大格为 1分钟
    [20, 40],
    [10, 25],
    [0, 10],
  ]);
  return scaleMap.get(scale) || 100;
};

// 获取当前scale下的单元格像素
export const getGridPixel = (scale, frameCount) => {
  let gridPixel = getGridSize(scale);
  let trackWidth = gridPixel * frameCount;
  if (scale < 70) {
    // 1秒一格
    trackWidth = trackWidth / 30;
  }
  if (scale < 30) {
    // 6秒一格
    trackWidth = trackWidth / 6;
  }
  return trackWidth;
};

// 根据缩放比调整 step
const getStep = (scale, frameStep) => {
  return scale > 60 ? frameStep : 10;
};

// 转换时间格式
export const getLongText = (count, scale) => {
  let time = count; // 一个大单元格为 1 秒
  if (scale < 30) {
    // 一个单元格为 1 分钟
    time *= 60;
  } else if (scale < 70) {
    // 一个大单元格为 10 秒
    time *= 10;
  }
  return formatTime(time * 1000).str;
};

const getShortText = (count, step, scale) => {
  const index = count % step;
  let text = "";
  if (scale < 70) {
    // 一个单元格为 1 秒钟
    return "";
  } else {
    // 一个单元格为 1 帧
    text =
      scale > 80
        ? index === 0
          ? ""
          : `${index < 10 ? "0" : ""}${index}f`
        : "";
  }
  return text;
};

const lineWidth = 0.5; // 线条宽度

// 获取选中点的帧坐标
export const getSelectFrame = (offsetX, scale, frameStep) => {
  const size = getGridSize(scale);
  if (scale < 70) {
    // 一个单元格为 1 秒
    offsetX *= frameStep;
  }
  if (scale < 30) {
    // 一个单元格为 6 秒
    offsetX *= 6;
  }
  return Math.floor(offsetX / size) + (scale < 70 ? 0 : 1);
};

/**
 * 时间轴画线
 */
export const drawTimeLine = (context, userConfigs, canvasConfigs) => {
  const { start, scale, step: frameStep, focusPosition } = userConfigs;
  const {
    ratio,
    bgColor,
    width,
    height,
    textColor,
    subTextColor,
    textSize,
    textScale,
    focusColor,
    longColor,
    shortColor,
  } = canvasConfigs;
  const step = getStep(scale, frameStep);

  // 初始化画布
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);

  // 1. 时间轴底色
  context.fillStyle = bgColor;
  context.fillRect(0, 0, width, height);

  // 2. 计算网格
  const gridSizeS = getGridSize(scale); // 匹配当前缩放下每小格的宽度
  const gridSizeB = gridSizeS * step; // 根据步进计算每大格的宽度

  const startValueS = Math.floor(start / gridSizeS) * gridSizeS; // 小格绘制起点的刻度
  const startValueB = Math.floor(start / gridSizeB) * gridSizeB; // 大格绘制起点的刻度

  const offsetXS = startValueS - start; // 小格起点刻度距离原点的px距离
  const offsetXB = startValueB - start; // 大格起点刻度距离原点的px距离
  // 修改终点刻度计算，绘制整个画布宽度而不仅仅是可视区域
  const endValue = Math.ceil(width / ratio); // 终点刻度覆盖整个画布宽度

  // 3. 时间轴聚焦元素
  if (focusPosition) {
    let fStart = focusPosition.start;
    let fCount = focusPosition.end - focusPosition.start;
    if (scale < 70) {
      // 一个单元格为 1 秒
      fStart = fStart / 30;
      fCount = fCount / 30;
    }
    if (scale < 30) {
      // 一个单元格为 6 秒
      fStart = fStart / 6;
      fCount = fCount / 6;
    }
    const focusS = fStart * gridSizeS + lineWidth - start; // 选中起点坐标
    const focusW = fCount * gridSizeS - lineWidth; // 选中宽度
    if (focusW > gridSizeS) {
      // 小于一个小格的元素就不提示了
      context.fillStyle = focusColor;
      context.fillRect(focusS, 0, focusW, (height * 3) / 8);
    }
  }

  // 4. 初始化刻度和文字画笔
  context.beginPath();
  context.fillStyle = textColor;
  context.strokeStyle = longColor;

  // 5. 长间隔和文字
  for (
    let value = startValueB, count = 0;
    value < endValue;
    value += gridSizeB, count++
  ) {
    const x = offsetXB + count * gridSizeB + lineWidth;
    context.moveTo(x, 0);
    context.save();
    context.translate(x, height * 0.4);
    context.scale(textScale / ratio, textScale / ratio);
    const text = getLongText(value / gridSizeB, scale);
    const textPositionX = text.length * 5 * textScale * ratio;
    const textPositionY = ((textSize / ratio) * textScale) / ratio / 2;
    context.fillText(text, textPositionX, textPositionY);
    context.restore();
    context.lineTo(x, (height * 10) / 16 / ratio);
  }
  context.stroke();
  context.closePath();

  // 6. 短间隔和文字
  context.beginPath();
  context.fillStyle = subTextColor;
  context.strokeStyle = shortColor;
  for (
    let value = startValueS, count = 0;
    value < endValue;
    value += gridSizeS, count++
  ) {
    const x = offsetXS + count * gridSizeS + lineWidth;
    context.moveTo(x, 0);
    const text = getShortText(value / gridSizeS, step, scale);
    if (text) {
      context.save();
      context.translate(x, height * 0.4);
      context.scale(textScale / ratio, textScale / ratio);
      const textPositionX = text.length * 5 * textScale * ratio;
      const textPositionY = ((textSize / ratio) * textScale) / ratio / 2;
      context.fillText(text, textPositionX, textPositionY);
      context.restore();
    }
    if (value % gridSizeB !== 0) {
      context.lineTo(x, height / 3 / ratio);
    }
  }
  context.stroke();
  context.closePath();

  // 恢复ctx matrix
  context.setTransform(1, 0, 0, 1, 0, 0);
};
