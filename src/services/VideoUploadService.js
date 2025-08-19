import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

/**
 * 视频上传和处理服务
 */
class VideoUploadService {
  constructor() {
    this.ffmpeg = null;
    this.isLoaded = false;
  }

  /**
   * 初始化FFmpeg
   */
  async initFFmpeg() {
    if (this.isLoaded) return;

    try {
      this.ffmpeg = new FFmpeg();

      // 使用本地安装的ffmpeg依赖，通过toBlobURL加载
      const baseURL = "/node_modules/@ffmpeg/core/dist/esm";
      await this.ffmpeg.load({
        coreURL: await toBlobURL(
          `${baseURL}/ffmpeg-core.js`,
          "text/javascript"
        ),
        wasmURL: await toBlobURL(
          `${baseURL}/ffmpeg-core.wasm`,
          "application/wasm"
        ),
      });

      this.isLoaded = true;
      console.log("FFmpeg初始化成功");
    } catch (error) {
      console.error("FFmpeg初始化失败:", error);
      this.isLoaded = false;
      // 不抛出错误，让后续代码使用HTML5 API作为备选方案
    }
  }

  /**
   * 验证文件类型
   */
  validateFileType(file) {
    const supportedTypes = [
      "video/mp4",
      "video/avi",
      "video/mov",
      "video/wmv",
      "video/flv",
      "video/webm",
      "video/mkv",
    ];

    const isValid = supportedTypes.includes(file.type);
    console.log("文件类型验证:", file.type, "是否支持:", isValid);
    return isValid;
  }

  /**
   * 获取视频元数据 - 使用FFmpeg获取准确信息
   */
  async getVideoMetadata(file) {
    console.log("开始获取视频元数据:", file.name);

    // 尝试初始化FFmpeg
    console.log("尝试初始化FFmpeg...");
    await this.initFFmpeg();

    // 如果FFmpeg初始化失败，直接使用HTML5 API
    if (!this.isLoaded) {
      console.log("FFmpeg初始化失败，使用HTML5 API作为备选方案");
      return this.getVideoMetadataWithHTML5(file);
    }

    console.log("FFmpeg初始化成功，使用FFmpeg获取元数据");

    try {
      // 将文件写入FFmpeg虚拟文件系统
      const inputFileName = `input_${Date.now()}.${file.name.split(".").pop()}`;
      const fileData = new Uint8Array(await file.arrayBuffer());
      await this.ffmpeg.writeFile(inputFileName, fileData);

      // 使用ffprobe获取视频信息，输出到文件
      await this.ffmpeg.exec([
        "-f",
        "ffprobe",
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        "-i",
        inputFileName,
        "metadata.json"
      ]);

      // 读取元数据文件
      const metadataData = await this.ffmpeg.readFile("metadata.json");
      const metadataText = new TextDecoder().decode(metadataData);
      const metadata = JSON.parse(metadataText);

      // 查找视频流
      const videoStream = metadata.streams.find(
        (stream) => stream.codec_type === "video"
      );

      if (!videoStream) {
        throw new Error("未找到视频流");
      }

      // 解析帧率
      let fps = 30; // 默认值
      if (videoStream.r_frame_rate) {
        const [num, den] = videoStream.r_frame_rate.split("/").map(Number);
        if (den && den !== 0) {
          fps = Math.round((num / den) * 100) / 100; // 保留两位小数
        }
      } else if (videoStream.avg_frame_rate) {
        const [num, den] = videoStream.avg_frame_rate.split("/").map(Number);
        if (den && den !== 0) {
          fps = Math.round((num / den) * 100) / 100;
        }
      }

      // 验证duration是否有效
      const duration = parseFloat(metadata.format.duration);
      if (isNaN(duration) || duration <= 0) {
        console.warn(`FFmpeg获取的视频时长无效: ${duration}, 文件: ${file.name}`);
        throw new Error(`无法获取有效的视频时长: ${duration}`);
      }

      const result = {
        duration: duration,
        width: parseInt(videoStream.width) || 1920,
        height: parseInt(videoStream.height) || 1080,
        fps: fps,
        format: file.name.split(".").pop().toLowerCase(),
        bitrate: parseInt(metadata.format.bit_rate) || 0,
        codec: videoStream.codec_name || "unknown",
      };

      console.log(`FFmpeg成功获取视频元数据: ${file.name}, 时长: ${duration}s`);

      // 清理临时文件
      try {
        await this.ffmpeg.deleteFile(inputFileName);
        await this.ffmpeg.deleteFile("metadata.json");
      } catch (cleanupError) {
        console.warn("清理临时文件失败:", cleanupError);
      }

      return result;
    } catch (error) {
      console.warn("FFmpeg获取元数据失败，回退到HTML5 API:", error);
      return this.getVideoMetadataWithHTML5(file);
    }
  }

  /**
   * 使用HTML5 API获取视频元数据
   */
  async getVideoMetadataWithHTML5(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      const url = URL.createObjectURL(file);

      video.onloadedmetadata = () => {
        // 验证duration是否有效
        const duration = video.duration;
        if (isNaN(duration) || duration <= 0) {
          console.warn(`视频时长无效: ${duration}, 文件: ${file.name}`);
          URL.revokeObjectURL(url);
          reject(new Error(`无法获取有效的视频时长: ${duration}`));
          return;
        }

        const metadata = {
          duration: duration,
          width: video.videoWidth || 1920,
          height: video.videoHeight || 1080,
          fps: 30, // HTML5 API无法准确获取FPS，使用默认值
          format: file.name.split(".").pop().toLowerCase(),
          bitrate: 0, // HTML5 API无法获取比特率
          codec: "unknown", // HTML5 API无法获取编解码器信息
        };

        console.log(`成功获取视频元数据: ${file.name}, 时长: ${duration}s`);
        URL.revokeObjectURL(url);
        resolve(metadata);
      };

      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("无法读取视频元数据"));
      };

      video.src = url;
    });
  }

  /**
   * 生成视频缩略图
   */
  async generateThumbnail(file, time = 1) {
    console.log("开始生成视频缩略图:", file.name);

    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      const url = URL.createObjectURL(file);

      console.log("创建视频元素和canvas，URL:", url);

      video.onloadedmetadata = () => {
        // 设置canvas尺寸
        canvas.width = 160;
        canvas.height = 90;

        // 跳转到指定时间
        video.currentTime = Math.min(time, video.duration - 0.1);
      };

      video.onseeked = () => {
        // 绘制视频帧到canvas
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // 转换为blob URL
        canvas.toBlob(
          (blob) => {
            const thumbnailUrl = URL.createObjectURL(blob);
            URL.revokeObjectURL(url);
            resolve(thumbnailUrl);
          },
          "image/jpeg",
          0.8
        );
      };

      video.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("无法生成视频缩略图"));
      };

      video.src = url;
    });
  }

  /**
   * 创建轨道项数据
   */
  createTrackItem(file, metadata, thumbnailUrl) {
    const id = `video_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const frameCount = Math.floor(metadata.duration * metadata.fps);

    // 调试信息：检查帧数计算
    console.log('创建轨道项调试信息:', {
      fileName: file.name,
      duration: metadata.duration,
      fps: metadata.fps,
      frameCount: frameCount,
      calculatedDuration: frameCount / metadata.fps
    });

    return {
      id,
      type: "video",
      name: file.name,
      source: URL.createObjectURL(file),
      format: metadata.format,
      width: metadata.width,
      height: metadata.height,
      fps: metadata.fps,
      time: metadata.duration,
      frameCount,
      start: 0,
      end: frameCount,
      startFrame: 0, // 添加startFrame属性
      endFrame: frameCount, // 添加endFrame属性
      offsetL: 0,
      offsetR: 0,
      cover: thumbnailUrl,
      file: file, // 保存原始文件引用，用于重复检测
      transform: {
        offsetX: 0,
        offsetY: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
      },
    };
  }

  /**
   * 处理视频文件上传
   */
  async processVideoFile(file) {
    // 验证文件类型
    if (!this.validateFileType(file)) {
      throw new Error("不支持的视频格式");
    }

    // 获取元数据
    const metadata = await this.getVideoMetadata(file);

    // 生成缩略图
    const thumbnailUrl = await this.generateThumbnail(file);

    // 创建轨道项
    const trackItem = this.createTrackItem(file, metadata, thumbnailUrl);

    return trackItem;
  }
}

// 单例实例
export const videoUploadService = new VideoUploadService();
